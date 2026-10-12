const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { getTrack, getMinimap, getCarClass, officialTracks } = require('./assets');

/*
 * Fills assets/replay/template.html with a race: replay data from the
 * builder + track / minimap / car images, all embedded, so the result is one
 * HTML file that opens offline.
 */

const TEMPLATE = path.join(__dirname, '../../assets/replay/template.html');
const NONE16 = -32768;

const dataUri = (buf, type) => `data:${type};base64,${buf.toString('base64')}`;

// Car arrays as deltas (cars move a few px per frame -> small, repetitive
// numbers), deflated: ~9x smaller. The page inflates them with the browser's
// DecompressionStream before starting.
function packCars(cars) {
    const unb64 = (s, T) => { const b = Buffer.from(s, 'base64'); return new T(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); };
    const pack = a => {
        const d = new Int32Array(a.length);
        let prev = 0;
        for (let i = 0; i < a.length; i++) { d[i] = a[i] - prev; prev = a[i]; }
        return zlib.deflateRawSync(Buffer.from(d.buffer), { level: 9 }).toString('base64');
    };
    return cars.map(c => ({ ...c, x: pack(unb64(c.x, Int16Array)), y: pack(unb64(c.y, Int16Array)), a: pack(unb64(c.a, Int16Array)), p: pack(unb64(c.p, Int32Array)) }));
}

// Points where the cars actually drove (world px), for fitting the minimap.
function drivenPoints(data) {
    const pts = [];
    const step = Math.max(1, Math.floor(data.frames * data.cars.length / 1000)); // ~1000 points
    for (const c of data.cars) {
        const b = Buffer.from(c.x, 'base64'), x = new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
        const by = Buffer.from(c.y, 'base64'), y = new Int16Array(by.buffer.slice(by.byteOffset, by.byteOffset + by.length));
        for (let k = 0; k < x.length; k += step) if (x[k] !== NONE16) pts.push([x[k], y[k]]);
    }
    return pts;
}

// The game's minimap is the whole world scaled to miniW / worldW (Barcelona:
// 5250 x 2000 for a 5250 x 2000 world, fits 100%). Keep that unless another
// scale/offset is clearly better: with thick lines many nearly-right fits score
// the same, and picking one of those shifts the dots.
async function fitMinimap(miniFile, track, pts) {
    const img = await loadImage(fs.readFileSync(miniFile));
    const c = createCanvas(img.width, img.height), g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const alpha = g.getImageData(0, 0, img.width, img.height).data;
    const on = (x, y) => x >= 0 && y >= 0 && x < img.width && y < img.height && alpha[(y * img.width + x) * 4 + 3] > 40;
    const hitsAt = (s, ox, oy) => pts.reduce((n, [x, y]) => n + on(Math.round(x * s + ox), Math.round(y * s + oy)), 0);
    const base = img.width / track.worldW;
    let best = { s: base, ox: 0, oy: 0, hits: hitsAt(base, 0, 0) };
    const margin = Math.max(1, pts.length * 0.03);
    for (let s = base * 0.96; s <= base * 1.04; s += base * 0.002)
        for (let ox = -12; ox <= 12; ox++)
            for (let oy = -12; oy <= 12; oy++) {
                const hits = hitsAt(s, ox, oy);
                if (hits > best.hits + margin) best = { s, ox, oy, hits };
            }
    return { s: best.s, ox: best.ox, oy: best.oy, w: img.width, h: img.height };
}

// Share of the driven points that land on the drawing of a minimap. The
// minimap is the whole world scaled down from the same corner; the world size
// isn't known yet (it comes with the big track.png), so widths from 2500 to
// 16000 px are tried. The right track scores ~0.8, others far less.
async function minimapScore(buf, pts) {
    const img = await loadImage(buf);
    const W = img.width, H = img.height, c = createCanvas(W, H), g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const alpha = g.getImageData(0, 0, W, H).data;
    const on = (x, y) => x >= 0 && y >= 0 && x < W && y < H && alpha[(y * W + x) * 4 + 3] > 40;
    let best = 0;
    for (let worldW = 2500; worldW <= 16000; worldW *= 1.004) {
        const s = W / worldW;
        let hits = 0;
        for (const [x, y] of pts) if (on(Math.round(x * s), Math.round(y * s))) hits++;
        best = Math.max(best, hits / pts.length);
    }
    return best;
}

function leagueWorkshopTracks() {
    try {
        const list = JSON.parse(fs.readFileSync(path.join(__dirname, '../../config.json'), 'utf-8')).records?.circuitos_workshop || [];
        return (Array.isArray(list) ? list : Object.keys(list)).map(String);
    } catch {
        return [];
    }
}

// The lobby lists the championship tracks; which one is being raced isn't
// reliable in the settings, so check each track's minimap against where the
// cars drove and keep the best fit (the settings' guess wins ties).
async function identifyTrack(data, pts) {
    let candidates = [...new Set([data.track, ...(data.trackCandidates || [])].filter(Boolean))];
    // No championship list from the lobby: every official track plus the
    // league's Workshop tracks (config "records.circuitos_workshop").
    if (!candidates.length) candidates = [...leagueWorkshopTracks(), ...await officialTracks()];
    if (candidates.length === 1) return candidates[0];
    const sample = pts.length > 400 ? pts.filter((_, i) => i % Math.ceil(pts.length / 400) === 0) : pts;
    const scores = [];
    for (const t of candidates) {
        try {
            const buf = await getMinimap(t);
            scores.push({ track: t, score: buf ? await minimapScore(buf, sample) : 0 });
        } catch (err) {
            console.warn(`⚠️ [Replay] Track "${t}":`, err.message);
        }
    }
    // Best fit; the settings' guess wins near-ties.
    scores.sort((a, b) => b.score - a.score);
    let best = scores[0];
    const guess = scores.find(s => s.track === data.track);
    if (!best) return data.track;
    if (guess && guess.score >= best.score - 0.02) best = guess;
    const top = scores.slice(0, 3).map(s => `${s.track} ${Math.round(s.score * 100)}%`).join(', ');
    console.log(`🎬 [Replay] Track: settings said "${data.track}", picked "${best.track}" (best fits: ${top}).`);
    return best.track;
}

/** @returns {Promise<{ html: string, trackName: string }>} */
async function renderReplay(data, { lobbyName } = {}) {
    data = { ...data, track: await identifyTrack(data, drivenPoints(data)) };
    const track = await getTrack(data.track);
    const { cars: carImgs, builtIn, carLen } = await getCarClass(data.carClass);

    const trackImg = await loadImage(fs.readFileSync(track.trackFile));
    // The map is filled in last, at the best quality that still fits (see below).
    const map = { src: MAP_TOKEN, s: 1, w: track.worldW, h: track.worldH };

    let mini;
    if (track.miniFile) {
        mini = await fitMinimap(track.miniFile, track, drivenPoints(data));
        mini.src = dataUri(fs.readFileSync(track.miniFile), 'image/png');
    } else {
        // No minimap image: the map itself, small.
        const w = 512, h = Math.round(512 * track.worldH / track.worldW);
        mini = { src: dataUri(await encodeMap(trackImg, w, 80), 'image/webp'), s: w / track.worldW, ox: 0, oy: 0, w, h };
    }

    // Who drives which livery (1-10), as chosen in the lobby.
    const assign = {};
    for (const c of data.cars) assign[c.name] = Math.min(10, Math.max(1, c.livery || 1));

    const full = {
        ...data,
        cars: packCars(data.cars),
        packed: 'delta-deflate',
        // Unique per race: livery choices saved in the browser stay with this replay.
        replayId: require('crypto').createHash('sha1').update(`${data.track}|${data.frames}|${data.cars.map(c => c.name + c.p.slice(0, 64)).join('|')}`).digest('hex').slice(0, 12),
        trackName: track.name,
        map, mini,
        sprites: carImgs.map(b => dataUri(b, 'image/png')),
        liveryConfig: { assign },
        builtInClass: builtIn,
        carLen, // car length on track (world px) for this class, if known
    };
    const title = `${track.name} — Race Replay`;
    const page = fs.readFileSync(TEMPLATE, 'utf-8')
        .replace('/*__REPLAY_DATA__*/null', () => JSON.stringify(full).replace(/</g, '\\u003c'))
        .replace('/*__REPLAY_TITLE__*/', () => title.replace(/[<&]/g, ''));

    // Map embedded at a reduced size to keep the file small; the page has a
    // button to load the full-quality track.png from the viewer's own PC.
    const w = Math.min(MAP_WIDTH, track.worldW);
    const mapBuf = await encodeMap(trackImg, w, MAP_QUALITY);
    const html = page
        .replace(`"s":1,"w":${track.worldW},"h":${track.worldH}`, `"s":${w / track.worldW},"w":${w},"h":${Math.round(track.worldH * w / track.worldW)}`)
        .replace(MAP_TOKEN, () => dataUri(mapBuf, 'image/webp'));
    return { html, trackName: track.name, lobbyName };
}

const MAP_TOKEN = '__REPLAY_MAP__';
const MAP_WIDTH = 3072;
const MAP_QUALITY = 72;

async function encodeMap(img, w, quality) {
    const h = Math.round(img.height * w / img.width), c = createCanvas(w, h);
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return c.encode('webp', quality);
}

module.exports = { renderReplay };
