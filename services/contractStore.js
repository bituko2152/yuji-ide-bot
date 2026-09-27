const fs = require('fs');
const path = require('path');

const storeFile = path.join(__dirname, '../data/contracts.json');

function readAll() {
    try { return JSON.parse(fs.readFileSync(storeFile, 'utf-8')); }
    catch { return {}; }
}

function writeAll(data) {
    fs.writeFileSync(storeFile, JSON.stringify(data, null, 2));
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

module.exports = { createContract, getContract, updateContract, allContracts };