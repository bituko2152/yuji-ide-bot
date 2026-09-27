const fs = require('fs');
const path = require('path');

const storeFile = path.join(__dirname, '../data/polls.json');

function readAll() {
    try { return JSON.parse(fs.readFileSync(storeFile, 'utf-8')); }
    catch { return {}; }
}

function writeAll(data) {
    fs.writeFileSync(storeFile, JSON.stringify(data, null, 2));
}

/**
 * Creates the record for a new poll. It's indexed by messageId, so
 * it survives bot restarts (unlike the old createMessageComponentCollector,
 * which lost its state in memory).
 */
function createPoll(messageId, data) {
    const all = readAll();
    all[messageId] = {
        reportId: data.reportId,
        threadId: data.threadId || null,
        votes: { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0, G: 0 },
        baseVotes: {},   // userId -> 'A' | 'B'
        levelVotes: {},  // userId -> 'C'..'G'
        ...data.overrides
    };
    writeAll(all);
    return all[messageId];
}

function getPoll(messageId) {
    const all = readAll();
    return all[messageId] || null;
}

function updatePoll(messageId, updater) {
    const all = readAll();
    if (!all[messageId]) return null;
    updater(all[messageId]);
    writeAll(all);
    return all[messageId];
}

module.exports = { createPoll, getPoll, updatePoll, readAll };