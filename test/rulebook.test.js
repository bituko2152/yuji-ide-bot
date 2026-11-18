const test = require('node:test');
const assert = require('node:assert/strict');
const { penaltyFor, bansReached, CHOICES, INFRACTIONS } = require('../services/stewards/rulebook');

test('escalation tables give the race total: each incident adds the difference', () => {
    // 2 L-FOT = 4 s in total: the 2nd adds 2 s.
    assert.deepEqual(penaltyFor('LFOT', 2), { seconds: 2, warning: false, dsq: false, ppts: 1, total: 4 });
    // 3 M-FOT = 10 s: the 3rd adds 4 s; the 4th is a DSQ.
    assert.equal(penaltyFor('MFOT', 3).seconds, 4);
    assert.equal(penaltyFor('MFOT', 4).dsq, true);
});

test('TM: a warning first, then +1, +1, +1, +2, then +2 per TM', () => {
    assert.equal(penaltyFor('TM', 1).warning, true);
    assert.deepEqual([2, 3, 4, 5, 6, 7].map(n => penaltyFor('TM', n).seconds), [1, 1, 1, 2, 2, 2]);
});

test('UR: one second per car impeded', () => {
    assert.equal(penaltyFor('UR', 1, 3).seconds, 3);
    assert.equal(penaltyFor('UR', 1, 3).ppts, 1);
});

test('straight DSQs and their points', () => {
    assert.deepEqual([penaltyFor('IC', 1).dsq, penaltyFor('IC', 1).ppts], [true, 5]);
    assert.deepEqual([penaltyFor('LA', 1).dsq, penaltyFor('LA', 1).ppts], [true, 10]);
});

test('TP: warnings until the third', () => {
    assert.equal(penaltyFor('TP', 2).warning, true);
    assert.equal(penaltyFor('TP', 3).dsq, true);
});

test('bans when the points cross 10, 18, 22 and 23', () => {
    assert.deepEqual(bansReached(8, 11), ['race ban (10 points)']);
    assert.deepEqual(bansReached(17, 23), ['race ban (18 points)', 'race ban (22 points)', 'season ban (23+ points)']);
    assert.deepEqual(bansReached(10, 12), []);
});

test('every voting choice points to known infractions', () => {
    assert.equal(CHOICES.length, 10);
    for (const c of CHOICES) for (const i of c.infractions) assert.ok(INFRACTIONS[i], i);
});
