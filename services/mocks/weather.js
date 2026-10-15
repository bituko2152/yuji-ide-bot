/*
 * The game's own weather, as its host runs it (obj_rain_particle in the game
 * code: Create, Step, Alarm 0 / 1 / 3), so a Yuji-hosted race rains the way a
 * player-hosted one does. Everything counts in game frames (60 a second).
 *
 *   indicator  0-100: the weather. >= 66 it rains (and the track gets wet), the
 *              forecast icon is clear < 33 <= cloud < 66 <= light rain < 83 <= heavy rain.
 *   rate       what the indicator changes by every frame (a "trend").
 *   track      0-100: how wet the track is.
 *
 * Cycle once the race starts: a trend runs for its frames, then stops
 * (*36 indicator|0|track|-1), the next one is picked and its forecast sent
 * (*39 spr_weather_<icon>, only when the icon changes), and 300-900 frames
 * later it starts (*36 indicator|rate|track|frames).
 */

const RAIN_FROM = 66;                // indicator from which it rains
const random = n => Math.random() * n;
const randomRange = (a, b) => a + Math.random() * (b - a);
const irandom = n => Math.floor(Math.random() * (n + 1));
const clamp = v => Math.min(100, Math.max(0, v));
// linear_function(x1, x2, y1, y2): the line through (x1, y1) and (x2, y2)
const line = (x1, x2, y1, y2) => x => y1 + (y2 - y1) * (x - x1) / (x2 - x1);

const trackMax = line(RAIN_FROM, 90, 15, 100);       // how wet the track can get, by indicator
const trackAdd = line(RAIN_FROM, 100, 0.015, 0.03);  // wetting per frame while it rains
const trackDry = line(0, RAIN_FROM, 0.015, 0.012);   // drying per frame while it doesn't

const icon = v => (v < 33 ? 'clear' : v < 66 ? 'cloud' : v < 83 ? 'lightrain' : 'heavyrain');
const pace = () => randomRange(0.0125, 0.05);

// A new trend: up, down or still, with each setting's odds (Alarm_3).
function nextRate(chance, current) {
    if (chance === 50) return irandom(1) === 0 ? pace() : -pace();
    if (chance === 25) return irandom(11) <= 3 ? pace() : -pace();
    if (chance === 10) {
        const m = irandom(16);
        return m <= 2 ? pace() : m > 10 ? 0 : -pace();
    }
    return current; // 100 %: stays as it is
}

// The game sends reals with 2 decimals (GML string()).
const num = v => (Number.isInteger(v) ? String(v) : v.toFixed(2));

/**
 * chance: the race's rain setting (10, 25, 50, 100). send(...fields) broadcasts a message.
 * Returns { startMessages(), start(), stop() }.
 */
function createWeather(chance, send) {
    // ---- Session start (Create)
    let indicator, rate = 0, track = 0;
    if (chance >= 100) {
        indicator = 100; track = 100;
    } else {
        if (chance === 50) indicator = random(100);
        else if (chance === 25) indicator = random(100) < 66 ? random(65) : random(100);
        else indicator = random(100) >= 93 ? randomRange(66, 100) : random(65);

        if (indicator >= RAIN_FROM) track = random(100);
        else if (random(100) >= (chance === 10 ? 94 : 80)) track = randomRange(20, 100);

        if (chance === 50) { const m = irandom(2); rate = m === 1 ? pace() : m === 2 ? -pace() : 0; }
        else if (chance === 25) { const m = irandom(3); rate = m === 1 ? pace() : m === 2 ? -pace() : 0; }
        else { const m = irandom(16); rate = m <= 2 ? pace() : m > 10 ? 0 : -pace(); }
    }
    const firstFrames = randomRange(750, 1500);
    let shownIcon = icon(clamp(indicator + rate * firstFrames));

    let timer = null, frame = 0, startedAt = 0, nextRateValue = 0, nextFrames = 0;

    // Step: one game frame of weather.
    function step() {
        if (indicator >= RAIN_FROM) {
            if (track < Math.min(100, Math.max(15, trackMax(indicator)))) track += trackAdd(indicator);
        } else {
            track -= trackDry(indicator) * (track > 50 ? 1.5 : 0.9);
        }
        track = clamp(track);
        indicator = clamp(indicator + rate);
    }
    // Runs the frames up to now (timers are not frame-exact; the game counts frames).
    function catchUp() {
        const now = Math.floor((Date.now() - startedAt) * 60 / 1000);
        while (frame < now) { step(); frame++; }
    }
    const at = (frames, fn) => {
        clearTimeout(timer);
        timer = setTimeout(() => { catchUp(); fn(); }, Math.max(0, startedAt + (frame + frames) * 1000 / 60 - Date.now()));
    };

    // Alarm_0: the trend ends, next frame a new one is picked.
    function trendEnds() {
        rate = 0;
        send('*36', num(indicator), '0', num(track), '-1');
        at(1, pickNext);
    }
    // Alarm_3: next trend and its forecast; it starts 300-900 frames later.
    function pickNext() {
        nextRateValue = nextRate(chance, rate);
        nextFrames = randomRange(750, 1500);
        const forecast = icon(clamp(indicator + nextRateValue * nextFrames));
        if (forecast !== shownIcon) {
            shownIcon = forecast;
            send('*39', `spr_weather_${forecast}`);
        }
        at(randomRange(300, 900), trendStarts);
    }
    // Alarm_1: the trend starts.
    function trendStarts() {
        rate = nextRateValue;
        send('*36', num(indicator), num(rate), num(track), num(nextFrames));
        at(nextFrames, trendEnds);
    }

    return {
        /** Sent when the session loads, before the start (*36 state, *39 forecast). */
        startMessages() {
            send('*36', num(indicator), num(rate), num(track), num(firstFrames));
            send('*39', `spr_weather_${shownIcon}`);
        },
        /** The forecast again, as the game does just before the start. */
        forecastAgain() { send('*39', `spr_weather_${shownIcon}`); },
        /** At the green light: the weather starts moving. */
        start() {
            startedAt = Date.now();
            frame = 0;
            if (chance < 100) at(firstFrames, trendEnds);
        },
        stop() { clearTimeout(timer); timer = null; },
        get state() { return { indicator, rate, track }; }
    };
}

module.exports = { createWeather };
