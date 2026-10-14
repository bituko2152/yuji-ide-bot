/*
 * Records what a race replay needs from the lobby traffic that
 * /results listen already receives. One recorder per watched lobby; every
 * new session (*33|1) starts a fresh recording, so when the race results
 * arrive the recording holds exactly that race.
 *
 * Messages used (server -> client, fields after the leading "*"):
 *   33|1|0|<class>|<class>|<laps>|<max>|..|..|<track index>|...   session start + settings
 *   33|2|<track 1>|<track 2>|...         championship tracks (Workshop id or official name)
 *   33|3|<idx>|<name>|<livery>|1|<racing 0/1>|<player id>|..|<quali>|<grid>|<ping>|..
 *   8|<car>|<frame>|<x>|<y>|<angle>|<vx>|<vy>                       car position, ~60/s
 *   37|1|<car>|<compound>                                          tyres
 *   13|<car>|<lap>|0|<sector>|<pit>|<pit>|...                       sectors, pit lane
 *   11|<car>|<lap time>|<total, 0 until finished>                  lap completed (the game's time)
 *   36|<gauge>|<change per frame>|<wetness>|...                     weather gauge
 *   39|spr_weather_<state>                                          forecast ("Coming soon")
 * Times are stored as the local receive time (ms); the builder turns them
 * into race frames.
 */

class RaceRecorder {
    constructor() {
        this.reset();
    }

    reset() {
        this.counts = {};        // message type -> how many (diagnostics)
        this.settings = null;    // { carClass, laps, trackIndex }
        this.tracks = [];        // championship list
        this.roster = [];        // drivers from *33|3
        this.cars = new Map();   // car number -> { frame: [], x: [], y: [], a: [], at: [] }
        this.tyres = [];         // { at, car, tyre }
        this.sectors = [];       // { at, car, pit }
        this.lapTimes = [];      // { at, car, time } every completed lap
        this.gauge = [];         // { at, v, d, w }
        this.forecast = [];      // { at, state }
        this.seen = new Set();   // reliable message ids (resends)
    }

    /** f = message fields without the leading "*"; msgId only for reliable messages. */
    onMessage(f, msgId, at = Date.now()) {
        if (msgId != null) {
            const key = `${f[0]}|${msgId}`;
            if (this.seen.has(key)) return;
            this.seen.add(key);
        }
        this.counts[f[0]] = (this.counts[f[0]] || 0) + 1;
        switch (f[0]) {
            case '8': {
                const car = Number(f[1]);
                let c = this.cars.get(car);
                if (!c) this.cars.set(car, (c = { frame: [], x: [], y: [], a: [], at: [] }));
                c.frame.push(Number(f[2])); c.x.push(Number(f[3])); c.y.push(Number(f[4])); c.a.push(Number(f[5])); c.at.push(at);
                break;
            }
            case '33':
                // Raw session messages, for the console (where does the game say the track?).
                if (f[1] !== '3') console.log(`🎬 [Replay] *${f.join('|').slice(0, 400)}`);
                // *33|1|1 is the copy sent to a driver joining mid-session: same session, keep recording.
                if (f[1] === '1' && f[2] !== '1') {
                    this.reset();
                    this.settings = { carClass: f[3], laps: Number(f[5]), qualiLaps: Number(f[9]), trackIndex: Number(f[9]), raw: f.slice(2, 14).join('|'),
                        // Any Workshop id in the settings (other than the class) could be the track.
                        workshopIds: f.slice(2).filter((v, i) => /^\d{9,11}$/.test(v) && v !== f[3]) };
                } else if (f[1] === '2') {
                    this.tracks = f.slice(2).filter(Boolean);
                } else if (f[1] === '3') {
                    this.roster.push({ idx: Number(f[2]), name: f[3], livery: Number(f[4]), racing: f[6] === '1', id: f[7], grid: Number(f[10]), ping: Number(f[11]) });
                }
                break;
            case '37':
                if (f[1] === '1') this.tyres.push({ at, car: Number(f[2]), tyre: String(f[3] || '')[0]?.toUpperCase() });
                break;
            case '13':
                this.sectors.push({ at, car: Number(f[1]), pit: f[5] === '1' || f[6] === '1' });
                break;
            case '11':
                this.lapTimes.push({ at, car: Number(f[1]), time: Number(f[2]) });
                break;
            case '36':
                this.gauge.push({ at, v: Number(f[1]), d: Number(f[2]), w: Number(f[3]) });
                break;
            case '39':
                if (/^spr_weather_/.test(f[1])) this.forecast.push({ at, state: f[1].slice(12) });
                break;
        }
    }

    /** The track being raced: Workshop id or official track name. */
    get track() {
        return this.settings ? this.tracks[this.settings.trackIndex] || null : null;
    }

    get hasRace() {
        return [...this.cars.values()].some(c => c.frame.length > 600);
    }

    /** Why there's no replay, in plain words (null if there's enough to build one). */
    whyNoReplay() {
        const samples = [...this.cars.values()].reduce((n, c) => n + c.frame.length, 0);
        if (!this.settings) {
            return samples
                ? 'the bot didn\'t see this session start (start /results listen before the race begins).'
                : 'the bot received no race data at all from the lobby.';
        }
        if (!samples) return 'the lobby didn\'t send the car positions to the bot.';
        if (!this.hasRace) return `too few car positions were received (${samples}).`;
        return null;
    }

    /** One line for the console: what the lobby sent this session. */
    summary() {
        const top = Object.entries(this.counts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t, n]) => `*${t}:${n}`).join(' ');
        return `settings=${this.settings ? this.settings.raw : 'no'} tracks=${this.tracks.join(',')} track=${this.track} cars=${this.cars.size} msgs ${top}`;
    }
}

module.exports = { RaceRecorder };
