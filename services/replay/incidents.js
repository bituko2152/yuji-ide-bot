const zlib = require('zlib');

/*
 * Lists moments of a race for the stewards to review, from a replay's data.
 * Only flags, never verdicts: lap 1 is left out, flags sharing a driver within
 * 6 s are one incident, and an incident where nobody lost half a second (against
 * the same stretch on their nearby laps) is dropped. Also reports each driver's
 * tyres and pit stops, and gaps in their data (a possible connection problem).
 */

const NONE16 = -32768, NONE32 = -2147483648;

/** The replay data inside a replay HTML page, with its cars unpacked. Null if there's none. */
function parseReplay(html) {
    const line = html.split('\n').find(l => l.includes('REPLAY_DATA = {'));
    if (!line) return null;
    const D = JSON.parse(line.slice(line.indexOf('{'), line.lastIndexOf('}') + 1));
    const unpack = (s, T) => {
        const b = zlib.inflateRawSync(Buffer.from(s, 'base64'));
        const d = new Int32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
        const o = new T(d.length);
        let v = 0;
        for (let i = 0; i < d.length; i++) { v += d[i]; o[i] = v; }
        return o;
    };
    if (D.packed) for (const c of D.cars) for (const [k, T] of [['x', Int16Array], ['y', Int16Array], ['a', Int16Array], ['p', Int32Array]]) c[k] = unpack(c[k], T);
    return D;
}

function detectIncidents(D) {
    const HZ = D.hz, F = D.frames, L = D.lapLen, CAR = D.carLen || 34;
    const cars = D.cars, byId = new Map(cars.map(c => [String(c.id), c]));
    const ok = (c, k) => k >= 0 && k < F && c.x[k] !== NONE16 && c.p[k] !== NONE32;
    const clock = k => { const s = Math.round(k / HZ); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
    const lapOf = (c, k) => (ok(c, k) ? Math.floor(c.p[k] / L) + 1 : '?');

    // Pit windows, with a margin for the entry and the exit.
    const pitOf = new Map(cars.map(c => [String(c.id), []]));
    for (const [id, a, b] of D.pits) pitOf.get(String(id))?.push([a, b]);
    const inPit = (c, k, m = 4 * HZ) => pitOf.get(String(c.id)).some(([a, b]) => k >= a - m && k <= b + m);

    // Speed in px/frame over 0.1 s; null where there's no data.
    for (const c of cars) {
        c.v = new Float32Array(F).fill(-1);
        for (let k = 6; k < F; k++) if (ok(c, k) && ok(c, k - 6)) c.v[k] = Math.hypot(c.x[k] - c.x[k - 6], c.y[k] - c.y[k - 6]) / 6;
    }

    // The track as the field drove it: per stretch of lap, median position and speed.
    const BIN = 20, NB = Math.ceil(L / BIN);
    const samples = Array.from({ length: NB }, () => ({ x: [], y: [], v: [] }));
    for (const c of cars) for (let k = 30 * HZ; k < F; k += 4) {
        if (!ok(c, k) || c.v[k] < 0 || inPit(c, k)) continue;
        const s = samples[Math.floor((((c.p[k] % L) + L) % L) / BIN) % NB];
        s.x.push(c.x[k]); s.y.push(c.y[k]); s.v.push(c.v[k]);
    }
    const med = a => { if (!a.length) return null; const b = [...a].sort((p, q) => p - q); return b[b.length >> 1]; };
    const ref = samples.map(s => ({ x: med(s.x), y: med(s.y), v: med(s.v) }));
    const refPts = ref.map((r, i) => ({ ...r, i })).filter(r => r.x != null);
    // By position: the distance raced goes wrong after a long data gap.
    const binOf = c => k => { let best = 0, d = Infinity; for (const r of refPts) { const e = (r.x - c.x[k]) ** 2 + (r.y - c.y[k]) ** 2; if (e < d) { d = e; best = r.i; } } return best; };
    const racing = (c, k) => ok(c, k) && c.p[k] < D.laps * L; // nothing after the flag
    const lastFrame = Math.max(...cars.map(c => { let k = F - 1; while (k > 0 && !racing(c, k)) k--; return k; }));

    // Signed distance from the field's line (+ = left of travel).
    for (const c of cars) {
        c.lat = new Float32Array(F).fill(NaN);
        const b = binOf(c);
        for (let k = 0; k < F; k++) {
            if (!ok(c, k)) continue;
            const i = b(k), r = ref[i], n = ref[(i + 2) % NB];
            if (r.x == null || n.x == null) continue;
            const dx = n.x - r.x, dy = n.y - r.y, len = Math.hypot(dx, dy) || 1;
            c.lat[k] = ((c.x[k] - r.x) * -dy + (c.y[k] - r.y) * dx) / len;
        }
    }
    // How straight each stretch is (for zigzags and brake checks).
    const heading = i => { const a = ref[i], b = ref[(i + 3) % NB]; return a.x == null || b.x == null ? null : Math.atan2(b.y - a.y, b.x - a.x); };
    const isStraight = i => { let h0 = heading(i), max = 0; for (let j = 1; j < 12; j++) { const h = heading((i + j) % NB); if (h0 == null || h == null) return false; let d = Math.abs(h - h0); if (d > Math.PI) d = 2 * Math.PI - d; max = Math.max(max, d); } return max < 0.12; };
    // Off track: well outside what the field used there.
    const spread = samples.map((_, i) => 0);
    {
        const per = Array.from({ length: NB }, () => []);
        for (const c of cars) { const b = binOf(c); for (let k = 30 * HZ; k < F; k += 4) if (!Number.isNaN(c.lat[k]) && !inPit(c, k)) per[b(k)].push(Math.abs(c.lat[k])); }
        per.forEach((a, i) => { a.sort((p, q) => p - q); spread[i] = a.length ? a[Math.floor(a.length * 0.97)] : 40; });
    }

    const dist = (a, b, k) => (ok(a, k) && ok(b, k) ? Math.hypot(a.x[k] - b.x[k], a.y[k] - b.y[k]) : Infinity);
    const near = (c, k, r) => cars.filter(o => o !== c && dist(c, o, k) < r);
    const flags = [];
    const add = (type, conf, k, names, why) => flags.push({ type, conf, frame: k, time: clock(k), names, why });
    const name = c => c.name;
    const lastFlag = new Map();
    const cool = (key, k, s) => { if (k - (lastFlag.get(key) ?? -1e9) < s * HZ) return false; lastFlag.set(key, k); return true; };

    // Contacts: two cars touching while one of them suddenly loses speed the field keeps there.
    for (let k = 8 * HZ; k < lastFrame; k += 3) for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
        const a = cars[i], b = cars[j];
        if (dist(a, b, k) > CAR * 0.8 || inPit(a, k) || inPit(b, k) || !racing(a, k) || !racing(b, k)) continue;
        for (const [hit, other] of [[a, b], [b, a]]) {
            const before = hit.v[k - 20], after = hit.v[k + 30];
            if (!(before > 3) || !(after >= 0)) continue;
            const expected = ref[binOf(hit)(k)].v || before;
            const lost = before - after, normal = Math.max(0, before - expected);
            if (lost - normal > before * 0.3 && cool(`c${hit.id}-${other.id}`, k, 8) && cool(`c${other.id}-${hit.id}`, k, 8)) {
                const behind = hit.p[k] < other.p[k] ? hit : other, ahead = behind === hit ? other : hit;
                add('Contact', lost / before > 0.5 ? 'high' : 'medium', k, [behind.name, ahead.name], `lap ${lapOf(ahead, k)}: ${behind.name} (behind) and ${ahead.name} touch, ${hit.name} drops ${Math.round(lost / before * 100)}% speed`);
            }
        }
    }

    // Off track, with who was alongside, and how they came back.
    for (const c of cars) {
        const b = binOf(c);
        for (let k = 8 * HZ; k < F; k += 6) {
            if (Number.isNaN(c.lat[k]) || inPit(c, k) || !racing(c, k)) continue;
            const i = b(k);
            if (Math.abs(c.lat[k]) < Math.max(spread[i] * 1.35, CAR * 1.5) || !(c.v[k] >= 0) || c.v[k] > (ref[i].v || 8) * 0.85) continue;
            if (!cool(`o${c.id}`, k, 12)) continue;
            const side = near(c, k - 30, CAR * 1.6).filter(o => !inPit(o, k));
            // Coming back: first moment within the usual width again, and who was arriving.
            let back = k; while (back < Math.min(F - 1, k + 20 * HZ) && Math.abs(c.lat[back]) > spread[b(back)]) back += 3;
            const arriving = near(c, back, CAR * 2.5).filter(o => o.p[back] < c.p[back] && o.v[back] > c.v[back] && !inPit(o, back));
            const impeded = arriving.filter(o => o.v[back + 40] >= 0 && o.v[back + 40] < o.v[back] * 0.8);
            if (side.length) add('Off track next to a car (FOT?)', 'medium', k - 30, [c.name, ...side.map(name)], `lap ${lapOf(c, k)}: ${c.name} leaves the track with ${side.map(name).join(', ')} alongside`);
            if (impeded.length) add('Rejoin (UR?)', 'high', back, [c.name, ...impeded.map(name)], `lap ${lapOf(c, back)}: ${c.name} rejoins and ${impeded.map(name).join(', ')} lose speed`);
        }
    }

    // Wrong way: moving against the track's direction for 2 s.
    for (const c of cars) {
        const b = binOf(c);
        for (let k = 8 * HZ; k < F - 2 * HZ; k += 30) {
            if (!racing(c, k) || !ok(c, k + 2 * HZ) || inPit(c, k)) continue;
            const h = heading(b(k));
            if (h == null) continue;
            const mx = c.x[k + 2 * HZ] - c.x[k], my = c.y[k + 2 * HZ] - c.y[k], m = Math.hypot(mx, my);
            if (m > CAR * 3 && mx * Math.cos(h) + my * Math.sin(h) < -m * 0.7 && cool(`b${c.id}`, k, 20)) add('Driving backwards (BD?)', 'high', k, [c.name], `lap ${lapOf(c, k)}: ${c.name} moves against the track direction for 2 s`);
        }
    }

    // Weaving on a straight with a car close behind: more than 3 direction changes in 6 s.
    for (const c of cars) {
        const b = binOf(c);
        for (let k = 20 * HZ; k < F - 6 * HZ; k += 30) {
            if (inPit(c, k, 6 * HZ)) continue;
            let changes = 0, dir = 0, straight = true, last = c.lat[k], moved = 0;
            for (let j = k; j < k + 6 * HZ; j += 6) {
                if (Number.isNaN(c.lat[j]) || !isStraight(b(j))) { straight = false; break; }
                const d = c.lat[j] - last;
                moved += Math.abs(d);
                if (Math.abs(d) > 2) { const s = Math.sign(d); if (dir && s !== dir) changes++; dir = s; last = c.lat[j]; }
            }
            if (!straight || changes <= 3 || moved < CAR) continue;
            const behind = near(c, k + 3 * HZ, CAR * 2.5).filter(o => o.p[k] < c.p[k]);
            if (behind.length && cool(`w${c.id}`, k, 15)) add('Weaving (W2D?)', 'medium', k, [c.name, ...behind.map(name)], `lap ${lapOf(c, k)}: ${c.name} changes direction ${changes} times on a straight, ${behind.map(name).join(', ')} behind`);
        }
    }

    // Braking on a straight where the field doesn't, with a car right behind, without being hit first.
    for (const c of cars) {
        const b = binOf(c);
        for (let k = 20 * HZ; k < F - HZ; k += 6) {
            if (inPit(c, k) || !isStraight(b(k)) || !isStraight(b(k + 30))) continue;
            const v0 = c.v[k], v1 = c.v[k + 30], usual = ref[b(k)].v;
            if (!(v0 > usual * 0.85) || !(v1 >= 0) || v0 - v1 < v0 * 0.25) continue;
            if (near(c, k, CAR * 0.9).length) continue;
            const behind = near(c, k, CAR * 2).filter(o => o.p[k] < c.p[k] && o.v[k] > 0);
            if (behind.length && cool(`p${c.id}`, k, 10)) add('Brake on a straight (PBC?)', 'medium', k, [c.name, ...behind.map(name)], `lap ${lapOf(c, k)}: ${c.name} loses ${Math.round((v0 - v1) / v0 * 100)}% speed on a straight, ${behind.map(name).join(', ')} behind`);
        }
    }

    // Connection: gaps in a car's data and the jumps when it comes back.
    const net = cars.map(c => {
        let gaps = 0, longest = 0, jumps = 0, cur = 0, firstSeen = c.x.findIndex(v => v !== NONE16), lastSeen = F - 1;
        while (lastSeen > 0 && !racing(c, lastSeen)) lastSeen--;
        const events = [];
        for (let k = firstSeen; k <= lastSeen; k++) {
            if (c.x[k] === NONE16) { cur++; continue; }
            if (cur > 0) {
                if (cur >= 30) { gaps++; longest = Math.max(longest, cur); events.push(k); }
                const pv = c.x[k - cur - 1], py = c.y[k - cur - 1];
                const expected = (cur + 1) * 9;
                if (pv !== NONE16 && Math.hypot(c.x[k] - pv, c.y[k] - py) > expected + CAR * 2) { jumps++; if (cool(`t${c.id}`, k, 10)) add('Teleport (TP?)', 'medium', k, [c.name], `lap ${lapOf(c, k)}: ${c.name} reappears ${Math.round(Math.hypot(c.x[k] - pv, c.y[k] - py) / CAR)} car lengths away after ${(cur / HZ).toFixed(1)} s without data`); }
                cur = 0;
            } else if (k > firstSeen && c.x[k - 1] !== NONE16 && Math.hypot(c.x[k] - c.x[k - 1], c.y[k] - c.y[k - 1]) > CAR * 1.5) {
                jumps++;
                if (cool(`t${c.id}`, k, 10)) add('Teleport (TP?)', 'medium', k, [c.name], `lap ${lapOf(c, k)}: ${c.name} jumps ${Math.round(Math.hypot(c.x[k] - c.x[k - 1], c.y[k] - c.y[k - 1]) / CAR)} car lengths in one frame`);
            }
        }
        return { name: c.name, ping: c.ping, gaps, longest: +(longest / HZ).toFixed(1), jumps, lastSeen, events };
    });

    // Tyres: what each car had on leaving the grid and each pit stop.
    const finished = c => { let k = F - 1; while (k > 0 && !ok(c, k)) k--; return Math.floor(c.p[k] / L) >= D.laps; };
    const tyres = cars.map(c => {
        const ev = D.tyres.filter(e => e[1] === String(c.id)).sort((a, b) => a[0] - b[0]);
        const at = k => { let t = null; for (const e of ev) if (e[0] <= k) t = e[2]; return t; };
        const stops = pitOf.get(String(c.id));
        const sets = [at(30 * HZ) || at(0), ...stops.map(([, b]) => at(b + 60))];
        return { name: c.name, sets, stops: stops.length, finished: finished(c), laps: Math.floor(Math.max(...c.p.filter(v => v !== NONE32)) / L) };
    });

    // The first lap is left out: while any car involved is still on it, it's the chaos of the start.
    const carByName = new Map(cars.map(c => [c.name, c]));
    for (let i = flags.length - 1; i >= 0; i--) {
        const f = flags[i];
        if (f.names.some(n => { const c = carByName.get(n); return c && ok(c, f.frame) && c.p[f.frame] < L; })) flags.splice(i, 1);
    }
    // Time a car lost: this stretch of track against the same stretch on its nearby laps
    // (same car, tyres and weather). Null when it can't be compared.
    const MIN_LOSS = 0.5, STRETCH = Math.min(L * 0.4, 5000);
    function frameAt(c, dist, from, to) {
        for (let k = Math.max(0, from); k < Math.min(F, to); k++) if (ok(c, k) && c.p[k] >= dist) return k;
        return null;
    }
    function timeLost(c, k) {
        const at = k - HZ;
        if (!ok(c, at)) return null;
        const p0 = c.p[at], took = dist0 => {
            const a = frameAt(c, dist0, 0, F), b = a == null ? null : frameAt(c, dist0 + STRETCH, a, a + 60 * HZ);
            return b == null || inPit(c, a) || inPit(c, b) ? null : (b - a) / HZ;
        };
        const now = took(p0);
        if (now == null) return null;
        const others = [-3, -2, -1, 1, 2, 3].map(n => (p0 + n * L > L ? took(p0 + n * L) : null)).filter(v => v != null).sort((x, y) => x - y);
        return others.length >= 2 ? now - others[others.length >> 1] : null;
    }
    flags.sort((a, b) => a.frame - b.frame);
    // One incident, one flag: flags sharing a driver within 6 s are the same incident.
    const MERGE_FRAMES = 6 * HZ;
    for (let i = 0; i < flags.length; i++) {
        const f = flags[i];
        f.end = f.frame;
        for (let j = i + 1; j < flags.length && flags[j].frame - f.end <= MERGE_FRAMES; j++) {
            const g = flags[j];
            if (!g.names.some(n => f.names.includes(n))) continue;
            f.names = [...new Set([...f.names, ...g.names])];
            if (!f.type.split(' + ').includes(g.type)) f.type += ` + ${g.type}`;
            if (g.conf === 'high') f.conf = 'high';
            f.why += `; ${g.why}`;
            f.end = g.frame;
            flags.splice(j--, 1);
        }
    }
    // Out: incidents where nobody involved lost half a second. Unknown losses stay, for a human to look at.
    for (let i = flags.length - 1; i >= 0; i--) {
        const f = flags[i];
        f.lost = Object.fromEntries(f.names.map(n => [n, timeLost(carByName.get(n), f.frame)]));
        const known = Object.values(f.lost).filter(v => v != null);
        if (known.length && Math.max(...known) < MIN_LOSS) { flags.splice(i, 1); continue; }
        f.why += ' · lost: ' + f.names.map(n => `${n} ${f.lost[n] == null ? '?' : f.lost[n].toFixed(2) + 's'}`).join(', ');
    }
    return { track: D.trackName, laps: D.laps, minutes: +(F / HZ / 60).toFixed(1), flags, tyres, net };
}

module.exports = { parseReplay, detectIncidents };
