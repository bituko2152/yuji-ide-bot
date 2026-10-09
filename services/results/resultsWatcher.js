const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const { AttachmentBuilder } = require('discord.js');
const { fetchLobbies } = require('../steam/lobbyService');

/*
 * League results: /results listen follows an online lobby and posts each
 * qualifying / race table as a CSV (human drivers only) to config
 * "resultados.canal_id", until the lobby closes or /results stop.
 *
 * Listening is "hidden": the bot connects to the lobby on the master server
 * but never introduces itself as a player, so it takes no seat and nobody
 * sees it, yet the server still relays it the lobby traffic, results
 * included. Protocol (client -> server, every field ends in "\n\0"):
 *   96 <lobby> <id> 1 0 / "Join Server" 1 <seq> / 105 <lobby> 1 <seq>   connect
 *   100 <lobby> 0 -1, 93 ... *20, 94 ... *21 (every 3 s)               keep-alive
 *   95 <lobby> <id> 1 <seq>                                            leave
 * Server -> client: "*<a|b|c...>~|<reliable>|<msgId>|", reliable ones get
 * "ack\n2\n<msgId>\n\0". Results: one "*3|2|<session>|<row>|...|" per
 * finishing position (rows 0..19), resent 2-3 times.
 */

const PORT = 6510;
const TICK_MS = 60 * 1000;
const KEEPALIVE_MS = 3 * 1000;
const TABLE_SETTLE_MS = 2 * 1000;   // a table is complete once rows stop arriving
const NO_TIME = 1e6;                // the game's "no time" values are >= 1,000,000
// Session numbers in the results messages. Anything else (practice) is ignored.
const SESSIONS = { 2: 'qualifying', 3: 'race' };

function loadConfig() {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '../../config.json'), 'utf-8'));
}


// ---------------------------------------------------------------- results

// "*3|2|<session>|<row>|...|" -> row; the session result is in the last fields.
function parseRow(f) {
    const n = f.length;
    return {
        index: Number(f[3]),
        name: f[n - 11],
        id: f[n - 7],
        quali: Number(f[n - 5]),
        grid: Number(f[n - 4]),
        total: Number(f[n - 3]),
        best: Number(f[n - 2])
    };
}

// Same rows as CSV, columns named like the Supabase "results" table
// (times in ms) so a confirmed file can be imported as is.
function buildCsv(rows, isRace) {
    const humans = rows.sort((a, b) => a.index - b.index).filter(r => r.id.includes(':') && r.quali < NO_TIME);
    const ms = s => (s < NO_TIME ? Math.round(s * 1000) : '');
    const cell = v => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

    let header, lines;
    if (!isRace) {
        const pole = humans[0]?.quali;
        header = ['position', 'driver', 'quali_time_ms', 'gap_ms'];
        lines = humans.map((r, i) => [i + 1, r.name, ms(r.quali), i ? ms(r.quali - pole) : 0]);
    } else {
        const finishers = humans.filter(r => r.total < NO_TIME);
        const winner = finishers[0]?.total;
        // Fastest lap among ALL drivers: a DNF can hold it too (league rule).
        const fastest = Math.min(...humans.filter(r => r.best < NO_TIME).map(r => r.best));
        header = ['position', 'driver', 'grid', 'quali_time_ms', 'race_time_ms', 'gap_ms', 'best_lap_ms', 'fastest_lap', 'dnf'];
        lines = humans.map((r, i) => {
            const dnf = r.total >= NO_TIME;
            return [i + 1, r.name, r.grid, ms(r.quali), ms(r.total), dnf ? '' : ms(r.total - winner),
            ms(r.best), r.best === fastest, dnf];
        });
    }
    return [header, ...lines].map(l => l.map(cell).join(',')).join('\n') + '\n';
}

// ---------------------------------------------------------------- listening

const watching = new Map(); // "<host>|<lobbyId>" -> watcher

const rnd = () => String(100000 + Math.floor(Math.random() * 900000));

function watch(client, lobby, channelId) {
    const key = lobbyKey(lobby);
    const myId = `${rnd()}/${rnd()}/${rnd()}:${Math.random().toString(36).slice(2, 5)}`;
    const socket = dgram.createSocket('udp4');
    const tables = new Map();   // session -> { rows: Map(index -> row), timer }
    const posted = new Set();   // signatures of tables already posted (resends)
    let seq = 0;

    const raw = fields => socket.send(Buffer.from(fields.map(f => `${f}\n\0`).join(''), 'utf-8'), PORT, lobby.host);
    const send = (type, target, payload) => {
        const p = [...payload];
        p[p.length - 1] += '~';
        raw([type, lobby.port, target, ...p, '1', String(++seq)]);
    };

    async function postTable(session) {
        const table = tables.get(session);
        tables.delete(session);
        const isRace = SESSIONS[session] === 'race';
        const csv = buildCsv([...table.rows.values()], isRace);
        if (csv.split('\n').length <= 2) return; // header only: no human drivers
        if (posted.has(csv)) return;
        posted.add(csv);

        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel) return console.warn(`⚠️ [Results] Channel ${channelId} not found.`);

        const fileName = `${lobby.name.replace(/[^\w-]+/g, '_')}_${isRace ? 'race' : 'qualifying'}.csv`;
        await channel.send({ files: [new AttachmentBuilder(Buffer.from(csv, 'utf-8'), { name: fileName })] })
            .catch(err => console.error('❌ [Results]', err.message));
    }

    socket.on('message', msg => {
        const m = msg.toString('utf-8').match(/^\*(.*)~\|(\d)\|(-?\d+)\|$/s);
        if (!m) return;
        if (m[2] === '1') socket.send(Buffer.from(`ack\n2\n${m[3]}\n\0`, 'latin1'), PORT, lobby.host);

        const f = m[1].replace(/\|$/, '').split('|');
        if (f[0] !== '3' || f[1] !== '2' || f.length < 15) return;

        const session = f[2];
        if (!SESSIONS[session]) return; // practice

        const row = parseRow(f);
        const table = tables.get(session) || { rows: new Map() };
        table.rows.set(row.index, row);
        clearTimeout(table.timer);
        table.timer = setTimeout(() => postTable(session).catch(err => console.error('❌ [Results]', err.message)), TABLE_SETTLE_MS);
        tables.set(session, table);
    });
    socket.on('error', err => console.error(`❌ [Results] ${lobby.name}:`, err.message));

    // Connect without introducing ourselves (hidden).
    raw(['96', lobby.port, myId, '1', '0']);
    raw(['Join Server', '1', String(++seq)]);
    raw(['105', lobby.port, '1', String(++seq)]);

    const keepAlive = setInterval(() => {
        raw(['100', lobby.port, '0', '-1']);
        send('93', '3', [myId, '*20', '1']);
        send('94', '2', ['*21', myId]);
    }, KEEPALIVE_MS);

    const stop = () => {
        clearInterval(keepAlive);
        for (const t of tables.values()) clearTimeout(t.timer);
        try { raw(['95', lobby.port, myId, '1', String(++seq)]); } catch { /* socket closed */ }
        setTimeout(() => { try { socket.close(); } catch { /* already closed */ } }, 500);
        watching.delete(key);
        console.log(`🔕 [Results] Stopped listening to "${lobby.name}".`);
    };

    watching.set(key, { lobby, channelId, stop });
    console.log(`👂 [Results] Listening to "${lobby.name}" (${lobby.players} players).`);
}

// For /results: the lobby list, and manual listen/stop by "<host>|<lobbyId>".
// Remembered so /results listen can use the lobby picked in the autocomplete
// list without querying again (a query takes ~2.5 s, Discord allows 3 s).
const lastSeen = new Map(); // "<host>|<lobbyId>" -> lobby

async function listLobbies() {
    const { lobbies } = await fetchLobbies();
    lastSeen.clear();
    for (const l of lobbies) lastSeen.set(lobbyKey(l), l);
    return lobbies;
}

function seenLobby(key) {
    return lastSeen.get(key) || null;
}

function lobbyKey(lobby) {
    return `${lobby.host}|${lobby.port}`;
}

function isWatching(key) {
    return watching.has(key);
}

function listen(client, lobby) {
    const channelId = loadConfig().resultados?.canal_id;
    if (!channelId) throw new Error('Results channel not set (config "resultados.canal_id").');
    if (!watching.has(lobbyKey(lobby))) watch(client, lobby, channelId);
}

function stopListening(key) {
    const w = watching.get(key);
    if (!w) return false;
    w.stop();
    return true;
}

// Stops listening to lobbies that closed. No network while nothing is followed.
async function tick(client) {
    if (!watching.size) return;
    const live = new Set((await fetchLobbies()).lobbies.map(lobbyKey));
    for (const [key, w] of watching) {
        if (live.has(key)) continue;
        w.stop();
        const channel = await client.channels.fetch(w.channelId).catch(() => null);
        await channel?.send(`🔕 **${w.lobby.name}** closed, stopped listening.`).catch(() => { });
    }
}

function startResultsLoop(client) {
    setInterval(() => tick(client).catch(err => console.error('❌ [Results] Tick failed:', err.message)), TICK_MS);
}

module.exports = { startResultsLoop, buildCsv, listLobbies, seenLobby, lobbyKey, isWatching, listen, stopListening, watching };
