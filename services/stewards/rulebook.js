/*
 * The mobile leagues' Stewards Rulebook (V.2.3B), as data: the 10 voting
 * choices, the infractions behind them, their escalation tables and the
 * penalty points.
 *
 * Escalation tables give the TOTAL for that infraction in the race ("2 L-FOT
 * = 4 sec"), so one incident adds the difference with the previous total. DSQ
 * once a table runs out.
 */

const DSQ = 'DSQ';

// sec(n) = total seconds after the nth one in a race ('warning' / DSQ).
const INFRACTIONS = {
    NONE: { name: 'No penalty (nothing / lagrocket)', ppts: 0, total: () => 0 },
    TM: { name: 'Trailer Misjudgement (TM)', ppts: 0, total: n => [null, 'warning', 1, 2, 3, 5][n] ?? 5 + 2 * (n - 5) },
    UR: { name: 'Unsafe Rejoin (UR)', ppts: 1, cars: true },
    TRE: { name: 'Trailer Rear Edge (TRE)', ppts: 0, total: n => n },
    LFOT: { name: 'Low Forcing Off Track (L-FOT)', ppts: 1, total: n => [null, 2, 4, 6, 9][n] ?? DSQ },
    MFOT: { name: 'Medium Forcing Off Track (M-FOT)', ppts: 2, total: n => [null, 3, 6, 10][n] ?? DSQ },
    HFOT: { name: 'High Forcing Off Track (H-FOT)', ppts: 2, total: n => [null, 4, 8, 12][n] ?? DSQ },
    W2D: { name: 'Waving to Defend (W2D)', ppts: 2, total: n => [null, 3, 6, 10][n] ?? DSQ },
    PBC: { name: 'Purposely Brake Check (PBC)', ppts: 2, total: n => [null, 3, 6, 10][n] ?? DSQ },
    UPE: { name: 'Unsafe Pit Entry (UPE)', ppts: 3, total: n => [null, 5, 10][n] ?? DSQ },
    UD: { name: 'Uncontrolled Divebomb (UD)', ppts: 3, total: n => [null, 5, 10][n] ?? DSQ },
    IC: { name: 'Intentional Crash (IC)', ppts: 5, total: () => DSQ, note: 'Qualifying ban next round (starts last).' },
    IT: { name: 'Intentional Targeting (IT)', ppts: 10, total: () => DSQ },
    BD: { name: 'Backward Driving (BD)', ppts: 10, total: () => DSQ, note: 'Reported to the UROs.' },
    LA: { name: 'Lagrocket Abuse (LA)', ppts: 10, total: () => DSQ },
    TP: { name: 'Teleporting (TP)', ppts: 0, total: n => (n >= 3 ? DSQ : 'warning') }
};

// The voting choices (A-J), as the stewards already use them.
const CHOICES = [
    { id: 'A', label: 'Nothing/Lagrocket', infractions: ['NONE'] },
    { id: 'B', label: 'Trailer Misjudgement (TM)', infractions: ['TM'] },
    { id: 'C', label: 'UR/TRE', infractions: ['UR', 'TRE'] },
    { id: 'D', label: 'L-FOT', infractions: ['LFOT'] },
    { id: 'E', label: 'M-FOT/W2D/PBC', infractions: ['MFOT', 'W2D', 'PBC'] },
    { id: 'F', label: 'H-FOT', infractions: ['HFOT'] },
    { id: 'G', label: 'UD/UPE', infractions: ['UD', 'UPE'] },
    { id: 'H', label: 'IC', infractions: ['IC'] },
    { id: 'I', label: 'LA/IT/BD', infractions: ['LA', 'IT', 'BD'] },
    { id: 'J', label: 'TP', infractions: ['TP'] }
];

// Penalty points tables: a ban each time one of these is reached.
const PPTS_TABLES = { UMRL: 'SL', AMRL: 'SL', EMRL: 'Open', OMRL: 'Open' };
const BANS = [10, 18, 22];
const SEASON_BAN = 23;

const choice = id => CHOICES.find(c => c.id === id);

/**
 * The penalty of one incident: n = how many of that infraction the driver
 * has in that race counting this one; cars for UR.
 * -> { seconds, warning, dsq, ppts, total }   (total: that infraction's race total)
 */
function penaltyFor(infraction, n, cars = 1) {
    const inf = INFRACTIONS[infraction];
    if (inf.cars) return { seconds: cars, warning: false, dsq: false, ppts: inf.ppts, total: null };
    const now = inf.total(n), before = n > 1 ? inf.total(n - 1) : 0;
    if (now === DSQ) return { seconds: 0, warning: false, dsq: true, ppts: inf.ppts, total: DSQ };
    if (now === 'warning') return { seconds: 0, warning: true, dsq: false, ppts: inf.ppts, total: null };
    const prev = typeof before === 'number' ? before : 0;
    return { seconds: now - prev, warning: false, dsq: false, ppts: inf.ppts, total: now };
}

/** Bans reached going from `before` to `after` points: ['race ban', ...] / 'season ban'. */
function bansReached(before, after) {
    const out = BANS.filter(b => before < b && after >= b).map(b => `race ban (${b} points)`);
    if (before < SEASON_BAN && after >= SEASON_BAN) out.push(`season ban (${SEASON_BAN}+ points)`);
    return out;
}

module.exports = { INFRACTIONS, CHOICES, PPTS_TABLES, choice, penaltyFor, bansReached, DSQ };
