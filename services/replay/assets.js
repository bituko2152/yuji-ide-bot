const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const crypto = require('crypto');
const SteamCrypto = require('@doctormckay/steam-crypto');
const AdmZip = require('adm-zip');
const { ZSTDDecoder } = require('zstddec');
const { requireWithFallback } = require('steam-user/components/helpers.js');
const LZMA = requireWithFallback('lzma-native', 'lzma');
const { getSteamUser, withSteam } = require('../steam/steamLeaderboards');
const { extractSprites } = require('./gamemaker');

/*
 * Track and car images for the replay, downloaded from Steam with the bot's
 * own session (the same one /record uses) and cached in data/replay-cache.
 *
 *   Track (Workshop id)    -> Workshop item files: track.png, minimap.png
 *   Track (official name)  -> game depot: assets/tracks/<name>/track.png, minimap.png, track_info.data
 *   Track "original/<name>" -> game depot: assets/tracks_original/<name>/<name>_left.png + _right.png
 *                             (joined side by side), <name>_minimap.png: the old "Road Course FA" tracks,
 *                             which share names with tracks/ (original/italy = Monza, italy = Circus Maximus)
 *   Class (Workshop id)    -> Workshop item files: car_1.png ... car_10.png
 *   Class (official name)  -> game depot: assets/cars/<name>/car_1.png ... (if the class has a folder)
 * Classes built into the game itself (e.g. "formulaa") have no files: their
 * liveries are read from the game's data file (game.unx, see gamemaker.js).
 *
 * track.png is the world at 1:1 (e.g. 6144 x 5120). The original is cached;
 * render.js embeds a reduced copy.
 */

const APP_ID = 1285230;
const LINUX_DEPOT = 1285231;          // smallest depot with the game's assets/ folder
const CACHE = path.join(__dirname, '../../data/replay-cache');
const MANUAL = path.join(__dirname, '../../data/replay-manual');

async function workshopDetails(id) {
    const res = await fetch('https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/', {
        method: 'POST',
        body: new URLSearchParams({ itemcount: '1', 'publishedfileids[0]': String(id) })
    }).then(r => r.json());
    const d = res?.response?.publishedfiledetails?.[0];
    if (!d || d.result !== 1) throw new Error(`Workshop item ${id} not found`);
    return d;
}

let depotManifest = null; // the game's file list, fetched once per run
async function gameFiles(user) {
    if (depotManifest) return depotManifest;
    const info = await withSteam(u => u.getProductInfo([APP_ID], [], true));
    const m = info.apps[APP_ID].appinfo.depots[LINUX_DEPOT].manifests.public;
    const gid = m.gid || m;
    depotManifest = (await withSteam(u => u.getManifest(APP_ID, LINUX_DEPOT, gid, 'public'))).manifest;
    return depotManifest;
}

/** Files of a Workshop item or a game folder: { name -> download() }. */
async function listFiles(key) {
    // Files put by hand on the server win over Steam:
    // data/replay-manual/<workshop id or official name>/track.png, minimap.png, car_1.png ...
    const manual = path.join(MANUAL, key.replace(/^(tracks|cars)\//, '').replace(/[^\w-]/g, '_'));
    if (fs.existsSync(manual)) {
        const out = {};
        for (const name of fs.readdirSync(manual)) out[name] = async () => fs.readFileSync(path.join(manual, name));
        console.log(`🎬 [Replay] Using hand-added files for "${key}".`);
        return { title: null, files: out };
    }
    const user = await getSteamUser();
    let depot, files;
    if (/^\d+$/.test(key)) {
        const d = await workshopDetails(key);
        files = (await withSteam(u => u.getManifest(APP_ID, APP_ID, d.hcontent_file, 'public'))).manifest.files;
        depot = APP_ID;
        files = files.map(f => ({ f, name: path.basename(f.filename.replace(/\\/g, '/')) }));
        return { title: d.title, files: wrap(files) };
    }
    const all = (await gameFiles(user)).files;
    depot = LINUX_DEPOT;
    files = all.map(f => ({ f, rel: f.filename.replace(/\\/g, '/') }))
        .filter(x => x.rel.startsWith(`assets/${key}/`) && !x.rel.slice(`assets/${key}/`.length).includes('/'))
        .map(x => ({ f: x.f, name: path.basename(x.rel) }));
    return { title: null, files: wrap(files) };

    function wrap(list) {
        const out = {};
        for (const { f, name } of list) out[name] = () => withSteam(u => downloadFile(u, depot, f));
        return out;
    }
}

// Steam chunk formats, read with plain Buffers (steam-user's version uses the
// bytebuffer library, whose string reads break on Node 26):
//   VSZa <crc:4> <zstd data> <crc:4> <size:4> <0:4> zsv
//   VZa  <crc:4> <lzma props:5> <lzma data> <crc:4> <size:4> zv
//   PK.. a regular zip with one entry
let zstd = null;
async function unzipChunk(data) {
    const head = data.subarray(0, 4).toString('latin1');
    if (head === 'VSZa') {
        const n = data.length;
        if (data.subarray(n - 3).toString('latin1') !== 'zsv') throw new Error('Zstd chunk: bad footer');
        const size = data.readUInt32LE(n - 11);
        if (!zstd) { zstd = new ZSTDDecoder(); await zstd.init(); }
        return Buffer.from(zstd.decode(data.subarray(8, n - 15), size));
    }
    if (head.startsWith('VZa')) {
        const n = data.length;
        if (data.subarray(n - 2).toString('latin1') !== 'zv') throw new Error('VZip chunk: bad footer');
        const size = data.readUInt32LE(n - 6);
        const sizeLE = Buffer.alloc(8);
        sizeLE.writeUInt32LE(size, 0);
        const input = Buffer.concat([data.subarray(7, 12), sizeLE, data.subarray(12, n - 10)]);
        return Buffer.from(await new Promise((resolve, reject) =>
            LZMA.decompress(input, (result, err) => (err ? reject(err) : resolve(result)))));
    }
    if (head === 'PK\u0003\u0004') {
        const zip = new AdmZip(data);
        return zip.readFile(zip.getEntries()[0]);
    }
    throw new Error(`Unknown chunk compression ${data.subarray(0, 4).toString('hex')}`);
}

// steam-user's downloadFile reads the content servers' answer as a "binary"
// string, which corrupts the data on newer Node versions (Node 26 on the
// server). Same steps here with raw bytes from fetch: download each chunk,
// decrypt it with the depot key, decompress it, check its SHA-1.
async function downloadFile(user, depot, file) {
    const { servers } = await user.getContentServers(APP_ID);
    const { key } = await user.getDepotDecryptionKey(APP_ID, depot);
    const out = Buffer.alloc(Number(file.size));
    const usable = servers.filter(s => s.Host);
    for (const chunk of file.chunks) {
        const sha = String(chunk.sha).toLowerCase();
        let lastErr;
        for (let attempt = 0; attempt < 5; attempt++) {
            const s = usable[(attempt + Math.floor(Math.random() * usable.length)) % usable.length];
            try {
                const vhost = s.vhost || s.Host;
                const token = s.usetokenauth == 1 ? (await user.getCDNAuthToken(APP_ID, depot, vhost)).token : '';
                const proto = s.https_support === 'mandatory' || s.https_support === 'optional' ? 'https' : 'http';
                const res = await fetch(`${proto}://${vhost}/depot/${depot}/chunk/${sha}${token}`, { signal: AbortSignal.timeout(30000) });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await unzipChunk(SteamCrypto.symmetricDecrypt(Buffer.from(await res.arrayBuffer()), key));
                if (crypto.createHash('sha1').update(data).digest('hex') !== sha) throw new Error('checksum mismatch');
                data.copy(out, Number(chunk.offset));
                lastErr = null;
                break;
            } catch (err) {
                lastErr = err;
            }
        }
        if (lastErr) throw new Error(`Download of ${path.basename(file.filename)} failed: ${lastErr.message}`);
    }
    return out;
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

// "...Belgium 2\0track:134/..." inside track_info.data -> "Belgium 2"
function nameFromInfo(buf) {
    const m = buf?.toString('latin1').match(/([A-Za-z][\w .'()&-]{0,40})\x00track:\d+/);
    return m ? m[1].trim() : null;
}

/** Folder names of the game's own tracks (e.g. "belgium", "mexico"). */
async function officialTracks() {
    const user = await getSteamUser();
    const names = new Set();
    for (const f of (await gameFiles(user)).files) {
        const m = f.filename.replace(/\\/g, '/').match(/^assets\/tracks\/([^/]+)\/minimap\.png$/);
        if (m) names.add(m[1]);
    }
    return [...names].sort();
}

// Files of a track under the names used here (track.png, minimap.png, ...).
async function trackFiles(track) {
    if (/^\d+$/.test(track)) return listFiles(track);
    const orig = String(track).match(/^original\/(.+)$/);
    if (!orig) return listFiles(`tracks/${track}`);
    const n = orig[1];
    const { files } = await listFiles(`tracks_original/${n}`);
    const out = {};
    if (files[`${n}_minimap.png`]) out['minimap.png'] = files[`${n}_minimap.png`];
    if (files[`${n}_left.png`] && files[`${n}_right.png`]) {
        out['track.png'] = async () => {
            const [l, r] = await Promise.all([files[`${n}_left.png`](), files[`${n}_right.png`]()].map(p => p.then(loadImage)));
            const c = createCanvas(l.width + r.width, Math.max(l.height, r.height)), g = c.getContext('2d');
            g.drawImage(l, 0, 0); g.drawImage(r, l.width, 0);
            return c.encode('png');
        };
    }
    return { title: n.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase()), files: out };
}

/** Old "Road Course FA" track folders (e.g. "italy" = Monza), as "original/<name>". */
async function originalTracks() {
    const user = await getSteamUser();
    const names = new Set();
    for (const f of (await gameFiles(user)).files) {
        const m = f.filename.replace(/\\/g, '/').match(/^assets\/tracks_original\/([^/]+)\/\1_minimap\.png$/);
        if (m) names.add(`original/${m[1]}`);
    }
    return [...names].sort();
}

/** Just a track's minimap (small, cached): used to find which track was raced. Null if none. */
async function getMinimap(track) {
    const dir = path.join(CACHE, 'tracks', String(track).replace(/[^\w-]/g, '_'));
    const file = path.join(dir, 'minimap.png');
    if (fs.existsSync(file)) return fs.readFileSync(file);
    const { files } = await trackFiles(track);
    if (!files['minimap.png']) return null;
    const buf = await files['minimap.png']();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, buf);
    return buf;
}

/**
 * The original track.png is kept (full resolution); the replay encodes it at
 * the best quality that fits Discord's limit.
 * @returns {{ name, trackFile, miniFile, worldW, worldH, miniW, miniH }}
 */
async function getTrack(track) {
    const dir = path.join(CACHE, 'tracks', String(track).replace(/[^\w-]/g, '_'));
    const metaFile = path.join(dir, 'meta.json');
    const trackFile = path.join(dir, 'track.png');
    const cached = readJson(metaFile);
    if (cached && fs.existsSync(trackFile)) return { ...cached, trackFile, miniFile: cached.miniW ? path.join(dir, 'minimap.png') : null };

    const { title, files } = await trackFiles(track);
    if (!files['track.png']) throw new Error(`No track.png for track "${track}"`);

    fs.mkdirSync(dir, { recursive: true });
    let worldW, worldH;
    {
        const buf = await files['track.png']();
        const img = await loadImage(buf);
        worldW = img.width; worldH = img.height;
        fs.writeFileSync(trackFile, buf);
        fs.rmSync(path.join(dir, 'map.webp'), { force: true }); // old reduced map
    }
    let miniW = 0, miniH = 0;
    if (files['minimap.png']) {
        const buf = await files['minimap.png']();
        fs.writeFileSync(path.join(dir, 'minimap.png'), buf);
        const img = await loadImage(buf); miniW = img.width; miniH = img.height;
    }
    const info = files['track_info.data'] ? await files['track_info.data']() : null;
    const name = title || nameFromInfo(info) || String(track).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    const meta = { name, worldW, worldH, miniW, miniH };
    fs.writeFileSync(metaFile, JSON.stringify(meta));
    return { ...meta, trackFile, miniFile: miniW ? path.join(dir, 'minimap.png') : null };
}

// The game's data file (sprites of the built-in classes), cached per game version.
async function gameData() {
    const files = (await gameFiles()).files;
    const f = files.find(x => x.filename.replace(/\\/g, '/') === 'assets/game.unx');
    if (!f) throw new Error('game.unx not found in the game files');
    const file = path.join(CACHE, 'game', `game_${String(f.sha_content || f.size)}.unx`);
    if (fs.existsSync(file)) return fs.readFileSync(file);
    console.log(`🎬 [Replay] Downloading the game data (${(Number(f.size) / 1048576).toFixed(0)} MB) for the built-in car classes…`);
    const buf = await withSteam(u => downloadFile(u, LINUX_DEPOT, f));
    fs.rmSync(path.dirname(file), { recursive: true, force: true }); // older game versions
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    return buf;
}

// Classes built into the game ("formulaa", "gtclassa", ...): their liveries are
// the sprites "<class>_medium_1..10" in the game data.
async function builtInCars(carClass, dir) {
    const names = Array.from({ length: 10 }, (_, i) => `${carClass}_medium_${i + 1}`);
    const sprites = await extractSprites(await gameData(), names);
    if (!sprites.size) return [];
    fs.mkdirSync(dir, { recursive: true });
    names.forEach((n, i) => sprites.has(n) && fs.writeFileSync(path.join(dir, `car_${i + 1}.png`), sprites.get(n)));
    fs.writeFileSync(path.join(dir, 'builtin'), '');
    return [...sprites.values()];
}

// Last resort, drawn by the bot: plain top-down cars in 10 colours.
async function genericCars() {
    const colors = ['#d62828', '#1d4ed8', '#f5f5f5', '#15803d', '#facc15', '#7c3aed', '#f97316', '#0891b2', '#db2777', '#404040'];
    const out = [];
    for (const col of colors) {
        const c = createCanvas(109, 45), g = c.getContext('2d');
        g.fillStyle = '#1a1a1a';
        for (const [x, y] of [[14, 2], [14, 33], [78, 4], [78, 31]]) g.fillRect(x, y, 18, 10); // wheels
        g.fillStyle = col;
        g.beginPath(); g.moveTo(4, 12); g.lineTo(70, 14); g.lineTo(106, 20); g.lineTo(106, 25); g.lineTo(70, 31); g.lineTo(4, 33); g.closePath(); g.fill();
        g.fillRect(96, 6, 8, 33); g.fillRect(2, 8, 8, 29); // front / rear wings
        g.fillStyle = '#111'; g.beginPath(); g.ellipse(52, 22.5, 9, 5, 0, 0, Math.PI * 2); g.fill(); // cockpit
        out.push(await c.encode('png'));
    }
    return out;
}

/** Car images car_1..car_10 for a class (PNG buffers). */
async function getCarClass(carClass) {
    const dir = path.join(CACHE, 'classes', String(carClass).replace(/[^\w-]/g, '_'));
    const list = d => fs.existsSync(d)
        ? fs.readdirSync(d).filter(f => /^car_\d+\.png$/.test(f)).sort((a, b) => parseInt(a.slice(4)) - parseInt(b.slice(4))).map(f => fs.readFileSync(path.join(d, f)))
        : [];

    let cars = list(dir);
    // A download cut halfway leaves a broken PNG in the cache: drop the class and fetch it again.
    if (cars.some(b => !isPng(b))) {
        console.warn(`⚠️ [Replay] Car class "${carClass}": broken image in the cache, downloading it again.`);
        fs.rmSync(dir, { recursive: true, force: true });
        cars = [];
    }
    if (cars.length) {
        // Cached before the size was read: fetch the class's info file once
        // (built-in classes have none).
        if (!fs.existsSync(path.join(dir, 'builtin')) && !CLASS_INFO.some(n => fs.existsSync(path.join(dir, n)))) {
            try {
                const { files } = await listFiles(/^\d+$/.test(carClass) ? carClass : `cars/${carClass}`);
                for (const n of CLASS_INFO) if (files[n]) fs.writeFileSync(path.join(dir, n), await files[n]());
            } catch (err) { console.warn(`⚠️ [Replay] Car class "${carClass}" size:`, err.message); }
        }
        return { cars, builtIn: false, carLen: carLength(dir, cars[0]) };
    }
    try {
        const isWorkshop = /^\d+$/.test(carClass);
        const { files } = await listFiles(isWorkshop ? carClass : `cars/${carClass}`);
        const names = Object.keys(files).filter(n => /^car_\d+\.png$/.test(n));
        if (names.length) {
            fs.mkdirSync(dir, { recursive: true });
            for (const n of names) {
                const buf = await files[n]();
                if (!isPng(buf)) throw new Error(`${n} downloaded incomplete`);
                fs.writeFileSync(path.join(dir, n), buf);
            }
            for (const n of CLASS_INFO) if (files[n]) fs.writeFileSync(path.join(dir, n), await files[n]());
            cars = list(dir);
        }
    } catch (err) {
        console.warn(`⚠️ [Replay] Car class "${carClass}":`, err.message);
        fs.rmSync(dir, { recursive: true, force: true }); // nothing half-downloaded stays cached
        cars = [];
    }
    if (!cars.length && !/^\d+$/.test(carClass)) {
        try {
            cars = await builtInCars(carClass, dir);
        } catch (err) {
            console.warn(`⚠️ [Replay] Built-in car class "${carClass}":`, err.message);
        }
    }
    if (cars.length) return { cars, builtIn: fs.existsSync(path.join(dir, 'builtin')), carLen: carLength(dir, cars[0]) };
    console.warn(`⚠️ [Replay] No cars for class "${carClass}", using plain ones.`);
    return { cars: await genericCars(), builtIn: true, carLen: null };
}

// Car length on the track (world px). The class files store, one after the
// other: <png width> <png height> <size factor> <scale>, and the game draws the
// car at png width x factor x scale (Formula eSports Retro: 109 x 0.83 x 0.38 =
// 34.4 px, matches the game next to the grid box).
//   item.data        older Workshop classes, text: ...|105.0000|39.0000|1.0000|0.3800|...
//   class_info.data  official and newer Workshop classes, binary: 4 little-endian doubles
// Without either the replay keeps its default.
const CLASS_INFO = ['item.data', 'class_info.data'];
// A whole PNG: signature and header (the size is read from it).
const isPng = b => b?.length > 33 && b.readUInt32BE(0) === 0x89504e47 && b.toString('latin1', 12, 16) === 'IHDR';

function carLength(dir, png) {
    if (!isPng(png)) return null;
    const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
    const len = (factor, scale) => (factor > 0.2 && factor < 3 && scale > 0.05 && scale < 3 ? Math.round(w * factor * scale * 10) / 10 : null);
    try {
        const f = fs.readFileSync(path.join(dir, 'item.data'), 'latin1').split('|');
        for (let i = 0; i + 3 < f.length; i++) {
            if (Number(f[i]) === w && Number(f[i + 1]) === h && len(Number(f[i + 2]), Number(f[i + 3]))) return len(Number(f[i + 2]), Number(f[i + 3]));
        }
    } catch { /* no item.data */ }
    try {
        const b = fs.readFileSync(path.join(dir, 'class_info.data'));
        for (let i = 0; i + 32 <= b.length; i++) {
            if (b.readDoubleLE(i) === w && b.readDoubleLE(i + 8) === h && len(b.readDoubleLE(i + 16), b.readDoubleLE(i + 24))) return len(b.readDoubleLE(i + 16), b.readDoubleLE(i + 24));
        }
    } catch { /* no class_info.data */ }
    return null;
}

module.exports = { getTrack, getMinimap, getCarClass, officialTracks, originalTracks };
