const fs = require('fs');
const path = require('path');

const storeFile = path.join(__dirname, '../../data/starters.json');

/*
 * Shape of data/starters.json — ONE entry per category, overwritten every
 * time a new week opens (so nothing accumulates):
 *
 * {
 *   "UL": {
 *     roundName, weekStart, closesAt, open,
 *     channelId, messageId, pingMessageId (first board of the week, the only one that pings),
 *     teams: { "<teamRoleId>": [ { userId, name }, ... ] },
 *     independents: [ { userId, name }, ... ],
 *     requests: { "<reqId>": { userId, name, teamRoleId, messageId } }
 *   }
 * }
 */

function readAll() {
    try { return JSON.parse(fs.readFileSync(storeFile, 'utf-8')); }
    catch { return {}; }
}

function writeAll(data) {
    fs.writeFileSync(storeFile, JSON.stringify(data, null, 2));
}

function getRound(cat) {
    return readAll()[cat] || null;
}

const HISTORY_KEEP = 40; // rounds kept (all categories)

function setRound(cat, round) {
    const all = readAll();
    // A new week replaces the previous round: keep who raced it (for
    // /results upload, which can run after the next week has opened).
    const prev = all[cat];
    if (prev?.roundName && prev.roundName !== round.roundName) {
        all._history ||= {};
        all._history[prev.roundName] = { roundName: prev.roundName, teams: prev.teams || {}, independents: prev.independents || [], savedAt: Date.now() };
        const names = Object.keys(all._history).sort((a, b) => all._history[a].savedAt - all._history[b].savedAt);
        for (const n of names.slice(0, Math.max(0, names.length - HISTORY_KEEP))) delete all._history[n];
    }
    all[cat] = round;
    writeAll(all);
    return round;
}

/** Starters of a round by name ("ULS26R2"): the current week's, or an archived one. */
function getRoundByName(roundName) {
    const all = readAll();
    const norm = s => String(s || '').toUpperCase();
    const current = Object.entries(all).find(([k, r]) => !k.startsWith('_') && norm(r?.roundName) === norm(roundName));
    if (current) return current[1];
    const old = Object.values(all._history || {}).find(r => norm(r.roundName) === norm(roundName));
    return old || null;
}

// Synchronous read-modify-write: safe in Node's single thread as long as
// the updater itself doesn't await anything.
function updateRound(cat, updater) {
    const all = readAll();
    if (!all[cat]) return null;
    updater(all[cat]);
    writeAll(all);
    return all[cat];
}

// Small bookkeeping area (e.g. which week the "reports open" announcement
// was last sent). Lives under "_meta" so it never collides with a category.
function getMeta() {
    return readAll()._meta || {};
}

function setMeta(meta) {
    const all = readAll();
    all._meta = meta;
    writeAll(all);
}

module.exports = { getRound, getRoundByName, setRound, updateRound, getMeta, setMeta };
