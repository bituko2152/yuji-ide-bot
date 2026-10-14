/*
 * Turns a RaceRecorder into the replay data the page plays:
 * every car resampled to 60 Hz on one race clock, its distance raced
 * (progress), and tyres / pit lane / weather as race frames.
 *
 * - Clock: each car sends its own frame counter. Its time is frame/60 plus a
 *   rolling median of (receive time - frame/60), which removes network jitter.
 * - Race start: the median moment the cars leave their grid slot, minus 2 s
 *   (the game clock starts ~2 s before the cars move).
 * - Progress: one reference lap (a car's path from 45 s for one lap); every
 *   car is projected onto it, keeping continuity, and the lap count goes up
 *   at the line. The line is the pole sitter's grid slot + 30 px.
 * - Qualifying: every car leaves from the pit lane, so the line is where the
 *   first lap time (*11) arrived instead, and each car carries its lap times
 *   and the frame its first timed lap started (the page orders by best lap).
 */

const HZ = 60;
const NONE16 = -32768, NONE32 = -2147483648;
const MAX_GAP = 15;          // frames without data that are still interpolated
const MEDIAN_WINDOW = 301;   // samples
const START_MOVE_PX = 30;
const CLOCK_LEAD_S = 2.53;

function median(a) {
    const s = [...a].sort((x, y) => x - y);
    return s.length ? s[s.length >> 1] : 0;
}

// Per-sample time on the receive clock (seconds), smoothed with a rolling median.
function carTimes(c) {
    const order = c.frame.map((_, i) => i).sort((i, j) => c.frame[i] - c.frame[j]);
    const frame = order.map(i => c.frame[i]), x = order.map(i => c.x[i]), y = order.map(i => c.y[i]), a = order.map(i => c.a[i]);
    const off = order.map(i => c.at[i] / 1000 - c.frame[i] / HZ);
    const half = MEDIAN_WINDOW >> 1, t = [];
    // Rolling median, recomputed every 30 samples (it changes slowly).
    let cur = 0;
    for (let i = 0; i < frame.length; i++) {
        if (i % 30 === 0) cur = median(off.slice(Math.max(0, i - half), i + half + 1));
        t.push(frame[i] / HZ + cur);
    }
    // Drop duplicate frames (resends).
    const keep = t.map((_, i) => i === 0 || frame[i] !== frame[i - 1]);
    const f = arr => arr.filter((_, i) => keep[i]);
    return { t: f(t), x: f(x), y: f(y), a: f(a) };
}

function raceStart(series) {
    const starts = [];
    for (const s of series) {
        for (let i = 1; i < s.t.length; i++) {
            if (Math.hypot(s.x[i] - s.x[0], s.y[i] - s.y[0]) > START_MOVE_PX) { starts.push(s.t[i]); break; }
        }
    }
    return median(starts) - CLOCK_LEAD_S;
}

// Positions at 60 Hz from race start; gaps longer than MAX_GAP frames stay empty.
function resample(s, t0, frames) {
    const x = new Int16Array(frames).fill(NONE16), y = new Int16Array(frames).fill(NONE16), a = new Int16Array(frames).fill(NONE16);
    let j = 0;
    for (let k = 0; k < frames; k++) {
        const tt = t0 + k / HZ;
        while (j + 1 < s.t.length && s.t[j + 1] <= tt) j++;
        if (!s.t.length || tt < s.t[0] || j + 1 >= s.t.length) continue;
        const dt = s.t[j + 1] - s.t[j];
        if (dt * HZ > MAX_GAP) continue;
        const u = dt > 0 ? (tt - s.t[j]) / dt : 0;
        x[k] = Math.round(s.x[j] + (s.x[j + 1] - s.x[j]) * u);
        y[k] = Math.round(s.y[j] + (s.y[j + 1] - s.y[j]) * u);
        const a0 = ((s.a[j] % 360) + 360) % 360, a1 = ((s.a[j + 1] % 360) + 360) % 360;
        a[k] = Math.round((a0 + (((a1 - a0 + 540) % 360) - 180) * u + 360) % 360);
    }
    return { x, y, a };
}

// One lap of a car's path, as a closed polyline with cumulative length.
function referenceLap(pos, fromFrame) {
    const pts = [];
    let travelled = 0;
    for (let k = fromFrame; k < pos.x.length; k += 2) {
        if (pos.x[k] === NONE16) { if (pts.length) break; continue; }
        const p = [pos.x[k], pos.y[k]];
        if (pts.length) {
            const q = pts[pts.length - 1], d = Math.hypot(p[0] - q[0], p[1] - q[1]);
            if (d < 4) continue;
            travelled += d;
            if (travelled > 2000 && Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]) < 40) break;
        }
        pts.push(p);
    }
    return pts;
}

// A full lap ends back next to where it started.
function isClosed(pts) {
    const a = pts[0], b = pts[pts.length - 1];
    return Math.hypot(a[0] - b[0], a[1] - b[1]) < 60;
}

function cumulative(pts) {
    const s = [0];
    for (let i = 1; i <= pts.length; i++) {
        const a = pts[i - 1], b = pts[i % pts.length];
        s.push(s[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    return s; // s[pts.length] = lap length
}

// Nearest point on the polyline to p, searching around index `hint` (or everywhere).
function project(pts, cum, p, hint, span) {
    const n = pts.length;
    let best = { d: Infinity, s: 0, i: 0 };
    const from = hint == null ? 0 : hint - span, to = hint == null ? n - 1 : hint + span;
    for (let ii = from; ii <= to; ii++) {
        const i = ((ii % n) + n) % n, a = pts[i], b = pts[(i + 1) % n];
        const vx = b[0] - a[0], vy = b[1] - a[1], len2 = vx * vx + vy * vy || 1;
        const u = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2));
        const d = Math.hypot(a[0] + vx * u - p[0], a[1] + vy * u - p[1]);
        if (d < best.d) best = { d, s: cum[i] + Math.sqrt(len2) * u, i };
    }
    return best;
}

function progress(pts, cum, pos, lineS) {
    const L = cum[pts.length], n = pos.x.length, p = new Int32Array(n).fill(NONE32);
    let hint = null, laps = null, prevS = null;
    for (let k = 0; k < n; k++) {
        if (pos.x[k] === NONE16) continue;
        const pr = project(pts, cum, [pos.x[k], pos.y[k]], hint, hint == null ? 0 : 40);
        hint = pr.i;
        const s = (pr.s - lineS + L) % L; // 0 at the line
        if (laps == null) laps = s > L / 2 ? -1 : 0; // on the grid, behind the line
        else if (prevS > 0.8 * L && s < 0.2 * L) laps++;
        else if (prevS < 0.2 * L && s > 0.8 * L) laps--;
        prevS = s;
        p[k] = Math.round(laps * L + s);
    }
    return p;
}

// Timed laps in qualifying: settings field 3 (after class, class, race laps), else the most laps anyone did.
function qualiLaps(rec) {
    const n = Number(rec.settings.qualiLaps);
    if (n > 0) return n;
    const per = {};
    for (const e of rec.lapTimes) per[e.car] = (per[e.car] || 0) + 1;
    return Math.max(1, ...Object.values(per));
}

const b64 = typed => Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength).toString('base64');

/** Builds the replay data, or null if there isn't enough of a race recorded. */
function buildReplayData(rec, { qualifying = false } = {}) {
    if (!rec.settings || !rec.hasRace) return null;
    const drivers = rec.roster.filter(r => r.racing).sort((a, b) => a.idx - b.idx);
    const carIds = [...rec.cars.keys()].sort((a, b) => a - b);
    const series = new Map(carIds.map(id => [id, carTimes(rec.cars.get(id))]));
    const t0 = raceStart([...series.values()]);
    const tEnd = Math.max(...[...series.values()].map(s => s.t[s.t.length - 1] || 0));
    const frames = Math.max(1, Math.ceil((tEnd - t0) * HZ));
    const pos = new Map(carIds.map(id => [id, resample(series.get(id), t0, frames)]));
    const frameOf = atMs => Math.max(0, Math.round((atMs / 1000 - t0) * HZ));

    // Reference lap: the car that raced the most, from 45 s in.
    const refId = carIds.reduce((a, b) => (pos.get(b).x.filter(v => v !== NONE16).length > pos.get(a).x.filter(v => v !== NONE16).length ? b : a));
    // Ideally a lap from 45 s in (clean, at speed); short races fall back to
    // earlier starts, down to the moment the car leaves the grid.
    const ref = pos.get(refId);
    const moved = ref.x.findIndex((v, k) => v !== NONE16 && k > 0 && ref.x[0] !== NONE16 && Math.hypot(v - ref.x[0], ref.y[k] - ref.y[0]) > START_MOVE_PX);
    let pts = [];
    for (const from of [45 * HZ, 20 * HZ, 5 * HZ, Math.max(0, moved)]) {
        pts = referenceLap(ref, from);
        if (pts.length >= 50 && isClosed(pts)) break;
    }
    if (pts.length < 50 || !isClosed(pts)) return null;
    const cum = cumulative(pts), L = cum[pts.length];

    // The line: pole sitter's grid slot, 30 px ahead along the track. In
    // qualifying nobody starts on the grid: where a car was when its first lap
    // time arrived.
    let lineS = null;
    if (qualifying) {
        for (const e of rec.lapTimes) {
            const pp = pos.get(e.car), k = frameOf(e.at);
            if (pp && k < frames && pp.x[k] !== NONE16) { lineS = project(pts, cum, [pp.x[k], pp.y[k]], null).s; break; }
        }
    }
    if (lineS == null) {
        const poleIdx = drivers.find(d => d.grid === 1)?.idx ?? 0;
        const pole = pos.get(poleIdx + 1) || pos.get(carIds[0]);
        const k0 = pole.x.findIndex(v => v !== NONE16);
        lineS = (project(pts, cum, [pole.x[k0], pole.y[k0]], null).s + 30) % L;
    }

    const cars = carIds.map(id => {
        const d = drivers[id - 1] || {};
        const pp = pos.get(id), pr = progress(pts, cum, pp, lineS);
        const car = { id, name: d.name || `Car ${id}`, ping: d.ping || 0, livery: d.livery || id,
            x: b64(pp.x), y: b64(pp.y), a: b64(pp.a), p: b64(pr) };
        if (qualifying) {
            // [frame, lap time] per completed lap, and the first crossing of the line (end of the out lap).
            car.laps = rec.lapTimes.filter(e => e.car === id && e.time > 0).map(e => [frameOf(e.at), e.time]);
            const k0 = pr.findIndex(v => v !== NONE32);
            const lap0 = k0 < 0 ? 0 : Math.floor(pr[k0] / L);
            const k1 = pr.findIndex(v => v !== NONE32 && Math.floor(v / L) > lap0);
            car.timedFrom = k1 >= 0 ? k1 : (car.laps[0] ? car.laps[0][0] - Math.round(car.laps[0][1] * HZ) : null);
        }
        return car;
    });

    // Pit lane windows from the sector messages.
    const pits = [], inPit = new Map();
    for (const e of rec.sectors) {
        const f = frameOf(e.at);
        if (e.pit && !inPit.has(e.car)) inPit.set(e.car, f);
        else if (!e.pit && inPit.has(e.car)) { pits.push([String(e.car), inPit.get(e.car), f]); inPit.delete(e.car); }
    }

    return {
        session: qualifying ? 'qualifying' : 'race',
        hz: HZ, frames, lapLen: Math.round(L), laps: qualifying ? qualiLaps(rec) : rec.settings.laps,
        track: rec.track, trackCandidates: [...rec.tracks, ...(rec.settings.workshopIds || [])], carClass: rec.settings.carClass,
        cars,
        tyres: rec.tyres.map(e => [frameOf(e.at), String(e.car), e.tyre]).filter(e => e[2]),
        pits,
        weather: rec.gauge.map(e => [Math.round((e.at / 1000 - t0) * HZ), +(e.v / 100).toFixed(4), +(e.d / 100).toFixed(5), +(e.w / 100).toFixed(4)]),
        forecast: rec.forecast.map(e => [Math.round((e.at / 1000 - t0) * HZ), e.state]).filter(e => e[0] >= 0),
    };
}

module.exports = { buildReplayData };
