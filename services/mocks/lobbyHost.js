const dgram = require('dgram');
const { createWeather } = require('./weather');

/*
 * Yuji hosts a UR2D2 lobby as a spectator (no car): creates it on the game's
 * master server, keeps it alive, handles people joining/leaving, and runs
 * qualifying and races (start, finish, result tables, back to the lobby).
 * Worked out from Marco's hosting captures (BotReports-Lab/network-tools)
 * and tested live in BotReports-Lab/mock-host.
 *
 * Client -> server: fields each ended by "\n\0".
 *   89 <hostId> 00server#<name> <class>#Ultimate Racing 2D 2#off#pc <max> 0 <laps> Lobby <pw> 1029 Europe 1 0   register
 *   91 <lobby> <n> <n fields...~> 1 <seq>   to everybody else      92  same, echoed back to us
 *   93 <lobby> <n> <targetId> ...           to one player          94  to the server
 *   99 <lobby> 0 -1                         keep-alive (3 s)       95 <lobby> <id> 1 <seq>  leave / close
 *   102 <lobby> 0 1 <Qualifying|Racing>     state in the list      104 <lobby> Lobby        back to lobby
 * Server -> client: "*a|b|c~|<reliable>|<msgId>|", reliable ones get "ack\n2\n<msgId>\n\0".
 *
 * Players report their own laps (*11 car|lap|total) and finish (*19
 * car|total|gap|best); the host only orchestrates and builds the tables.
 */

const SERVER = '64.226.118.45'; // Europe master server
const PORT = 6510;
const VERSION = '1029';
const HOST_NAME = 'Yuji Ide';

// Rest of the "*33|1" settings after class,class,laps, as the game sends them
// (Race settings screen): [0] players 20, [1] drivers racing (the game sends 2
// with two drivers; only that many get a car, the rest spectate), [3] qualifying
// laps (the game accepts more than its menu's 3), [4] qualifying visible, [8] race flag, ... rain 50%, tyres,
// collisions "same lap only", 60 s after the leader, "Lapped races", pit
// speed 0.85, medium +3 %, hard +1 %, slipstream x0 / 1.9 / 0.6 / 0.9 / 0.9.
const BASE_REST = ['20', '1', '1', '1', 'invisible', '0', '0', 'off', '0', '1', '1', '1', '1', 'off', '1', '2', '2', 'rain 50%',
    'soft/medium/hard', 'last', '0', '0', 'same lap only', '60', 'Lapped races', '300', 'off', 'same', 'on', 'on',
    '0.85', '3', '1', '0', '1.90', '0.60', '0.90', '0.90'];

// Formula A: AI line-up (the game always lists it, even with no AI racing) and the "*9" class info.
const AI = [
    ['L.Norris', 1, 1, 1], ['M.Verstappen', 3, 1, 2], ['C.Leclerc', 2, 1, 3], ['G.Russell', 4, 1, 4], ['F.Alonso', 5, 1, 5],
    ['A.Albon', 6, 1, 8], ['N.Hulkenberg', 7, 1, 7], ['Y.Tsunoda', 8, 1, 6], ['G.Zhou', 10, 1, 10], ['P.Gasly', 9, 1, 9],
    ['O.Piastri', 1, 2, 1], ['C.Sainz', 2, 2, 3], ['S.Perez', 3, 2, 2], ['L.Hamilton', 4, 2, 4], ['L.Stroll', 5, 2, 5],
    ['F.Colapinto', 6, 2, 8], ['K.Magnusen', 7, 2, 7], ['L.Lawson', 8, 2, 6], ['E.Ocon', 9, 2, 9], ['V.Bottas', 10, 2, 10]
].map(([n, team, seat, num], i) => ({ name: n, team, seat, num, points: (99 - i) / 1e8 }));
const CLASS_INFO = ['formulaa', 'same', 'McLaren', 'L.Norris', 'O.Piastri', '1', 'Scuderia Ferrari', 'C.Leclerc', 'C.Sainz', '3',
    'Red Bull Racing', 'M.Verstappen', 'S.Perez', '2', 'Mercedes', 'G.Russell', 'L.Hamilton', '4', 'Aston Martin', 'F.Alonso',
    'L.Stroll', '5', 'Williams', 'A.Albon', 'F.Colapinto', '8', 'Haas', 'N.Hulkenberg', 'K.Magnusen', '7', 'Visa Cash App RB',
    'Y.Tsunoda', 'L.Lawson', '6', 'Alpine', 'P.Gasly', 'E.Ocon', '9', 'Sauber Kick', 'G.Zhou', 'V.Bottas', '10',
    '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '1', '1', '2', '2', '3', '3', '4', '4', '5', '5', '6', '6', '7', '7', '8', '8',
    '9', '9', '10', '10', 'musclecarsb', 'sportsprototype2', 'touringcarsa2', 'motorbikes', 'formularetroa', 'combine',
    'karts85cc', 'touringcarsc', 'supercarsa', 'formula_volt', 'formula_speedway_new', 'minicars', 'sportscarsb',
    'formula_speedway_new', 'sports_prototype_c', 'formulaspeedway', 'formularetroa', 'supercarsa', '2991639976', 'gtclassb'];

// Car classes Yuji can host. "tag" is the field the game sends as 23 (Formula A)
// or 149 (FeS Retro) at the end of every driver row. classInfo = the "*9" sent
// to whoever joins (only captured for Formula A).
const FES_AI = ['L. Norris', 'G. Russell', 'C. Leclerc', 'M. Verstappen', 'A. Albon', 'L. Lawson', 'F. Alonso', 'O. Bearman',
    'N. Hulkenberg', 'P. Gasly', 'O. Piastri', 'K. Antonelli', 'I. Hadjar', 'L. Hamilton', 'C. Sainz', 'A. Lindblad', 'E. Ocon',
    'G. Bortoleto', 'F. Colapinto'];
const CLASSES = {
    formulaa: { key: 'formulaa', name: 'Formula A', tag: 23, ai: AI, classInfo: CLASS_INFO, rest: BASE_REST },
    // FeS Retro [Official] (Workshop 3805310984), from Marco's capture COVHE.pcapng.
    '3805310984': {
        key: '3805310984', name: 'FeS Retro [Official]', tag: 149, classInfo: null,
        ai: FES_AI.map((n, i) => ({ name: n, team: i < 10 ? i + 1 : [1, 2, 3, 4, 5, 6, 8, 9, 10][i - 10], seat: i < 10 ? 1 : 2,
            num: i < 10 ? i + 1 : [1, 2, 3, 4, 5, 6, 8, 9, 10][i - 10], points: (99 - i) / 1e8 })),
        rest: ['20', '1', '1', '1', 'invisible', '0', '0', 'off', '0', '1', '1', '1', '1', 'off', '1', '1', '1', 'rain 50%',
            'soft/medium/hard', 'last', '0', '0', 'same lap only', '60', 'Lapped races', '300', 'off', 'same', 'on', 'off',
            '0.85', '3', '1', '0', '1.90', '0.60', '0.90', '0.90']
    }
};

const SESSION_NAMES = { 2: 'Qualifying', 3: 'Racing' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pts = v => v.toFixed(10);
const t2 = v => (v == null ? null : v.toFixed(2));
const rnd = () => Math.floor(100000 + Math.random() * 900000);

/**
 * @param {{name: string, password?: string, track?: string, laps?: number, log?: Function}} opts
 * @returns host with: ready (Promise<lobbyId>), players, racers(), qualifying(), race(laps), say(text), close()
 */
function createLobbyHost({ name, password = '', carClass = 'formulaa', className, track = 'italy', laps = 3, qualiLaps = 3, log = console.log }) {
    // Another Workshop class (by id): same messages as FeS Retro with its id.
    // Only Formula A and FeS Retro are tested in the game.
    let cls = CLASSES[carClass];
    if (!cls && /^\d+$/.test(String(carClass))) {
        cls = { ...CLASSES['3805310984'], key: String(carClass), name: className || String(carClass) };
        log(`⚠️ [Mocks] Car class ${carClass} isn't tested: using the FeS Retro settings with its id.`);
    }
    if (!cls) throw new Error(`Unknown car class ${carClass}`);
    if (className) cls = { ...cls, name: className };
    const AI = cls.ai;
    const TAG = cls.tag;
    const hostId = `${rnd()}/${rnd()}/${rnd()}:${Math.random().toString(36).slice(2, 5)}`;
    const settings = { carClass: cls.key, className: cls.name, track, laps, qualiLaps, rain: 0 };
    const players = [{ id: hostId, name: HOST_NAME, team: 8, num: 6, ping: 50, racing: 0, spectator: true, points: 0.1, flag: '0' }];
    const byId = id => players.find(p => p.id === id);
    const racers = () => players.filter(p => p.id !== hostId && !p.spectator);

    const socket = dgram.createSocket('udp4');
    const pending = new Map();
    const seenIn = new Set();
    const timers = [];
    let lobby = null, seq = 0, closed = false;
    let session = null, lastQuali = null, lastResults = null;

    const encode = fields => Buffer.from(fields.map(f => `${f}\n\0`).join(''), 'utf-8');
    const raw = fields => { if (!closed) socket.send(encode(fields), PORT, SERVER); };
    // Reliable: resent every second until the server acks it.
    function reliable(fields) {
        const s = ++seq;
        const buf = encode([...fields, '1', String(s)]);
        const entry = { tries: 0 };
        const fire = () => {
            if (closed || ++entry.tries > 15) return pending.delete(s);
            socket.send(buf, PORT, SERVER);
            entry.timer = setTimeout(fire, 1000);
        };
        pending.set(s, entry);
        fire();
    }
    function msg(type, payload) {
        const p = payload.map(String);
        p[p.length - 1] += '~';
        reliable([type, lobby, String(p.length), ...p]);
    }
    const toAll = (...p) => msg('91', p);
    const toOne = (id, ...p) => msg('93', [id, ...p]);

    const settingsFields = (n = 1) => {
        const r = [...cls.rest];
        // Drivers with a car: the session's grid, or (in the lobby) whoever isn't spectating.
        // Yuji doesn't count: counting him added a phantom car.
        r[1] = String(Math.max(1, session ? session.grid.length : racers().length));
        r[3] = String(settings.qualiLaps);
        r[8] = n === 3 ? '1' : '0';
        r[17] = `rain ${settings.rain}%`;
        // League settings: pit speed x0.85, medium +3 %, hard +1 %, slipstream
        // amount x0 / length x0.3 / width x0.8 / increase x0.1 / decrease x0.5.
        r.splice(30, 8, '0.85', '3', '1', '0', '0.30', '0.80', '0.10', '0.50');
        return [settings.carClass, settings.carClass, String(settings.laps), ...r];
    };

    // ------------------------------------------------------------ lobby

    function sendRoster() {
        for (let i = 0; i < 20; i++) {
            const p = players[i];
            // The field before 23 is "spectating".
            const row = p ? [p.name, p.team, 1, pts(p.points), 1, p.id, p.num, p.racing, p.ping, p.spectator ? 1 : 0, TAG, p.flag]
                : ['0', '0', '0', '-1.0000000000', '0', '0', '0', '0', '0', '0', '0', '0'];
            toAll('*31', 1, 1, i, ...row);
        }
        toAll('*31', 2, 1, '');
    }

    function sendSettings() {
        toAll('*33', 1, 0, ...settingsFields());
        toAll('*33', 2, settings.track, '');
    }

    // Full state for a player who just joined.
    function sendWelcome(id) {
        toOne(id, '*12', hostId);
        toOne(id, '*30', 1, ...settingsFields());
        toOne(id, '*30', 2, settings.track, '');
        const standings = [...players.map(p => ({ ...p, isHuman: true })), ...AI].sort((a, b) => b.points - a.points);
        for (let i = 0; i < 20; i++) {
            const p = players[i];
            const human = p ? [p.name, p.team, 1, pts(p.points), 1, p.id, p.num, '1000000.00000', 0, p.ping, p.spectator ? 1 : 0, TAG]
                : ['0', '0', '0', '-1.0000000000', '0', '0', '0', '0.00000', '0', '0', '0', '0'];
            const ai = AI[i] || AI[0];
            const s = standings[i];
            toOne(id, '*30', 3, i, ...human,
                ai.name, ai.team, ai.seat, pts(ai.points), 0, i + 1, ai.num, TAG,
                s.name, s.team, 1, s.isHuman ? s.points.toFixed(2) : '0.00', '1000000.00000', '1000000', '1000000', '');
        }
        toOne(id, '*30', 4, ...Array.from({ length: 10 }, (_, k) => [k + 1, '0.00']).flat(), '');
        if (cls.classInfo) toOne(id, '*9', ...cls.classInfo, '');
        msg('92', ['*42', hostId, '1']); // Yuji is a spectator
    }

    // ------------------------------------------------------------ sessions

    // Grid like the game: drivers, then the host (not racing), then the AI rows (not racing).
    // `to`: a player id = only to that player (someone pressing Ready mid-session:
    // the game's send_race_start_to_other with "1" first, then they spectate).
    function sendGrid(n, to = null) {
        const send = (...p) => (to ? toOne(to, ...p) : toAll(...p));
        send('*33', 1, to ? 1 : 0, ...settingsFields(n));
        send('*33', 2, settings.track, '');
        const h = players[0];
        for (let i = 0; i < 20; i++) {
            const p = session.grid[i];
            if (p) send('*33', 3, i, p.name, p.team, 1, 1, p.id, p.num, p.sortKey, i + 1, p.ping, TAG, '');
            else if (i === session.grid.length) send('*33', 3, i, h.name, h.team, 1, 0, h.id, h.num, (10000000 + (i + 1) / 1e5).toFixed(5), i + 1, h.ping, TAG, '');
            else {
                const k = i - session.grid.length - 1;
                const ai = AI[k] || AI[0];
                send('*33', 3, i, ai.name, ai.team, ai.seat, 0, k + 1, ai.num, (100000000 + (i + 1) / 1e5).toFixed(5), i + 1, 50, TAG, '');
            }
        }
        if (!to) msg('94', ['*3', '1']);
    }

    /** Runs qualifying (n=2) or a race (n=3); resolves with the results when it's over (null if nobody raced). */
    async function runSession(n) {
        if (session) throw new Error('A session is already running');
        const list = racers();
        if (!list.length) return null;
        // Grid: qualifying = join order; race = by qualifying time (no time = back).
        const order = n === 3 && lastQuali ? [...list].sort((a, b) => (lastQuali.get(a.id) ?? 1e9) - (lastQuali.get(b.id) ?? 1e9)) : list;
        const grid = order.map((p, i) => ({ ...p, sortKey: n === 3 && lastQuali?.get(p.id) != null
            ? (lastQuali.get(p.id) + (i + 1) / 1e5).toFixed(5) : (1000000 + (i + 1) / 1e5).toFixed(5) }));
        let done;
        session = { n, grid, cars: new Map(), loaded: new Set(), ended: false, done: new Promise(r => { done = r; }) };
        session.resolve = done;
        log(`🏁 [Mocks] ${SESSION_NAMES[n]}: ${order.map(p => p.name).join(', ')}`);

        sendGrid(n);
        await sleep(500);
        // Weather: races with a rain chance run the game's own weather (weather.js),
        // started at the green light; dry sessions (qualifying, 0 %) are set clear.
        const dry = n !== 3 || !settings.rain;
        session.weather = dry ? null : createWeather(settings.rain, (...f) => toAll(...f));
        if (dry) { toAll('*36', 0, 0, 0, -1); toAll('*39', 'spr_weather_clear'); }
        else session.weather.startMessages();
        msg('94', ['*15', '0', hostId]); // loaded as a spectator ("1" would add a car)
        toAll('*7', hostId, 0, 1);
        reliable(['102', lobby, '0', '1', SESSION_NAMES[n]]);
        toAll('*25', 1);

        // Everybody loaded (or 45 s), then the start.
        const t0 = Date.now();
        while (Date.now() - t0 < 45000 && list.some(p => !session.loaded.has(p.id))) await sleep(250);
        msg('92', ['*16', '1']);
        toAll('*7', hostId, 0, 1);
        if (dry) toAll('*39', 'spr_weather_clear');
        else session.weather.forecastAgain();
        await sleep(4100);
        toAll('*38', 1);
        session.weather?.start();
        // Safety net if nobody finishes (qualifying normally ends 15 s after the first finisher).
        session.timer = setTimeout(() => endSession('timeout'), (n === 2 ? 10 : 15 + settings.laps * 2) * 60000);
        return session.done;
    }

    function firstFinisher() {
        if (!session || session.finishTimer) return;
        // As in the league: the race ends 60 s after the leader, qualifying 8 s after the first finisher.
        const wait = session.n === 3 ? 60000 : 8000;
        // The finisher's game sends *18|1 ("someone finished": everybody's countdown starts)
        // to the host; the host passes it on to everybody, once per session.
        if (!session.countdownSent) { session.countdownSent = true; msg('92', ['*18', '1']); }
        session.finishTimer = setTimeout(() => endSession('time after first finisher'), wait);
    }

    // Never throws: it runs from timers and message handlers, where an error would end the process.
    function endSession(why) {
        return finishSession(why).catch(err => log(`⚠️ [Mocks] Ending the session failed: ${err.message}`));
    }

    async function finishSession(why) {
        if (!session || session.ended) return;
        const s = session;
        s.ended = true;
        clearTimeout(s.timer);
        clearTimeout(s.finishTimer);
        s.weather?.stop();
        msg('92', ['*18', '1']);
        await sleep(1000); // finishing times still on their way
        const results = sendResults(s);
        reliable(['104', lobby, 'Lobby']);
        toAll('*25', 1);
        if (s.n === 2) lastQuali = new Map(s.grid.map((p, i) => [p.id, s.cars.get(i + 1)?.best ?? null]).filter(([, t]) => t));
        session = null;
        for (const d of [700, 3700, 8700]) timers.push(setTimeout(() => lastResults && lastResults(), d)); // the game resends them
        log(`🏁 [Mocks] ${SESSION_NAMES[s.n]} over (${why}): ${results.map((r, i) => `${i + 1}. ${r.name}`).join(', ') || 'no times'}`);
        s.resolve(results);
    }

    function sendResults(s) {
        const isRace = s.n === 3;
        const rows = s.grid.map((p, i) => ({ p, c: s.cars.get(i + 1) || {} }))
            .filter(r => r.c.laps > 0); // a spectator still sends "finished 0"
        const order = rows.sort(isRace
            ? (a, b) => (b.c.laps || 0) - (a.c.laps || 0) || (a.c.total ?? 1e9) - (b.c.total ?? 1e9)
            : (a, b) => (a.c.best ?? 1e9) - (b.c.best ?? 1e9));
        const send = () => {
            toAll('*3', 1, s.n, 0, isRace ? 2 : 1, isRace ? 1 : 0, '');
            for (let i = 0; i < 20; i++) {
                const p = players[i]; // the lobby list (Yuji included, or he vanishes from it)
                const a = p ? [p.name, pts(p.points), 1, p.id, p.num, p.racing, p.ping, p.spectator ? 1 : 0, TAG] : ['0', '-1.0000000000', 0, 0, 0, 0, 0, 0, 0];
                const ai = AI[i] || AI[0];
                const b = [ai.name, pts(ai.points), 0, i + 1, ai.num, TAG];
                const r = order[i];
                let c;
                if (r) {
                    const q = isRace ? (lastQuali?.get(r.p.id) ?? 1000000) : r.c.best;
                    c = [r.p.name, r.p.team, pts(r.p.points), 1, r.p.id, r.p.num, t2(q) ?? '1000000.00',
                        isRace ? s.grid.findIndex(g => g.id === r.p.id) + 1 : i + 1,
                        isRace ? (t2(r.c.total) ?? '1000000') : '1000000', t2(r.c.best) ?? '1000000', TAG];
                } else if (i === order.length) {
                    // As the game does: the spectating host after the drivers (not a driver: 0), then the AI.
                    const h = players[0];
                    c = [h.name, h.team, pts(h.points), 0, h.id, h.num, '10000000.00', i + 1, '100000000', '1000000', TAG];
                } else {
                    const x = AI[i - order.length - 1] || AI[0];
                    c = [x.name, x.team, '-1.0000000000', 0, i - order.length, x.num, '100000000.00', i + 1, '100000000', '1000000', TAG];
                }
                toAll('*3', 2, s.n, i, ...a, ...b, ...c, '');
            }
            toAll('*3', 3, s.n, 0, ...Array.from({ length: 10 }, (_, k) => [k + 1, '0.00']).flat(), '');
        };
        lastResults = send;
        send();
        return order.map(r => ({ name: r.p.name, laps: r.c.laps || 0, total: r.c.total ?? null, best: r.c.best ?? null }));
    }

    // ------------------------------------------------------------ incoming

    function onMessage(f) {
        switch (f[0]) {
            case '1': { // join: *1|id|name|team|ping|...
                const [, id, pname, team, ping] = f;
                if (byId(id)) return;
                players.push({ id, name: pname, team: Number(team), num: Number(team), ping: Number(ping), racing: 0,
                    points: 0.1 - players.length * 0.001, flag: 'class:1/track:1' });
                log(`➕ [Mocks] ${pname} joined`);
                // As the game's host: the session settings (*33) only go to everybody when a
                // session starts. Sent on a join or leave mid-race, every game takes them as a
                // new session ("race finished", crashes); the newcomer gets theirs in *30.
                sendWelcome(id);
                sendRoster();
                toAll('*28', 1, pname);
                break;
            }
            case '4': { // left
                const p = byId(f[1]);
                if (!p) return;
                players.splice(players.indexOf(p), 1);
                log(`➖ [Mocks] ${p.name} left`);
                // Everybody of the session's grid gone: end it now (else it waits for the safety timeout).
                if (session && !session.grid.some(g => byId(g.id))) endSession('everybody left');
                sendRoster();
                toAll('*28', 2, p.name);
                break;
            }
            case '2': { const p = byId(f[1]); if (p) { p.num = Number(f[2]); sendRoster(); } break; }
            case '5': { const p = byId(f[2]); if (p) { p.racing = Number(f[3]); sendRoster(); } break; }
            case '3': { // *3|2|id: pressed Ready; mid-session they get the session and spectate it
                if (f[1] !== '2' || !session) break;
                const p = byId(f[2]);
                if (p && p.id !== hostId && !session.grid.some(g => g.id === p.id)) {
                    log(`👀 [Mocks] ${p.name} joins the running ${SESSION_NAMES[session.n]} as a spectator`);
                    sendGrid(session.n, p.id);
                }
                break;
            }
            case '18': { // *18|1 from the first finisher's game: start everybody's countdown
                if (session && f[1] === '1') firstFinisher();
                break;
            }
            case '29': { const p = byId(f[1]); if (p) p.ping = Number(f[2]); break; }
            // Content check: *47|1|id|class:0/track:1 (0 = that driver doesn't have the
            // Workshop car / track). Shown in the lobby list like the game does.
            case '47': { const p = byId(f[2]); if (p && f[3]) { p.flag = f[3]; sendRoster(); log(`📦 [Mocks] ${p.name}: ${f[3]}`); } break; }
            case '42': { const p = byId(f[1]); if (p && p.id !== hostId) { p.spectator = f[2] === '1'; sendRoster(); } break; }
            case '15': if (session) session.loaded.add(f[2]); break;
            case '11': { // lap: *11|car|lap|total
                if (!session) break;
                const car = session.cars.get(Number(f[1])) || { laps: 0 };
                car.laps++;
                car.best = Math.min(car.best ?? Infinity, Number(f[2]));
                if (Number(f[3]) > 0) car.total = Number(f[3]);
                session.cars.set(Number(f[1]), car);
                // Race: the first car to complete every lap starts the 60 s for the rest
                // (a player's own *18 can come before the last lap, so it's ignored).
                if (session.n === 3 && car.laps >= settings.laps) firstFinisher();
                break;
            }
            case '19': { // finished: *19|car|total|gap|best
                if (!session) break;
                const car = session.cars.get(Number(f[1])) || { laps: 0 };
                Object.assign(car, { finished: true, total: Number(f[2]), best: Number(f[4]) || car.best });
                session.cars.set(Number(f[1]), car);
                if (session.grid.every((p, i) => session.cars.get(i + 1)?.finished)) endSession('all finished');
                else firstFinisher();
                break;
            }
            default: break;
        }
    }

    let readyResolve, readyReject;
    const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });

    socket.on('message', buf => {
        const text = buf.toString('utf-8');
        const ack = text.match(/^ack\|2\|(\d+)\|/);
        if (ack) {
            const p = pending.get(Number(ack[1]));
            if (p) { clearTimeout(p.timer); pending.delete(Number(ack[1])); }
            return;
        }
        const m = text.match(/^\*(.*)~\|(\d)\|(-?\d+)\|/s);
        if (!m) return;
        if (m[2] === '1') {
            socket.send(Buffer.from(`ack\n2\n${m[3]}\n\0`, 'latin1'), PORT, SERVER);
            if (seenIn.has(m[3])) return;
            seenIn.add(m[3]);
        }
        const f = m[1].replace(/\|$/, '').split('|');
        if (f[0] === 'Registered') {
            if (lobby) return;
            lobby = f[2];
            sendSettings();
            msg('92', ['*42', hostId, '1']);
            let clock = 100000;
            timers.push(setInterval(() => { raw(['99', lobby, '0', '-1']); toOne(hostId, '*20', 1); }, 3000));
            timers.push(setInterval(() => { clock += 2000; toOne(hostId, '*17', clock); }, 2000));
            readyResolve(lobby);
            return;
        }
        // A bad or unexpected message (e.g. someone leaving at an odd moment) must never take the lobby down.
        try {
            onMessage(f);
        } catch (err) {
            log(`⚠️ [Mocks] Message *${f[0]} failed: ${err.message}`);
        }
    });
    socket.on('error', err => log(`❌ [Mocks] Socket: ${err.message}`));

    const register = () => raw(['89', hostId, `00server#${name}`, `${settings.className}#Ultimate Racing 2D 2#off#pc`, '20', '0',
        String(settings.laps), 'Lobby', password, VERSION, 'Europe', '1', '0']);
    socket.bind(() => {
        register();
        let tries = 0;
        const retry = setInterval(() => {
            if (lobby) return clearInterval(retry);
            if (++tries > 10) { clearInterval(retry); readyReject(new Error('The game server did not register the lobby')); return; }
            register();
        }, 3000);
        timers.push(retry);
    });

    return {
        ready,
        get lobbyId() { return lobby; },
        get players() { return players.filter(p => p.id !== hostId); },
        racers,
        qualifying: () => runSession(2),
        /** rain: the chance in % (0 = dry). */
        race: (raceLaps, rain = 0) => { settings.laps = raceLaps; settings.rain = rain; sendSettings(); return runSession(3); },
        say: text => toAll('*6', hostId, HOST_NAME, text),
        /** Ends the session now (results with what was done so far), back to the lobby. */
        endSession: () => endSession('ended by hand'),
        close() {
            if (closed) return;
            session?.weather?.stop();
            if (lobby) raw(['95', lobby, hostId, '1', String(++seq)]);
            closed = true;
            for (const t of timers) { clearTimeout(t); clearInterval(t); }
            for (const p of pending.values()) clearTimeout(p.timer);
            setTimeout(() => { try { socket.close(); } catch { /* already closed */ } }, 300);
        }
    };
}

module.exports = { createLobbyHost };
