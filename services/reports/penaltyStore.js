const db = require('../core/supabase');

/*
 * Every penalty result Yuji posts is kept in Supabase "penalties", one row per
 * report (a rectification updates it, "No penalty" removes it). Results are
 * never changed: time_ms / positions / dsq / dnf are applied (warning: nothing)
 * wherever the classification is computed. race_id is set once that round's
 * results are uploaded (/results upload).
 */

// "JLS22AR1" / "JL S22A R1" -> { league, season, division, round }
function parseRound(text) {
    const m = String(text || '').replace(/\s+/g, '').match(/^(UL|CL|JL|AL)S?(\d+)([AB])?R(\d+)$/i);
    return m ? { league: m[1].toUpperCase(), season: Number(m[2]), division: m[3]?.toUpperCase() || null, round: Number(m[4]) } : null;
}

// "3.00s" / "2 positions" / "DSQ + sent to the URA" / "DNF" -> what to apply.
function amounts(kind, penalty) {
    const k = String(kind).toLowerCase(), p = String(penalty);
    const n = parseFloat(p.replace(',', '.'));
    return {
        time_ms: k.startsWith('time') && Number.isFinite(n) ? Math.round(n * 1000) : 0,
        positions: k.startsWith('position') && Number.isFinite(n) ? Math.round(n) : 0,
        warning: k === 'warning',
        dsq: k === 'dsq',
        dnf: k === 'dnf'
    };
}

// "Level 2" -> "L2" (the codes of reportService LEVELS).
const LEVEL_CODES = { 'level 1': 'L1', 'level 2': 'L2', 'level 3': 'L3', intentional: 'INT', malicious: 'MAL', lag: 'LAG' };

async function seasonIdOf(r) {
    const [league] = await db.select('leagues', 'id', { code: `eq.${r.league}` });
    if (!league) return null;
    const [season] = await db.select('seasons', 'id', { league_id: `eq.${league.id}`, number: `eq.${r.season}`, division: r.division ? `eq.${r.division}` : 'is.null' });
    return season?.id ?? null;
}

async function raceIdOf(seasonId, round) {
    if (!seasonId) return null;
    const [race] = await db.select('races', 'id', { season_id: `eq.${seasonId}`, round: `eq.${round}` });
    return race?.id ?? null;
}

/**
 * p: { reportId, resultMessageId, replacedMessageId, discordId, round,
 *      level, offense, kind, penalty, proof, stewardId, at }
 * The row is the report's (report_id), or the one of the result this replaces.
 */
async function savePenalty(p) {
    const [existing] = [
        ...(p.reportId ? await db.select('penalties', 'id', { report_id: `eq.${p.reportId}` }) : []),
        ...(p.replacedMessageId ? await db.select('penalties', 'id', { result_message_id: `eq.${p.replacedMessageId}` }) : [])
    ];
    if (p.kind === 'No penalty') return existing && db.remove('penalties', { id: `eq.${existing.id}` });
    const r = parseRound(p.round);
    if (!r) throw new Error(`round "${p.round}" not understood`);
    const [driver] = await db.select('drivers', 'id', { discord_id: `eq.${p.discordId}` });
    const seasonId = await seasonIdOf(r);
    const row = {
        report_id: p.reportId || null,
        result_message_id: p.resultMessageId,
        discord_id: p.discordId,
        driver_id: driver?.id ?? null,
        season_id: seasonId,
        round: r.round,
        race_id: await raceIdOf(seasonId, r.round),
        level: p.level || LEVEL_CODES[String(p.offense).toLowerCase()] || null,
        ...amounts(p.kind, p.penalty),
        proof: p.proof || null,
        steward_discord_id: p.stewardId || null,
        decided_at: new Date(p.at || Date.now()).toISOString()
    };
    if (existing) {
        if (!p.reportId) delete row.report_id; // keep the one it may already have
        return db.update('penalties', { id: `eq.${existing.id}` }, row);
    }
    return db.insert('penalties', [row]);
}

/** After /results upload: the penalties of that round get its race. */
async function linkRace({ league, season, division, round }) {
    const seasonId = await seasonIdOf({ league, season, division });
    const raceId = await raceIdOf(seasonId, round);
    if (!raceId) return;
    await db.update('penalties', { season_id: `eq.${seasonId}`, round: `eq.${round}`, race_id: 'is.null' }, { race_id: raceId });
}

module.exports = { savePenalty, linkRace, parseRound, amounts };
