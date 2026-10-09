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
 * The window opens Monday 00:00 UTC and closes on race day (Sunday, the
 * same weekday as config.starters.fecha_primera_carrera, the RACE day of
 * round 1) at config.starters.hora_cierre[cat] ("HH:MM" UTC). Without a
 * closing time it runs until next Monday 00:00 UTC.
 */
function closingTime(cat, config, weekStart) {
    const s = config.starters;
    const [h, m] = String(s.hora_cierre?.[cat] || '').split(':').map(Number);
    if (!Number.isInteger(h) || !Number.isInteger(m)) return weekStart + WEEK_MS;

    const raceDay = new Date(`${s.fecha_primera_carrera}T00:00:00Z`);
    const raceDayOffset = (raceDay.getUTCDay() + 6) % 7; // days after Monday
    return weekStart + raceDayOffset * DAY_MS + (h * 60 + m) * 60 * 1000;
}

function getWindow(cat, config, now = Date.now()) {
    const s = config.starters;
    const firstWeekStart = mondayUtc(new Date(`${s.fecha_primera_carrera}T00:00:00Z`));
    const weekStart = mondayUtc(new Date(now));
    const idx = Math.round((weekStart - firstWeekStart) / WEEK_MS);

    if (idx < 0) return { status: 'before' };

    const base = { weekStart, closesAt: closingTime(cat, config, weekStart) };
    const cycle = Math.floor(idx / CYCLE_WEEKS);
    const pos = idx % CYCLE_WEEKS;

    const firstHalf = pos <= 4;
    const secondHalf = pos >= 6 && pos <= 10;
    if (!firstHalf && !secondHalf) return { ...base, open: false };

    const season = s.temporada_inicial[cat] + cycle;

    let roundName;
    if (s.formato[cat] === '10') {
        // UL / CL: R1..R10 in a single season
        const round = firstHalf ? pos + 1 : pos; // pos 6 -> R6 ... pos 10 -> R10
        roundName = `${cat}S${season}R${round}`;
    } else {
        // JL / AL: R1..R5 of "A", then R1..R5 of "B"
        const letter = firstHalf ? 'A' : 'B';
        const round = firstHalf ? pos + 1 : pos - 5;
        roundName = `${cat}S${season}${letter}R${round}`;
    }

    return { ...base, open: true, roundName };
}

module.exports = { getWindow, mondayUtc, WEEK_MS };
