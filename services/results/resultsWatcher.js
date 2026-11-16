const { readConfig } = require('../core/config');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const { AttachmentBuilder } = require('discord.js');
const { fetchLobbies } = require('../steam/lobbyService');
const { RaceRecorder } = require('../replay/recorder');
const { buildReplayData } = require('../replay/builder');
const { renderReplay } = require('../replay/render');

/*
 * League results: /results listen follows an online lobby and posts each
 * qualifying / race table as a CSV (human drivers only) to config
 * "results.channel", each followed by its replay, until the lobby closes
 * or /results stop. A session that ends without results (lobby closed,
 * /results stop, the host restarting it) still gets a provisional CSV from
 * the laps the bot saw, and its replay.
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
    return readConfig();
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

// A session that never sent its results: the classification from the laps
// recorded. Race: finishers by time, then most laps, then who completed that
// lap first. Qualifying: best lap. Same columns as the game's tables (plus laps).
function partialCsv(recorder, isRace) {
    const humans = recorder.roster.filter(d => d.id?.includes(':'));
    const rows = humans.map(d => {
        const laps = recorder.lapTimes.filter(e => e.car === d.idx + 1 && e.time > 0);
        const finish = laps.find(e => e.total > 0);
        const best = laps.length ? Math.min(...laps.map(e => e.time)) : null;
        return { name: d.name, grid: d.grid, laps: laps.length, best, total: finish?.total || null, lastAt: laps.at(-1)?.at ?? Infinity };
    }).filter(r => r.laps);
    if (!rows.length) return null;

    const ms = s => (s == null ? '' : Math.round(s * 1000));
    const cell = v => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    let header, lines;
    if (isRace) {
        rows.sort((a, b) => (a.total && b.total ? a.total - b.total : a.total ? -1 : b.total ? 1 : 0)
            || b.laps - a.laps || a.lastAt - b.lastAt);
        const winner = rows[0].total;
        const fastest = Math.min(...rows.map(r => r.best));
        header = ['position', 'driver', 'grid', 'quali_time_ms', 'race_time_ms', 'gap_ms', 'best_lap_ms', 'fastest_lap', 'dnf', 'laps'];
        lines = rows.map((r, i) => [i + 1, r.name, r.grid || '', '', ms(r.total), r.total && winner ? ms(r.total - winner) : '',
            ms(r.best), r.best === fastest, false, r.laps]);
    } else {
        rows.sort((a, b) => a.best - b.best);
        header = ['position', 'driver', 'quali_time_ms', 'gap_ms', 'laps'];
        lines = rows.map((r, i) => [i + 1, r.name, ms(r.best), i ? ms(r.best - rows[0].best) : 0, r.laps]);
    }
    return { csv: [header, ...lines].map(l => l.map(cell).join(',')).join('\n') + '\n', laps: Math.max(...rows.map(r => r.laps)) };
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
    const recorder = new RaceRecorder(); // positions, tyres, pits, weather for the replay
    let seq = 0;
    let lastPosted = null;      // 'qualifying' | 'race': the session that just got its results
    let sessionDone = false;    // this session's results were posted

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
        // The replay data is taken now, before any await: the next session's
        // settings (*33|1) start a new recording.
        const what = isRace ? 'race' : 'qualifying';
        const replay = takeReplay(what);
        lastPosted = what;
        sessionDone = true;

        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel) return console.warn(`⚠️ [Results] Channel ${channelId} not found.`);

        const base = lobby.name.replace(/[^\w-]+/g, '_');
        const fileName = `${base}_${isRace ? 'race' : 'qualifying'}.csv`;
        await channel.send({ files: [new AttachmentBuilder(Buffer.from(csv, 'utf-8'), { name: fileName })] })
            .catch(err => console.error('❌ [Results]', err.message));
        // The replay goes in its own message right after the CSV (which is left untouched).
        const msg = await channel.send(`🎬 Generating the ${what} replay…`).catch(err => console.error('❌ [Results]', err.message));
        if (msg) await attachReplay(msg, base, what, replay);
    }

    function takeReplay(what) {
        try {
            console.log(`🎬 [Replay] ${lobby.name} (${what}): ${recorder.summary()}`);
            const why = recorder.whyNoReplay();
            return { why, data: why ? null : buildReplayData(recorder, { qualifying: what === 'qualifying' }) };
        } catch (error) {
            return { error };
        }
    }

    // The session running now ended without results: post what was recorded.
    // Which one it is: a race after a qualifying, otherwise a qualifying.
    async function postPartial(reason) {
        if (sessionDone || !recorder.settings || tables.size) return;
        sessionDone = true;
        const isRace = lastPosted === 'qualifying';
        const what = isRace ? 'race' : 'qualifying';
        const partial = partialCsv(recorder, isRace);
        if (!partial) return;
        const replay = takeReplay(what); // before any await: a new session resets the recording
        lastPosted = what;
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel) return;
        const base = lobby.name.replace(/[^\w-]+/g, '_');
        const total = isRace && recorder.settings.laps ? `/${recorder.settings.laps}` : '';
        console.log(`⚠️ [Results] ${lobby.name}: ${what} ended without results (${reason}), provisional CSV after lap ${partial.laps}${total}.`);
        await channel.send({
            content: `⚠️ **${lobby.name}**: the ${what} ended without results (${reason}). Provisional classification after lap ${partial.laps}${total}, from the laps the bot saw.`,
            files: [new AttachmentBuilder(Buffer.from(partial.csv, 'utf-8'), { name: `${base}_${what}_provisional.csv` })]
        }).catch(err => console.error('❌ [Results]', err.message));
        const msg = await channel.send(`🎬 Generating the ${what} replay…`).catch(err => console.error('❌ [Results]', err.message));
        if (msg) await attachReplay(msg, base, what, replay);
    }

    async function attachReplay(msg, base, what, { why, data, error }) {
        try {
            if (error) throw error;
            if (!data) return void await msg.edit({ content: `⚠️ No replay: ${why || 'couldn\'t find a full lap in the recording.'}` });
            const { html, trackName } = await renderReplay(data, { lobbyName: lobby.name });
            const plain = trackName.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '_');
            const name = `${base}_${plain}_${what}_replay.html`;
            await msg.edit({ content: '', files: [new AttachmentBuilder(Buffer.from(html, 'utf-8'), { name })] });
        } catch (err) {
            console.error('❌ [Results] Replay:', err);
            await msg.edit({ content: `⚠️ Couldn't create the replay: ${err.message}` }).catch(() => { });
        }
    }

    socket.on('message', msg => {
        const m = msg.toString('utf-8').match(/^\*(.*)~\|(\d)\|(-?\d+)\|$/s);
        if (!m) return;
        if (m[2] === '1') socket.send(Buffer.from(`ack\n2\n${m[3]}\n\0`, 'latin1'), PORT, lobby.host);

        const f = m[1].replace(/\|$/, '').split('|');
        // A new session (not the copy sent to someone joining): the previous one,
        // if it never sent results (host restarted it), is posted as it was.
        if (f[0] === '33' && f[1] === '1' && f[2] !== '1') {
            postPartial('the session was restarted').catch(err => console.error('❌ [Results]', err.message));
            sessionDone = false;
        }
        recorder.onMessage(f, m[2] === '1' ? m[3] : null);
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

    // reason: posts what the current session has so far (null on shutdown: no time to).
    const stop = async reason => {
        if (reason) await postPartial(reason).catch(err => console.error('❌ [Results]', err.message));
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
    const channelId = loadConfig().results?.channel;
    if (!channelId) throw new Error('Results channel not set (config "results.channel").');
    if (!watching.has(lobbyKey(lobby))) watch(client, lobby, channelId);
}

function stopListening(key) {
    const w = watching.get(key);
    if (!w) return false;
    w.stop('/results stop');
    return true;
}

// Stops listening to lobbies that closed. No network while nothing is followed.
async function tick(client) {
    if (!watching.size) return;
    const live = new Set((await fetchLobbies()).lobbies.map(lobbyKey));
    for (const [key, w] of watching) {
        if (live.has(key)) continue;
        await w.stop('the lobby closed');
        const channel = await client.channels.fetch(w.channelId).catch(() => null);
        await channel?.send(`🔕 **${w.lobby.name}** closed, stopped listening.`).catch(() => { });
    }
}

// Leave every lobby (on shutdown/restart), so no ghost connection is left behind.
function stopAll() {
    for (const w of [...watching.values()]) w.stop();
}

function startResultsLoop(client) {
    setInterval(() => tick(client).catch(err => console.error('❌ [Results] Tick failed:', err.message)), TICK_MS);
}

module.exports = { startResultsLoop, stopAll, buildCsv, partialCsv, listLobbies, seenLobby, lobbyKey, isWatching, listen, stopListening, watching };
