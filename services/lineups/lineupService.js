const fs = require('fs');
const path = require('path');
const { TextDisplayBuilder, MessageFlags } = require('discord.js');
const { select } = require('../core/supabase');
const { mondayUtc, weekStartAt, WEEK_MS } = require('../starters/starterCalendar');

/*
 * The current grid of each PC league, as one message per season in the
 * league's lineup channel (config "lineups": { "UL": "<channel id>", ... }):
 *
 *   # UL Season 26 - Autumn 2026
 *
 *   1️⃣ 🇯🇵 🇱🇻 **OneTime Nismo RS [ONE]** | @Team
 *   Owners - 🇯🇵 @a / 🇱🇻 @b
 *   Team Principal - 🇭🇺 @c       (optional)
 *   Drivers - 🇯🇵 @d / [VACANT]
 *   Reserve - 🇱🇻 @e
 *
 * data/lineups.json keeps it for good (not cleaned up like contracts). Drivers
 * and reserves come from contracts and /release; owners also from roles (team
 * role + league manager role). Teams are the league's ones in config team_roles,
 * ordered by last season's constructors' standings (new teams last). "Edit message" on it changes the stored grid,
 * so a person can fix anything. The Monday after a season's last race (JL:
 * after A and after B) a new message is posted, seats are emptied and drivers
 * lose the team role (owners and principals keep it).
 */

const storeFile = path.join(__dirname, '../../data/lineups.json');
const VACANT = '[VACANT]';
const WHITE_FLAG = '🏳️';
const MAIN_SEATS = 2;
const RESERVE_SEATS = 1;
const CHECK_MS = 15 * 60 * 1000;
const MAX_TEXT = 4000; // a text display holds 4000 characters, a plain message only 2000
const VERSION = 2; // a grid stored by an older version is read again from the channel
const NUMBERS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

const loadConfig = () => JSON.parse(fs.readFileSync(path.join(__dirname, '../../config.json'), 'utf-8'));
function readAll() {
    try { return JSON.parse(fs.readFileSync(storeFile, 'utf-8')); } catch { return {}; }
}
function writeAll(all) {
    fs.writeFileSync(storeFile, JSON.stringify(all, null, 2));
}
const lineupLeagues = config => Object.keys(config.lineups || {});

// ---------------------------------------------------------------- season

const SEASONS = ['Winter', 'Winter', 'Spring', 'Spring', 'Spring', 'Summer', 'Summer', 'Summer', 'Autumn', 'Autumn', 'Autumn', 'Winter'];

/**
 * The season whose grid is current at `now`: it starts the Monday after the
 * previous season's last race. { key: 'S26' | 'S23A', title }.
 */
function currentSeason(cat, config, now = Date.now()) {
    const s = config.starters;
    const first = mondayUtc(new Date(`${s.first_race_date}T00:00:00Z`));
    const idx = Math.floor((weekStartAt(now) - first) / WEEK_MS);
    let cycle = Math.floor(idx / 13);
    const pos = ((idx % 13) + 13) % 13;
    const halves = s.format[cat] === 'AB';
    let half = null;
    if (pos >= 11) cycle++; // after the last race: next season
    if (halves) half = pos >= 5 && pos < 11 ? 'B' : 'A';
    const number = s.first_season[cat] + cycle;
    const start = new Date(first + (cycle * 13 + (half === 'B' ? 6 : 0)) * WEEK_MS);
    const season = SEASONS[start.getUTCMonth()];
    const year = start.getUTCFullYear() + (start.getUTCMonth() === 11 ? 1 : 0);
    const label = half ? `${half === 'A' ? 'Early' : 'Late'} ${season}` : season;
    const key = `S${number}${half || ''}`;
    return { key, title: `${cat} Season ${number}${half || ''} - ${label} ${year}` };
}

// ---------------------------------------------------------------- text <-> grid

const MENTION = /<@!?(\d+)>/;

// "🇯🇵 <@123>" -> { flag, id }; "[VACANT]" -> null; "🇮🇹 @Big Brobb" (not a
// member Yuji can find) -> { flag, text }, kept as written.
function parsePerson(part, where) {
    const p = part.replace(/\s+/g, ' ').trim();
    if (!p || p.toLowerCase() === VACANT.toLowerCase()) return null;
    const m = p.match(MENTION);
    if (m) return { id: m[1], flag: p.slice(0, m.index).trim() || null };
    const at = p.indexOf('@');
    if (at < 0) throw new Error(`${where}: "${p}" is not a member (@name) or ${VACANT}`);
    return { text: p.slice(at), flag: p.slice(0, at).trim() || null };
}
const people = (text, where) => text.split('/').map(p => parsePerson(p, where));

/**
 * The message text -> { title, teams: [{ roleId, flag, owners, principals, drivers, reserves }] }.
 * Throws with the line that's wrong.
 */
function parseLineup(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const titleLine = lines.shift() || '';
    const title = titleLine.replace(/\s+/g, ' ').replace(/^#+\s*/, '').replace(/^\*\*|\*\*$/g, '').trim();
    if (!/\bSeason\s/i.test(title)) throw new Error(`First line must be the title "# … Season …", not "${titleLine}"`);
    const teams = [];
    for (const line of lines) {
        const role = line.match(/<@&(\d+)>/);
        if (role) {
            let before = line.slice(0, role.index);
            const name = before.match(/\*\*(.+?)\*\*/)?.[1].trim() || null;
            before = before.replace(/\*\*.+?\*\*/, '').replace(/\|/g, '');
            const flag = NUMBERS.reduce((t, n) => t.replace(n, ''), before).replace(/^\s*\d+[.)]?/, '').replace(/\s+/g, ' ').trim();
            teams.push({ roleId: role[1], name, flag: flag || null, owners: [], principals: [], drivers: [], reserves: [] });
            continue;
        }
        const m = line.match(/^(Owners?|(?:Team )?Principals?|Drivers?|Reserves?)\s*[-–—:]\s*(.*)$/i);
        if (!m) throw new Error(`Line not understood: "${line}"`);
        const team = teams[teams.length - 1];
        if (!team) throw new Error(`"${line}" comes before any team line (number, flag, @Team)`);
        const kind = m[1].toLowerCase().replace(/^team /, '').replace(/s$/, '');
        const list = people(m[2], line);
        if (kind === 'owner') team.owners = list.filter(Boolean);
        else if (kind === 'principal') team.principals = list.filter(Boolean);
        else if (kind === 'driver') team.drivers = list;
        else team.reserves = list;
    }
    if (!teams.length) throw new Error('No team lines (number, flags, **Team [ABC]** | @Team) found');
    for (const t of teams) {
        if (t.drivers.length > MAIN_SEATS) throw new Error(`<@&${t.roleId}> has more than ${MAIN_SEATS} drivers`);
        if (t.reserves.length > RESERVE_SEATS) throw new Error(`<@&${t.roleId}> has more than ${RESERVE_SEATS} reserve`);
        while (t.drivers.length < MAIN_SEATS) t.drivers.push(null);
        while (t.reserves.length < RESERVE_SEATS) t.reserves.push(null);
    }
    return { title, teams };
}

// ISO code -> flag emoji ("jp" -> 🇯🇵).
const flagEmoji = code => (/^[a-z]{2}$/i.test(code || '')
    ? [...code.toUpperCase()].map(c => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65)).join('')
    : null);

async function supabaseFlags(ids) {
    if (!ids.length) return {};
    const rows = await select('drivers', 'discord_id,country_code', { discord_id: `in.(${ids.join(',')})` }).catch(err => {
        console.error('❌ [Lineups] Flags not loaded:', err.message);
        return [];
    });
    return Object.fromEntries(rows.map(r => [r.discord_id, flagEmoji(r.country_code)]).filter(([, f]) => f));
}

// Full team names ("OneTime Nismo RS") for teams the message didn't name yet.
async function teamNames(shorts) {
    if (!shorts.length) return {};
    const rows = await select('teams', 'name,short_name', { short_name: `in.(${shorts.join(',')})` }).catch(() => []);
    return Object.fromEntries(rows.map(r => [r.short_name, r.name]));
}

async function renderLineup(lineup) {
    const config = loadConfig();
    const all = lineup.teams.flatMap(t => [...t.owners, ...t.principals, ...t.drivers, ...t.reserves]).filter(p => p?.id);
    const flags = await supabaseFlags([...new Set(all.map(p => p.id))]);
    const short = t => config.team_roles[t.roleId]?.name;
    const names = await teamNames(lineup.teams.filter(t => !t.name && short(t)).map(short));
    const person = p => (p ? `${flags[p.id] || p.flag || WHITE_FLAG} ${p.id ? `<@${p.id}>` : p.text}` : VACANT);
    const list = ps => ps.map(person).join(' / ');
    const out = [`# ${lineup.title}`];
    lineup.teams.forEach((t, i) => {
        const name = t.name || (names[short(t)] ? `${names[short(t)]} [${short(t)}]` : `[${short(t) || '?'}]`);
        out.push('', `${NUMBERS[i] || `${i + 1}.`} ${t.flag ? `${t.flag} ` : ''}**${name}** | <@&${t.roleId}>`);
        out.push(`${t.owners.length > 1 ? 'Owners' : 'Owner'} - ${t.owners.length ? list(t.owners) : VACANT}`);
        if (t.principals.length) out.push(`Team Principal - ${list(t.principals)}`);
        out.push(`Drivers - ${list(t.drivers)}`);
        out.push(`Reserve - ${list(t.reserves)}`);
    });
    return out.join('\n');
}

// ---------------------------------------------------------------- Discord

async function channelOf(client, cat) {
    const id = loadConfig().lineups?.[cat];
    return id ? client.channels.fetch(id).catch(() => null) : null;
}

/**
 * The order of the teams: last season's constructors' standings in that
 * league (JL: the previous half), teams that weren't in it at the end.
 * Returns team role ids.
 */
async function teamOrder(cat, seasonKey) {
    const config = loadConfig();
    const [, n, half] = seasonKey.match(/^S(\d+)([AB])?$/);
    const prev = half === 'B' ? { number: +n, division: 'A' } : { number: +n - 1, division: half ? 'B' : null };
    const filters = { league: `eq.${cat}`, number: `eq.${prev.number}`, order: 'standing.asc' };
    if (prev.division) filters.division = `eq.${prev.division}`;
    const [rows, aliases] = await Promise.all([
        select('v_team_standings', 'team_id,short_name,standing', filters),
        select('team_aliases', 'team_id,short_name', { short_name: 'not.is.null' })
    ]).catch(err => {
        console.error(`❌ [Lineups] ${cat}: standings not loaded (${err.message}).`);
        return [[], []];
    });
    const rank = name => {
        const i = rows.findIndex(r => r.short_name === name || aliases.some(a => a.short_name === name && a.team_id === r.team_id));
        return i < 0 ? Infinity : i;
    };
    const teams = Object.entries(config.team_roles).filter(([, t]) => t.league === cat);
    return teams.map(([roleId, t], i) => ({ roleId, rank: rank(t.name), i }))
        .sort((a, b) => a.rank - b.rank || a.i - b.i)
        .map(t => t.roleId);
}

const emptyTeam = roleId => ({ roleId, flag: null, owners: [], principals: [], drivers: Array(MAIN_SEATS).fill(null), reserves: Array(RESERVE_SEATS).fill(null) });

// The teams are the league's ones in config team_roles, in the season's order.
function syncTeams(cat, lineup) {
    const config = loadConfig();
    const ids = Object.entries(config.team_roles).filter(([, t]) => t.league === cat).map(([id]) => id);
    const order = lineup.order || [];
    const pos = id => (order.includes(id) ? order.indexOf(id) : order.length + ids.indexOf(id));
    lineup.teams = ids.map(id => lineup.teams.find(t => t.roleId === id) || emptyTeam(id)).sort((a, b) => pos(a.roleId) - pos(b.roleId));
}

// Whether someone is owner / principal of another team of the grid (and only drives here).
const staffElsewhere = (lineup, team, id) => lineup.teams.some(t => t !== team && [...t.owners, ...t.principals].some(p => p.id === id));

// Owners also from roles: holds the team role and the league manager role.
async function syncOwners(client, cat, lineup) {
    syncTeams(cat, lineup);
    const config = loadConfig();
    const managerRole = config.league_manager_roles?.[cat];
    const channel = await channelOf(client, cat);
    if (!channel || !managerRole) return;
    const members = await channel.guild.members.fetch().catch(() => null);
    if (!members) return;
    for (const team of lineup.teams) {
        const holders = members.filter(m => m.roles.cache.has(team.roleId));
        const managers = holders.filter(m => m.roles.cache.has(managerRole));
        const staff = new Set([...team.owners, ...team.principals].map(p => p.id));
        team.owners = team.owners.filter(p => holders.has(p.id));
        team.principals = team.principals.filter(p => holders.has(p.id));
        // An owner of one team can be a driver or reserve of another: not an owner there.
        const seated = new Set([...team.drivers, ...team.reserves].filter(p => p?.id).map(p => p.id));
        for (const m of managers.values()) if (!staff.has(m.id) && !seated.has(m.id) && !staffElsewhere(lineup, team, m.id)) team.owners.push({ id: m.id, flag: null });
    }
}

// Rewrites the league's message from the stored grid.
async function refreshMessage(client, cat) {
    const all = readAll();
    const lineup = all[cat];
    if (!lineup) return;
    await syncOwners(client, cat, lineup);
    writeAll({ ...readAll(), [cat]: lineup });
    const channel = await channelOf(client, cat);
    const message = channel && lineup.messageId && await channel.messages.fetch(lineup.messageId).catch(() => null);
    const text = await renderLineup(lineup);
    if (message?.flags.has(MessageFlags.IsComponentsV2)) {
        if (messageText(message) !== text) await message.edit(payload(text));
    } else if (channel) {
        // A plain message from an older version can't hold a long grid: replaced.
        if (message) await message.delete().catch(() => { });
        await postMessage(channel, cat, lineup, text);
    }
}

// The grid as a text display, so it can be longer than a plain message.
const payload = text => ({
    components: [new TextDisplayBuilder().setContent(text.slice(0, MAX_TEXT))],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] }
});

/** A lineup message's text (in its text display), or a plain message's content. */
const messageText = message => message.content || message.components?.[0]?.content || '';

async function postMessage(channel, cat, lineup, text) {
    const sent = await channel.send(payload(text));
    lineup.messageId = sent.id;
    writeAll({ ...readAll(), [cat]: lineup });
    // Editable with "Edit message" like a /message one.
    require('../messages/messageService').remember(sent.id, { guildId: channel.guildId, channelId: channel.id, by: channel.client.user.id, at: Date.now(), lineup: cat });
}

function teamOf(lineup, roleId) {
    let team = lineup.teams.find(t => t.roleId === roleId);
    if (!team) lineup.teams.push(team = emptyTeam(roleId));
    return team;
}

function removeDriver(lineup, userId) {
    let removed = false;
    for (const t of lineup.teams) {
        t.drivers = t.drivers.map(p => (p?.id === userId ? (removed = true, null) : p));
        t.reserves = t.reserves.map(p => (p?.id === userId ? (removed = true, null) : p));
    }
    return removed;
}

// ---------------------------------------------------------------- used by contracts / release

/**
 * Whether the team has a free seat of that kind, counting offers already
 * accepted and waiting for their 24 h. True for leagues without a grid.
 */
function hasFreeSeat(cat, teamRoleId, seatType, pendingUserIds = []) {
    const lineup = readAll()[cat];
    if (!lineup) return true;
    const team = lineup.teams.find(t => t.roleId === teamRoleId);
    const seats = seatType === 'reserve' ? (team?.reserves || []) : (team?.drivers || []);
    const max = seatType === 'reserve' ? RESERVE_SEATS : MAIN_SEATS;
    const taken = seats.filter(Boolean).length + pendingUserIds.filter(id => !seats.some(p => p?.id === id)).length;
    return taken < max;
}

async function signDriver(client, cat, teamRoleId, userId, seatType) {
    const all = readAll();
    const lineup = all[cat];
    if (!lineup) return;
    removeDriver(lineup, userId);
    const team = teamOf(lineup, teamRoleId);
    const seats = seatType === 'reserve' ? team.reserves : team.drivers;
    const free = seats.indexOf(null);
    if (free >= 0) seats[free] = { id: userId, flag: null };
    else seats.push({ id: userId, flag: null }); // over the limit: shown, so a person fixes it
    writeAll({ ...all, [cat]: lineup });
    await refreshMessage(client, cat);
}

async function releaseDriver(client, cat, userId) {
    const all = readAll();
    const lineup = all[cat];
    if (!lineup || !removeDriver(lineup, userId)) return;
    writeAll({ ...all, [cat]: lineup });
    await refreshMessage(client, cat);
}

/** Team role ids someone is owner / principal of in a league's grid. */
function staffTeams(cat, userId) {
    return (readAll()[cat]?.teams || []).filter(t => [...t.owners, ...t.principals].some(p => p.id === userId)).map(t => t.roleId);
}

/** The team role id someone drives (main or reserve) for in a league's grid, or null. */
function seatTeam(cat, userId) {
    return (readAll()[cat]?.teams || []).find(t => [...t.drivers, ...t.reserves].some(p => p?.id === userId))?.roleId || null;
}

// ---------------------------------------------------------------- "Edit message"

const lineupOfMessage = messageId => Object.entries(readAll()).find(([, l]) => l.messageId === messageId)?.[0] || null;

/** Checks an edited text; stores it if valid. Returns the error text, or null. */
function applyEdit(messageId, text) {
    const cat = lineupOfMessage(messageId);
    if (!cat) return null;
    let parsed;
    try { parsed = parseLineup(text); } catch (err) { return err.message; }
    const all = readAll();
    all[cat] = { ...all[cat], title: parsed.title, teams: parsed.teams };
    writeAll(all);
    return null;
}

// ---------------------------------------------------------------- start / new season

// No grid yet (or one read by an older version): the newest lineup message
// people posted in the channel becomes Yuji's own (his message is reused).
async function importLineup(client, cat) {
    const channel = await channelOf(client, cat);
    if (!channel) return console.warn(`⚠️ [Lineups] ${cat}: lineup channel not found.`);
    const messages = await channel.messages.fetch({ limit: 30 }).catch(() => null);
    const old = messages && [...messages.values()].find(m => !m.author.bot && /\bSeason\s/i.test(m.content.split('\n')[0]) && /<@&\d+>/.test(m.content));
    let parsed;
    try { parsed = old ? parseLineup(old.content) : null; } catch (err) {
        return console.error(`❌ [Lineups] ${cat}: last lineup message not understood (${err.message}).`);
    }
    if (!parsed) return console.warn(`⚠️ [Lineups] ${cat}: no lineup message to start from.`);
    const season = currentSeason(cat, loadConfig());
    const lineup = { version: VERSION, season: season.key, title: parsed.title, teams: parsed.teams, order: await teamOrder(cat, season.key), messageId: readAll()[cat]?.messageId || null };
    writeAll({ ...readAll(), [cat]: lineup });
    await refreshMessage(client, cat);
    console.log(`✅ [Lineups] ${cat}: started from the message of ${old.author.tag}.`);
}

async function newSeason(client, cat, season) {
    const lineup = readAll()[cat];
    const channel = await channelOf(client, cat);
    if (!channel) return;
    await syncOwners(client, cat, lineup);
    const members = await channel.guild.members.fetch();
    let removed = 0;
    for (const team of lineup.teams) {
        const staff = new Set([...team.owners, ...team.principals].map(p => p.id));
        const drivers = members.filter(m => m.roles.cache.has(team.roleId) && !staff.has(m.id));
        for (const m of drivers.values()) {
            await m.roles.remove(team.roleId).then(() => removed++, err => console.error(`❌ [Lineups] ${m.user.tag}:`, err.message));
        }
        team.drivers = Array(MAIN_SEATS).fill(null);
        team.reserves = Array(RESERVE_SEATS).fill(null);
    }
    const next = { ...lineup, version: VERSION, season: season.key, title: season.title, order: await teamOrder(cat, season.key), messageId: null };
    writeAll({ ...readAll(), [cat]: next });
    await postMessage(channel, cat, next, await renderLineup(next));
    console.log(`🏁 [Lineups] ${cat}: ${season.title} posted, team role removed from ${removed} driver(s).`);
}

function startLineupLoop(client) {
    let first = true;
    const check = async () => {
        const config = loadConfig();
        for (const cat of lineupLeagues(config)) {
            try {
                const lineup = readAll()[cat];
                const season = currentSeason(cat, config);
                if (!lineup || lineup.version !== VERSION) await importLineup(client, cat);
                else if (lineup.season !== season.key) await newSeason(client, cat, season);
                else if (first) await refreshMessage(client, cat); // on start: catch up with what changed while off
            } catch (err) {
                console.error(`❌ [Lineups] ${cat}:`, err.message);
            }
        }
        first = false;
    };
    check();
    setInterval(check, CHECK_MS);
}

module.exports = {
    startLineupLoop, hasFreeSeat, signDriver, releaseDriver, staffTeams, seatTeam,
    applyEdit, lineupOfMessage, refreshMessage, messageText, MAX_TEXT, currentSeason, parseLineup, renderLineup, teamOrder
};
