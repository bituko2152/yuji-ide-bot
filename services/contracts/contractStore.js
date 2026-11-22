const { dataFile, readJson, writeJson } = require('../core/jsonStore');

const storeFile = dataFile('contracts.json');

function readAll() {
    return readJson(storeFile);
}

function writeAll(data) {
    writeJson(storeFile, data);
}

function createContract(id, contract) {
    const all = readAll();
    all[id] = contract;
    writeAll(all);
    return all[id];
}

function getContract(id) {
    return readAll()[id] || null;
}

function updateContract(id, updater) {
    const all = readAll();
    if (!all[id]) return null;
    updater(all[id]);
    writeAll(all);
    return all[id];
}

function allContracts() {
    return readAll();
}

function deleteContracts(ids) {
    const all = readAll();
    for (const id of ids) delete all[id];
    writeAll(all);
}

module.exports = { createContract, getContract, updateContract, allContracts, deleteContracts };