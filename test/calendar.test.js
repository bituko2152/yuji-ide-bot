const test = require('node:test');
const assert = require('node:assert/strict');
const { getWindow, reportRound } = require('../services/starters/starterCalendar');
const { currentSeason } = require('../services/lineups/lineupService');

// The league calendar as it was set up for UL S26 / JL S23 (first race Sunday 4 Oct 2026).
const config = {
    starters: {
        first_race_date: '2026-10-04',
        closes: { UL: '17:50', JL: '15:15', EMRL: { day: 'saturday', time: '15:10' } },
        first_season: { UL: 26, JL: 23, EMRL: 8 },
        format: { UL: '10', JL: 'AB', EMRL: '5' }
    }
};
const at = iso => Date.parse(iso);

test('a race week: round name and closing time (European summer time)', () => {
    const w = getWindow('UL', config, at('2026-10-01T12:00Z'));
    assert.equal(w.open, true);
    assert.equal(w.roundName, 'ULS26R1');
    assert.equal(new Date(w.closesAt).toISOString(), '2026-10-04T17:50:00.000Z');
});

test('the break week after R5 has no starters', () => {
    assert.equal(getWindow('UL', config, at('2026-11-04T12:00Z')).open, false);
});

test('after the break: R6, one hour later in winter time', () => {
    const w = getWindow('UL', config, at('2026-11-11T12:00Z'));
    assert.equal(w.roundName, 'ULS26R6');
    assert.equal(new Date(w.closesAt).toISOString(), '2026-11-15T18:50:00.000Z');
});

test('JL runs A and B halves, EMRL a season per half', () => {
    assert.equal(getWindow('JL', config, at('2026-10-01T12:00Z')).roundName, 'JLS23AR1');
    assert.equal(getWindow('JL', config, at('2026-11-11T12:00Z')).roundName, 'JLS23BR1');
    assert.equal(getWindow('EMRL', config, at('2026-11-11T12:00Z')).roundName, 'EMRLS9R1');
});

test('/report round: the last race before this week', () => {
    assert.equal(reportRound('UL', config, at('2026-10-06T12:00Z')), 'ULS26R1');
    // Break week: still the R5 just raced.
    assert.equal(reportRound('UL', config, at('2026-11-04T12:00Z')), 'ULS26R5');
});

test('lineup seasons change the Monday after the last race', () => {
    assert.equal(currentSeason('UL', config, at('2026-11-07T12:00Z')).title, 'UL Season 26 - Autumn 2026');
    assert.equal(currentSeason('UL', config, at('2026-12-21T12:00Z')).title, 'UL Season 27 - Winter 2027');
    assert.equal(currentSeason('JL', config, at('2026-11-07T12:00Z')).title, 'JL Season 23B - Late Autumn 2026');
});
