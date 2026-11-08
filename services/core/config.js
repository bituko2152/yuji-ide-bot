const fs = require('fs');
const path = require('path');

/*
 * The only reader of config.json. The file is organised by server and by
 * league (see config.example.json); readConfig() also gives the lists the rest
 * of the code uses (team_roles, starters.format...), built from it. It's read
 * every time, so a hand edit applies without a restart. The bot never writes
 * to config.json: /report's rounds live in data/reportRounds.json.
 */

const configFile = path.join(__dirname, '../../config.json');
const roundsFile = path.join(__dirname, '../../data/reportRounds.json');

function readRounds() {
    try { return JSON.parse(fs.readFileSync(roundsFile, 'utf-8')); } catch { return {}; }
}

function setReportRounds(rounds) {
    fs.writeFileSync(roundsFile, JSON.stringify({ ...readRounds(), ...rounds }, null, 2));
}

// { UL: { x: 1 }, CL: {} } -> only the leagues that have that value.
function perLeague(leagues, pick) {
    const out = {};
    for (const [code, league] of Object.entries(leagues)) {
        const value = pick(league);
        if (value !== undefined && value !== null) out[code] = value;
    }
    return out;
}

function expand(raw) {
    const leagues = raw.leagues;
    const rounds = readRounds();
    const servers = Object.entries(raw.servers);
    const perServer = pick => Object.fromEntries(servers
        .filter(([, s]) => pick(s))
        .map(([name, s]) => [name === 'main' ? 'main' : s.id, pick(s)]));

    const team_roles = {};
    for (const [code, league] of Object.entries(leagues)) {
        for (const [name, team] of Object.entries(league.teams || {})) {
            team_roles[team.role] = { league: code, name, ...(team.color ? { color: team.color } : {}) };
        }
    }
    const calendar = key => perLeague(leagues, l => l.calendar?.[key]);

    return {
        ...raw,
        extra_servers: servers.filter(([, s]) => s.id).map(([, s]) => ({ id: s.id, commands: s.commands || [] })),
        messages: perServer(s => s.message_roles && { roles: s.message_roles, log_channel: s.log_channel }),
        dotd: perServer(s => s.dotd_roles && { roles: s.dotd_roles }),
        incidents: perServer(s => s.incident_roles && { roles: s.incident_roles }),
        reports_channel: raw.reports?.channel,
        report_results_channel: raw.reports?.results_channel,
        report_announcements_channel: raw.reports?.announcements_channel,
        stewards_role: raw.reports?.stewards_role,
        lineups: perLeague(leagues, l => l.channels?.lineup),
        report_leagues: perLeague(leagues, l => (l.report ? { active: true, round: rounds[l.code] } : undefined)),
        league_channels: perLeague(leagues, l => l.channels?.contracts),
        league_manager_roles: perLeague(leagues, l => l.roles?.manager),
        league_driver_roles: perLeague(leagues, l => l.roles?.driver),
        seat_roles: perLeague(leagues, l => (l.roles?.main ? { main: l.roles.main, reserve: l.roles.reserve } : undefined)),
        team_roles,
        starters: {
            ...raw.calendar,
            channels: perLeague(leagues, l => l.channels?.starters),
            closes: calendar('closes'),
            first_season: calendar('first_season'),
            format: calendar('format'),
            independent_slots: calendar('independent_slots'),
            from: calendar('from')
        },
        mocks: { ...raw.mocks, schedule_channels: perLeague(leagues, l => l.channels?.schedule) }
    };
}

function readConfig() {
    const raw = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    if (!raw.servers || !raw.leagues) {
        throw new Error('config.json is in the old format: it needs "servers" and "leagues" (see config.example.json)');
    }
    for (const [code, league] of Object.entries(raw.leagues)) league.code = code;
    return expand(raw);
}

module.exports = { readConfig, setReportRounds };
