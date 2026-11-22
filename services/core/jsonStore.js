const fs = require('fs');
const path = require('path');

/*
 * The bot's small JSON stores in data/ (contracts, polls, lineups...). A file
 * that's missing or can't be read gives the fallback, so a lost or broken file
 * never stops the bot.
 */

const DATA_DIR = path.join(__dirname, '../../data');

/** data/<name> */
const dataFile = name => path.join(DATA_DIR, name);

function readJson(file, fallback = {}) {
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
        return data && typeof data === 'object' ? data : fallback;
    } catch {
        return fallback;
    }
}

function writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

module.exports = { dataFile, readJson, writeJson };
