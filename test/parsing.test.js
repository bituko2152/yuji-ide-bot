const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLineup } = require('../services/lineups/lineupService');
const { parseRound, parseResult, amounts } = require('../services/reports/penaltyStore');
const { partialCsv, buildCsv } = require('../services/results/resultsWatcher');
const { parseCsv } = require('../services/results/resultsUpload');

test('lineup message: teams, staff, seats and vacant places', () => {
    const text = [
        '# UL Season 26 - Autumn 2026 - RETRO SEASON',
        '',
        '1️⃣ 🇯🇵 🇱🇻 **OneTime Nismo RS [ONE]** | <@&111> ',
        'Owners - 🇯🇵 <@1> / 🇱🇻 <@2>',
        'Drivers - 🇱🇻 <@2> / [VACANT]',
        'Reserve - 🇮🇹 @Big Brobb',
        '',
        '2️⃣ 🇷🇴 **Leviosso Sports Art [LSA]** | <@&222>',
        'Owner - 🇷🇴 <@3>',
        'Team Principal - 🇭🇺 <@4>',
        'Drivers-<@5>  /  🇧🇬 <@6>',
        'Reserve - [VACANT]'
    ].join('\n');
    const { title, teams } = parseLineup(text);
    assert.equal(title, 'UL Season 26 - Autumn 2026 - RETRO SEASON');
    assert.equal(teams.length, 2);
    assert.deepEqual([teams[0].roleId, teams[0].name, teams[0].flag], ['111', 'OneTime Nismo RS [ONE]', '🇯🇵 🇱🇻']);
    assert.deepEqual(teams[0].drivers, [{ id: '2', flag: '🇱🇻' }, null]);
    assert.deepEqual(teams[0].reserves, [{ text: '@Big Brobb', flag: '🇮🇹' }]);
    assert.deepEqual(teams[1].principals, [{ id: '4', flag: '🇭🇺' }]);
    assert.deepEqual(teams[1].drivers.map(d => d.id), ['5', '6']);
});

test('lineup message: a broken line is refused with the reason', () => {
    assert.throws(() => parseLineup('# UL Season 1\n1️⃣ **X [X]** | <@&1>\nDriver - Bob'), /"Bob" is not a member/);
    assert.throws(() => parseLineup('# UL Season 1\n1️⃣ **X [X]** | <@&1>\nDrivers - <@1> / <@2> / <@3>'), /more than 2 drivers/);
    assert.throws(() => parseLineup('Hello'), /title/);
});

test('penalty rounds and amounts', () => {
    assert.deepEqual(parseRound('JL S23A R5'), { league: 'JL', season: 23, division: 'A', round: 5 });
    assert.deepEqual(parseRound('ULS26R1'), { league: 'UL', season: 26, division: null, round: 1 });
    assert.equal(amounts('Time penalty', '3.00s').time_ms, 3000);
    assert.equal(amounts('Position penalty', '2 positions').positions, 2);
    assert.equal(amounts('DSQ', 'DSQ + sent to the URA').dsq, true);
    assert.equal(amounts('Warning', '-').warning, true);
});

test('a posted penalty result is read back', () => {
    const r = parseResult('**Report:** <@42> | CL | S23 R1\n**Result:** Level 2 | Time penalty\n**Penalty:** 3.00s\n**Proof:** https://x');
    assert.deepEqual([r.discordId, r.offense, r.kind, r.penalty, r.proof], ['42', 'Level 2', 'Time penalty', '3.00s', 'https://x']);
    assert.deepEqual(parseRound(r.round), { league: 'CL', season: 23, division: null, round: 1 });
});

test('game results table -> CSV (humans only, DNF, fastest lap)', () => {
    const rows = [
        { index: 0, name: 'Ana', id: '1:a', quali: 60, grid: 2, total: 1000, best: 50 },
        { index: 1, name: 'AI', id: 'ai', quali: 61, grid: 1, total: 1001, best: 49 },
        { index: 2, name: 'Bob', id: '2:b', quali: 62, grid: 3, total: 1e6, best: 48 }
    ];
    const csv = parseCsv(buildCsv(rows, true));
    assert.deepEqual(csv.map(r => r.driver), ['Ana', 'Bob']);
    assert.equal(csv[1].dnf, 'true');
    assert.equal(csv[1].fastest_lap, 'true'); // a DNF can hold the fastest lap
});

test('a race cut short: provisional order by laps, then who got there first', () => {
    const recorder = {
        roster: [{ idx: 0, name: 'Ana', id: '1:a', grid: 2 }, { idx: 1, name: 'Bob', id: '2:b', grid: 1 }, { idx: 2, name: 'AI', id: 'ai', grid: 3 }],
        lapTimes: [{ car: 1, time: 50, at: 1 }, { car: 2, time: 49, at: 2 }, { car: 1, time: 50, at: 3 }, { car: 3, time: 40, at: 4 }]
    };
    const { csv, laps } = partialCsv(recorder, true);
    assert.equal(laps, 2);
    assert.deepEqual(parseCsv(csv).map(r => [r.driver, r.laps]), [['Ana', '2'], ['Bob', '1']]);
});
