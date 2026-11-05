const { select } = require('./supabase');

/*
 * The PC teams' colors come from Supabase (teams.color), kept in memory and
 * refreshed every hour so a message never waits for the database. Mobile teams
 * aren't in Supabase: their color stays in config team_roles.
 */

const PC_LEAGUES = new Set(['UL', 'CL', 'JL', 'AL']);
const REFRESH_MS = 60 * 60 * 1000;
let colors = new Map(); // short name -> color

async function refresh() {
    const [rows, aliases] = await Promise.all([
        select('teams', 'id,short_name,color', { color: 'not.is.null' }),
        select('team_aliases', 'team_id,short_name', { short_name: 'not.is.null' })
    ]);
    const next = new Map(rows.filter(t => t.short_name).map(t => [t.short_name, t.color]));
    // A team's old short name (config "ASN" is teams "RSR").
    for (const a of aliases) {
        const team = rows.find(t => t.id === a.team_id);
        if (team && !next.has(a.short_name)) next.set(a.short_name, team.color);
    }
    colors = next;
}

/** A team_roles entry's color; undefined when there's none, so callers use their default. */
function teamColor(team) {
    return (PC_LEAGUES.has(team?.league) && colors.get(team.name)) || team?.color;
}

function startTeamColors() {
    const run = () => refresh().catch(err => console.error('❌ [Teams] Colors not loaded:', err.message));
    setInterval(run, REFRESH_MS);
    return run();
}

module.exports = { teamColor, startTeamColors };
