const fs = require('fs');
const path = require('path');

const storeFile = path.join(__dirname, '../data/starters.json');

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

function setRound(cat, round) {
    const all = readAll();
    all[cat] = round;
    writeAll(all);
    return round;
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

module.exports = { getRound, setRound, updateRound, getMeta, setMeta };
