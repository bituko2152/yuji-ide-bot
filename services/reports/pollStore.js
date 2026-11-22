const { dataFile, readJson, writeJson } = require('../core/jsonStore');

const storeFile = dataFile('polls.json');

function readAll() {
    return readJson(storeFile);
}

function writeAll(data) {
    writeJson(storeFile, data);
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

function deletePolls(messageIds) {
    const all = readAll();
    for (const id of messageIds) delete all[id];
    writeAll(all);
}

module.exports = { createPoll, getPoll, updatePoll, readAll, deletePolls };