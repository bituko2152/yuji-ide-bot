const fs = require('fs');
const path = require('path');
const util = require('util');

/*
 * Every console line gets the time (Spanish time, the league's) and is also
 * appended to data/logs/<date>.log, so the log is still there after the panel
 * is closed or the bot restarts. Writes go through one append stream (no
 * blocking per line); files older than KEEP_DAYS are deleted at startup.
 */

const DIR = path.join(__dirname, '../../data/logs');
const KEEP_DAYS = 14;
const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
});

function stamp() {
    const p = Object.fromEntries(fmt.formatToParts(new Date()).map(x => [x.type, x.value]));
    return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
}

function install() {
    try {
        fs.mkdirSync(DIR, { recursive: true });
        const old = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
        for (const f of fs.readdirSync(DIR)) {
            const file = path.join(DIR, f);
            if (fs.statSync(file).mtimeMs < old) fs.unlinkSync(file);
        }
    } catch { /* logging must never stop the bot */ }

    let stream = null, streamDay = null;
    const write = line => {
        try {
            const { day } = stamp();
            if (day !== streamDay) {
                stream?.end();
                stream = fs.createWriteStream(path.join(DIR, `${day}.log`), { flags: 'a' });
                stream.on('error', () => { stream = null; });
                streamDay = day;
            }
            stream?.write(line + '\n');
        } catch { /* ignore */ }
    };

    for (const level of ['log', 'warn', 'error']) {
        const original = console[level].bind(console);
        console[level] = (...args) => {
            const line = `[${stamp().time}] ${util.format(...args)}`;
            original(line);
            write(line);
        };
    }
}

module.exports = { install };
