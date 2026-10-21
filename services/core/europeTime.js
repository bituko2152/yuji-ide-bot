/*
 * The league runs on European time. Times in config.json are UTC as in
 * European summer time (CEST, UTC+2); in winter (CET, UTC+1) everything moves
 * one hour later in UTC so it stays at the same hour in Europe. The switch is
 * at the exact moment the clocks change (last Sunday of March / October, 01:00
 * UTC): anything before it stays as it was, anything after it moves.
 */

const ZONE = 'Europe/Madrid';
const HOUR_MS = 60 * 60 * 1000;
const SUMMER_OFFSET_MS = 2 * HOUR_MS;

const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric'
});

// Europe's offset from UTC at a moment (2 h in summer, 1 h in winter).
function offsetAt(ms) {
    const p = Object.fromEntries(parts.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
    const local = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
    return local - Math.floor(ms / 60000) * 60000;
}

/** A moment worked out from config times (summer UTC), moved to winter time when it falls in winter. */
function europe(ms) {
    return ms + SUMMER_OFFSET_MS - offsetAt(ms);
}

module.exports = { europe };
