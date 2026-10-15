const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

// 5 races + 1 break week + 5 races + 2 break weeks = 13 weeks, then it repeats.
const CYCLE_WEEKS = 13;

/** Monday 00:00 UTC of the week that contains the given date (as ms). */
function mondayUtc(date) {
    const d = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    const daysSinceMonday = (new Date(d).getUTCDay() + 6) % 7;
    return d - daysSinceMonday * DAY_MS;
}

/**
 * Returns the starters window that is active at `now` for a category:
 *  - { status: 'before' }                       -> the calendar hasn't started yet
 *  - { open: false, weekStart, closesAt }       -> break week, no starters
 *  - { open: true, weekStart, closesAt, roundName } -> race week
 *
 * The window opens Monday 00:00 UTC, or for the leagues listed in
 * config.starters.opens ({ "day", "time", "leagues": [...] }) at that time,
 * and closes at config.starters.closes[cat]. Both are UTC, inside the race
 * week (Monday-Sunday); closes is "HH:MM" (on race day: the same weekday as
 * config.starters.first_race_date, the RACE day of round 1) or
 * { "day": "saturday", "time": "15:50" }. Without a closing time it runs
 * until next Monday 00:00 UTC. config.starters.from[cat] ("YYYY-MM-DD"):
 * nothing before that week (a league that starts using starters later).
 */
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function weekMoment(when, config, weekStart) {
    const spec = typeof when === 'object' && when ? when : { time: when };
    const [h, m] = String(spec.time || '').split(':').map(Number);
    if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
    const day = spec.day
        ? DAYS.indexOf(String(spec.day).toLowerCase())
        : new Date(`${config.starters.first_race_date}T00:00:00Z`).getUTCDay(); // race day
    if (day < 0) return null;
    return weekStart + ((day + 6) % 7) * DAY_MS + (h * 60 + m) * 60 * 1000;
}

function closingTime(cat, config, weekStart) {
    return weekMoment(config.starters.closes?.[cat], config, weekStart) ?? weekStart + WEEK_MS;
}

function openingTime(cat, config, weekStart) {
    const opens = config.starters.opens;
    return (opens?.leagues || []).includes(cat) ? weekMoment(opens, config, weekStart) ?? weekStart : weekStart;
}

function getWindow(cat, config, now = Date.now()) {
    const s = config.starters;
    const firstWeekStart = mondayUtc(new Date(`${s.first_race_date}T00:00:00Z`));
    const weekStart = mondayUtc(new Date(now));
    const idx = Math.round((weekStart - firstWeekStart) / WEEK_MS);

    if (idx < 0) return { status: 'before' };
    const from = s.from?.[cat];
    if (from && weekStart < mondayUtc(new Date(`${from}T00:00:00Z`))) return { status: 'before' };

    const base = { weekStart, opensAt: openingTime(cat, config, weekStart), closesAt: closingTime(cat, config, weekStart) };
    const cycle = Math.floor(idx / CYCLE_WEEKS);
    const pos = idx % CYCLE_WEEKS;

    const firstHalf = pos <= 4;
    const secondHalf = pos >= 6 && pos <= 10;
    if (!firstHalf && !secondHalf) return { ...base, open: false };

    const season = s.first_season[cat] + cycle;

    let roundName;
    if (s.format[cat] === '10') {
        // UL / CL: R1..R10 in a single season
        const round = firstHalf ? pos + 1 : pos; // pos 6 -> R6 ... pos 10 -> R10
        roundName = `${cat}S${season}R${round}`;
    } else if (s.format[cat] === '5') {
        // EMRL: every half is a season of its own (R1..R5), two seasons per cycle
        const round = firstHalf ? pos + 1 : pos - 5;
        roundName = `${cat}S${s.first_season[cat] + cycle * 2 + (firstHalf ? 0 : 1)}R${round}`;
    } else {
        // JL / AL: R1..R5 of "A", then R1..R5 of "B"
        const letter = firstHalf ? 'A' : 'B';
        const round = firstHalf ? pos + 1 : pos - 5;
        roundName = `${cat}S${season}${letter}R${round}`;
    }

    return { ...base, open: true, roundName };
}

module.exports = { getWindow, mondayUtc, WEEK_MS };
