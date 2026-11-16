const fs = require('fs');
const path = require('path');
const db = require('../core/supabase');
const { readConfig } = require('../core/config');

/*
 * Every penalty result Yuji posts is kept in Supabase "penalties", one row per
 * report (a rectification updates it, "No penalty" removes it). Results are
 * never changed: time_ms / positions / warning / dsq / dnf are applied
 * wherever the classification is computed. race_id is set once that round's
 * results are uploaded (/results upload).
 *
 * The first time, the whole results channel is read so the results Yuji
 * posted before are saved too (data/penaltiesBackfill.json marks it done).
 */

const doneFile = path.join(__dirname, '../../data/penaltiesBackfill.json');

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

async function raceIdOf(r) {
    const [league] = await db.select('leagues', 'id', { code: `eq.${r.league}` });
    if (!league) return null;
    const filters = { league_id: `eq.${league.id}`, number: `eq.${r.season}`, division: r.division ? `eq.${r.division}` : 'is.null' };
    const [season] = await db.select('seasons', 'id', filters);
    if (!season) return null;
    const [race] = await db.select('races', 'id', { season_id: `eq.${season.id}`, round: `eq.${r.round}` });
    return race?.id ?? null;
}

/**
 * p: { key, reportId, resultMessageId, replacedMessageId, discordId, round,
 *      level, offense, kind, penalty, proof, stewardId, at, rectified }
 */
async function savePenalty(p) {
    // A row saved from the channel (key "msg:…") for the result this one replaces.
    if (p.replacedMessageId) await db.remove('penalties', { result_message_id: `eq.${p.replacedMessageId}`, key: `neq.${p.key}` });
    if (p.kind === 'No penalty') return db.remove('penalties', { key: `eq.${p.key}` });
    const r = parseRound(p.round);
    if (!r) throw new Error(`round "${p.round}" not understood`);
    const [driver] = await db.select('drivers', 'id', { discord_id: `eq.${p.discordId}` });
    await db.upsert('penalties', [{
        key: p.key,
        report_id: p.reportId || null,
        result_message_id: p.resultMessageId,
        discord_id: p.discordId,
        driver_id: driver?.id ?? null,
        ...r,
        race_id: await raceIdOf(r),
        level: p.level || null,
        offense: p.offense,
        kind: p.kind,
        penalty: p.penalty,
        ...amounts(p.kind, p.penalty),
        proof: p.proof || null,
        steward_discord_id: p.stewardId || null,
        decided_at: new Date(p.at || Date.now()).toISOString(),
        rectified: p.rectified || 0
    }], 'key');
}

/** After /results upload: the penalties of that round get its race. */
async function linkRace({ league, season, division, round }) {
    const raceId = await raceIdOf({ league, season, division, round });
    if (!raceId) return;
    await db.update('penalties', {
        league: `eq.${league}`, season: `eq.${season}`, division: division ? `eq.${division}` : 'is.null',
        round: `eq.${round}`, race_id: 'is.null'
    }, { race_id: raceId });
}

// ---------------------------------------------------------------- results already posted

// "**Report:** <@1> | UL | S26 | R5\n**Result:** Level 2 | Time penalty\n**Penalty:** 3.00s\n**Proof:** …"
function parseResult(text) {
    const report = text.match(/\*\*Report:\*\*\s*<@!?(\d+)>\s*\|\s*(.+)/);
    const result = text.match(/\*\*Result:\*\*\s*(.+?)\s*\|\s*(.+)/);
    const penalty = text.match(/\*\*Penalty:\*\*\s*(.+)/);
    if (!report || !result || !penalty) return null;
    return {
        discordId: report[1],
        round: report[2].replace(/\|/g, ''),
        offense: result[1].trim(),
        kind: result[2].trim(),
        penalty: penalty[1].trim(),
        proof: text.match(/\*\*Proof:\*\*\s*(.+)/)?.[1].trim() || null,
        reportId: text.match(/Report #(\S+?)\*\*/)?.[1] || null
    };
}

async function backfill(client) {
    if (fs.existsSync(doneFile)) return;
    const channelId = readConfig().report_results_channel;
    const channel = channelId && await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return console.warn('⚠️ [Penalties] Results channel not found: nothing saved from it.');

    // Oldest first, so a rectification comes after the result it corrects.
    const messages = [];
    for (let before; ;) {
        const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        if (!page.size) break;
        messages.push(...page.values());
        before = page.lastKey();
    }
    messages.reverse();

    const keyOf = new Map(); // result message id -> key of its report
    let saved = 0;
    for (const m of messages) {
        if (m.author.id !== client.user.id) continue;
        const r = parseResult(m.embeds[0]?.description || '');
        if (!r) continue;
        const replied = m.reference?.messageId;
        const key = (replied && keyOf.get(replied)) || (r.reportId ? `report:${r.reportId}` : `msg:${m.id}`);
        keyOf.set(m.id, key);
        const rectified = /Rectification/.test(m.embeds[0].description) ? 1 : 0;
        await savePenalty({ ...r, key, resultMessageId: m.id, at: m.createdTimestamp, rectified })
            .then(() => saved++, err => console.error(`❌ [Penalties] ${m.url}:`, err.message));
    }
    fs.writeFileSync(doneFile, JSON.stringify({ at: Date.now(), saved }));
    console.log(`✅ [Penalties] ${saved} result(s) posted before saved from the results channel.`);
}

module.exports = { savePenalty, linkRace, backfill, parseRound, parseResult, amounts };
