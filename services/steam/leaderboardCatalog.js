const fs = require('fs');
const path = require('path');

/*
 * Tracks and car classes of Ultimate Racing 2D 2 that /record can show.
 *
 * Leaderboard names:
 *  - base class + base track:   "<class key>_<track key>"   formulaa_australia
 *  - any Workshop class/track:  "zz<class>_<track>"          zz3805310984_3548574750
 *    using the Workshop id for Workshop items and the key for base ones
 *    (zz2819834039_australia, zzformulaa_3548574750).
 *
 * Base keys come from the game files. Workshop tracks/classes are listed by
 * id in config.json "records" and their titles are read from the Workshop.
 */

const TRACK_KEYS = [
    'australia', 'austria', 'bahrein', 'belgium', 'brazil', 'canada', 'china', 'france', 'germany',
    'germany_classic', 'hungary', 'italy', 'japan', 'malaysia', 'mexico', 'monaco', 'netherlands',
    'netherlands_classic', 'russia', 'south_africa_classic', 'spain', 'uae', 'uk', 'uk_classic', 'usa',
    'oval_germany', 'oval_japan', 'oval_uk', 'oval_usa',
    'karting_argentina', 'karting_france', 'karting_india', 'karting_morocco', 'karting_portugal',
    'karting_qatar', 'karting_south_korea', 'karting_turkey',
    'dirt_oval_czech_republic', 'dirt_oval_finland', 'dirt_oval_new_zealand', 'dirt_oval_poland', 'dirt_oval_sweden'
];

const CLASSES = {
    formulaa: 'Formula A',
    formulaaretro: 'Formula A Retro',
    formulab: 'Formula B',
    formularetroa: 'Formula Retro A',
    formularetrob: 'Formula Retro B',
    formulaspeedway: 'Formula Speedway',
    gtclassa: 'GT Class A',
    gtclassb: 'GT Class B',
    sportsprototype1: 'Sports Prototype 1',
    sportsprototype2: 'Sports Prototype 2',
    sportscarsa: 'Sports Cars A',
    sportscarsb: 'Sports Cars B',
    supercarsa: 'Supercars A',
    supercarsc: 'Supercars C',
    touringcarsa2: 'Touring Cars A2',
    touringcarsc: 'Touring Cars C',
    touringcarsd: 'Touring Cars D',
    stockcars: 'Stock Cars',
    musclecarsb: 'Muscle Cars B',
    vintagegt: 'Vintage GT',
    vintagecabriolet: 'Vintage Cabriolet',
    karts85cc: 'Karts 85cc',
    superkarts250cc: 'Superkarts 250cc',
    dirtcarsa: 'Dirt Cars A',
    dirtbikes: 'Dirt Bikes',
    motorbikes: 'Motorbikes',
    quads: 'Quads',
    minicars: 'Mini Cars',
    speedwaytrucks2: 'Speedway Trucks 2',
    trucks: 'Trucks',
    monstertruck: 'Monster Truck',
    copcar: 'Cop Car',
    limo: 'Limo',
    forklifttrucks: 'Forklift Trucks',
    tractor: 'Tractor',
    combine: 'Combine'
};

const UPPER = { uae: 'UAE', uk: 'UK', usa: 'USA' };
const RENAME = { bahrein: 'Bahrain' };

// "karting_south_korea" -> "Karting South Korea", "uk_classic" -> "UK (Classic)"
function trackName(key) {
    const classic = key.endsWith('_classic');
    const words = key.replace(/_classic$/, '').split('_')
        .map(w => UPPER[w] || RENAME[w] || w[0].toUpperCase() + w.slice(1));
    return words.join(' ') + (classic ? ' (Classic)' : '');
}

const TRACKS = Object.fromEntries(TRACK_KEYS.map(k => [k, trackName(k)]));

// ---------------------------------------------------------------- Workshop

// Workshop items use "ws:<id>" as their key so they can't clash with base keys.
const WS = 'ws:';
const isWorkshop = key => key.startsWith(WS);
const workshopId = key => key.slice(WS.length);

const DETAILS_URL = 'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/';
const TITLES_CACHE_MS = 60 * 60 * 1000;
let titles = { at: 0, map: {} }; // workshop id -> title
let loading = null;

// Each list in config.json can be an array of ids (Workshop titles are used)
// or an object { "<id>": "<custom name>" } ("" = use the Workshop title).
// Returns { id: customName | null }.
function normalize(list) {
    if (Array.isArray(list)) return Object.fromEntries(list.map(id => [String(id), null]));
    return Object.fromEntries(Object.entries(list || {}).map(([id, name]) => [id, name || null]));
}

// records.channels (or the older records.channel): channel id(s) where
// /record works, as one id or a list. Empty/"???" = anywhere.
function recordsChannels() {
    try {
        const r = JSON.parse(fs.readFileSync(path.join(__dirname, '../../config.json'), 'utf-8')).records || {};
        return [r.channels ?? [], r.channel ?? []].flat().filter(id => id && id !== '???');
    } catch {
        return [];
    }
}

function workshopIds() {
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../config.json'), 'utf-8')).records || {};
        return { tracks: normalize(cfg.workshop_tracks), classes: normalize(cfg.workshop_classes) };
    } catch {
        return { tracks: {}, classes: {} };
    }
}

async function loadTitles(ids) {
    const body = new URLSearchParams({ itemcount: String(ids.length) });
    ids.forEach((id, i) => body.append(`publishedfileids[${i}]`, id));
    const res = await fetch(DETAILS_URL, { method: 'POST', body });
    const json = await res.json();
    return Object.fromEntries((json.response?.publishedfiledetails || [])
        .filter(d => d.result === 1)
        .map(d => [d.publishedfileid, d.title]));
}

// Titles of the configured Workshop items, refreshed hourly (and whenever
// config.json lists an id we don't know yet).
async function workshopTitles() {
    const { tracks, classes } = workshopIds();
    const ids = [...new Set([...Object.keys(tracks), ...Object.keys(classes)])];
    const missing = ids.some(id => !(id in titles.map));
    if (ids.length && (missing || Date.now() - titles.at > TITLES_CACHE_MS)) {
        loading ||= loadTitles(ids)
            .then(map => { titles = { at: Date.now(), map }; })
            .catch(err => console.error('❌ [Record] Workshop titles:', err.message))
            .finally(() => { loading = null; });
        await loading;
    }
    const pick = list => Object.fromEntries(Object.entries(list)
        .map(([id, custom]) => [WS + id, custom || titles.map[id] || `Workshop ${id}`]));
    return { tracks: pick(tracks), classes: pick(classes) };
}

// Workshop (league) items first, so they show up at the top of the suggestions.
async function getTracks() {
    return { ...(await workshopTitles()).tracks, ...TRACKS };
}

async function getClasses() {
    return { ...(await workshopTitles()).classes, ...CLASSES };
}

// Base class + base track: "formulaa_australia". As soon as the class or the
// track comes from the Workshop: "zz<class>_<track>" with Workshop ids in
// place of keys, e.g. "zz2819834039_australia", "zzformulaa_3548574750".
function leaderboardName(classKey, trackKey) {
    const cls = isWorkshop(classKey) ? workshopId(classKey) : classKey;
    const trk = isWorkshop(trackKey) ? workshopId(trackKey) : trackKey;
    return isWorkshop(classKey) || isWorkshop(trackKey) ? `zz${cls}_${trk}` : `${cls}_${trk}`;
}

const className = key => CLASSES[key] || key;

// Autocomplete helper: best matches of `query` among { key: displayName }.
function search(map, query, limit = 25) {
    const q = query.toLowerCase().trim();
    const all = Object.entries(map).map(([value, name]) => ({ name, value }));
    if (!q) return all.slice(0, limit);
    const starts = all.filter(c => c.name.toLowerCase().startsWith(q));
    const contains = all.filter(c => !starts.includes(c) && c.name.toLowerCase().includes(q));
    return [...starts, ...contains].slice(0, limit);
}

module.exports = { recordsChannels, TRACKS, CLASSES, getTracks, getClasses, trackName, className, leaderboardName, search, isWorkshop };
