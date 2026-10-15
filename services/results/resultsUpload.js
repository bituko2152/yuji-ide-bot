const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const fs = require('fs');
const path = require('path');
const db = require('../core/supabase');
const starterStore = require('../starters/starterStore');

/*
 * /results upload: saves the CSVs made by /results listen into Supabase.
 *
 *  - race CSV (required) + qualifying CSV(s): "quali" (Q, or Q1) and "q2"
 *    (leagues with Q1/Q2 per config results.q2_leagues; others need the
 *    division A/B instead).
 *  - Qualifying is not a session in the DB: each race row gets grid and
 *    quali_time_ms. With Q2: Q2 drivers first by their Q2 time, then the rest
 *    by their Q1 time; quali_time_ms is the Q2 time, or Q1 if they didn't reach Q2.
 *  - Raw track results only (penalties are applied separately): DNFs after
 *    the finishers, fastest lap = best lap of ALL drivers (DNFs included),
 *    times rounded to hundredths like the rest of the DB.
 *  - The race (season + round) is created if missing, with nothing else.
 *    Refused if it already has results.
 *  - Drivers matched by drivers.name or driver_aliases (case-insensitive).
 *    Unknown names are resolved in a private preview (closest drivers /
 *    create new / skip); names assigned to an existing driver are saved as
 *    aliases on confirm.
 *  - Team from that round's starters (/attend): the starter whose name
 *    matches the driver (CSV name, DB name or alias); team role -> config
 *    team_roles code -> teams.short_name (or team_aliases). Independents
 *    get no team. Anyone not in the starters is asked in the preview.
 *    Leagues without team roles (AL) are all independent.
 */

const PLAN_TTL_MS = 30 * 60 * 1000;
const MAX_SELECTS = 4;          // + 1 row of buttons = Discord's 5 rows
const CANDIDATES = 22;          // + "create" + "skip" <= 25 options

// ---------------------------------------------------------------- CSV

function parseCsv(text) {
    const rows = [];
    for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
        if (!line.trim()) continue;
        const cells = [];
        let cur = '', quoted = false;
        for (let i = 0; i < line.length; i++) {
            const c = line[i];
            if (quoted) {
                if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
                else if (c === '"') quoted = false;
                else cur += c;
            } else if (c === '"') quoted = true;
            else if (c === ',') { cells.push(cur); cur = ''; }
            else cur += c;
        }
        cells.push(cur);
        rows.push(cells);
    }
    const [header, ...data] = rows;
    if (!header) return [];
    return data.map(cells => Object.fromEntries(header.map((h, i) => [h.trim(), (cells[i] ?? '').trim()])));
}

const num = v => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
const bool = v => String(v).toLowerCase() === 'true';
const round10 = ms => (ms == null ? null : Math.round(ms / 10) * 10);

function requireColumns(rows, cols, label) {
    if (!rows.length) throw new Error(`The ${label} CSV has no rows.`);
    const missing = cols.filter(c => !(c in rows[0]));
    if (missing.length) throw new Error(`The ${label} CSV is missing columns: ${missing.join(', ')}. Use the files posted by /results listen.`);
}

async function downloadCsv(attachment, label) {
    if (!attachment) return null;
    if (!/\.csv$/i.test(attachment.name)) throw new Error(`The ${label} file must be a .csv.`);
    const res = await fetch(attachment.url);
    if (!res.ok) throw new Error(`Couldn't download the ${label} file.`);
    return parseCsv(await res.text());
}

// ---------------------------------------------------------------- results

// Rows to save (still with CSV names), from the race + qualifying CSVs.
function buildRows(race, q1, q2) {
    requireColumns(race, ['position', 'driver', 'race_time_ms', 'best_lap_ms', 'dnf'], 'race');
    if (q1) requireColumns(q1, ['position', 'driver', 'quali_time_ms'], 'quali');
    if (q2) requireColumns(q2, ['position', 'driver', 'quali_time_ms'], 'q2');

    // Qualifying order -> grid and quali time.
    const quali = new Map(); // name -> { grid, time }
    if (q1) {
        const byPos = rows => [...rows].sort((a, b) => num(a.position) - num(b.position));
        const order = [
            ...(q2 ? byPos(q2) : []),
            ...byPos(q1).filter(r => !q2?.some(x => x.driver === r.driver))
        ];
        order.forEach((r, i) => quali.set(r.driver, { grid: i + 1, time: round10(num(r.quali_time_ms)) }));
    }

    // Race order: finishers first, then DNFs, each keeping the CSV order.
    const sorted = [...race].sort((a, b) => num(a.position) - num(b.position));
    const ordered = [...sorted.filter(r => !bool(r.dnf)), ...sorted.filter(r => bool(r.dnf))];

    const laps = ordered.map(r => num(r.best_lap_ms)).filter(v => v != null && v > 0);
    const fastest = laps.length ? Math.min(...laps) : null;

    return ordered.map((r, i) => {
        const q = quali.get(r.driver);
        return {
            name: r.driver,
            position: i + 1,
            grid: q ? q.grid : num(r.grid),
            quali_time_ms: q ? q.time : round10(num(r.quali_time_ms)),
            race_time_ms: round10(num(r.race_time_ms)),
            dnf: bool(r.dnf),
            fastest_lap: fastest != null && num(r.best_lap_ms) === fastest
        };
    });
}

// ---------------------------------------------------------------- database lookups

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function similarity(a, b) {
    a = norm(a); b = norm(b);
    if (!a || !b) return 0;
    if (a === b) return 1;
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
    }
    const score = 1 - d[a.length][b.length] / Math.max(a.length, b.length);
    return a.includes(b) || b.includes(a) ? Math.max(score, 0.8) : score;
}

async function findSeason(league, number, division) {
    const code = league.toUpperCase();
    let leagues = await db.select('leagues', 'id,code', { code: `eq.${code}` });
    if (!leagues.length) {
        const alias = await db.select('league_aliases', 'league_id', { code: `eq.${code}` });
        if (alias.length) leagues = [{ id: alias[0].league_id, code }];
    }
    if (!leagues.length) throw new Error(`League ${code} not found in the database.`);

    const seasons = await db.select('seasons', 'id,number,division', {
        league_id: `eq.${leagues[0].id}`,
        number: `eq.${number}`,
        division: division ? `eq.${division}` : 'is.null'
    });
    if (!seasons.length) throw new Error(`Season ${code} S${number}${division || ''} not found in the database.`);
    return seasons[0];
}

async function findRace(seasonId, round) {
    const races = await db.select('races', 'id', { season_id: `eq.${seasonId}`, round: `eq.${round}` });
    if (!races.length) return null;
    const existing = await db.select('results', 'id', { race_id: `eq.${races[0].id}`, limit: '1' });
    if (existing.length) throw new Error(`Round ${round} already has results in the database. Nothing was uploaded.`);
    return races[0];
}

// ---------------------------------------------------------------- plans (pending previews)

const plans = new Map(); // id -> plan
let nextId = 1;

function cleanupPlans() {
    for (const [id, p] of plans) if (Date.now() - p.createdAt > PLAN_TTL_MS) plans.delete(id);
}

/*
 * Builds a pending upload from the command options. Throws with a
 * user-facing message on any problem; nothing is written yet.
 */
async function createPlan({ userId, league, season, round, division, race, quali, q2, needsQ2 }) {
    cleanupPlans();

    if (needsQ2 && (!quali || !q2)) throw new Error(`${league} has Q1 and Q2: attach both \`quali\` (Q1) and \`q2\`.`);
    if (!needsQ2 && q2) throw new Error(`${league} has a single qualifying: attach it as \`quali\`, without \`q2\`.`);
    if (!quali) throw new Error('Attach the qualifying CSV as `quali`.');

    const [raceRows, q1Rows, q2Rows] = await Promise.all([
        downloadCsv(race, 'race'), downloadCsv(quali, 'quali'), downloadCsv(q2, 'q2')
    ]);
    const rows = buildRows(raceRows, q1Rows, q2Rows);

    const seasonRow = await findSeason(league, season, division);
    const raceRow = await findRace(seasonRow.id, round);

    const [drivers, aliases, teams, teamAliases] = await Promise.all([
        db.select('drivers', 'id,name'),
        db.select('driver_aliases', 'alias,driver_id'),
        db.select('teams', 'id,name,short_name'),
        db.select('team_aliases', 'alias,team_id,short_name')
    ]);

    const byName = new Map();
    for (const d of drivers) byName.set(d.name.toLowerCase(), d.id);
    for (const a of aliases) if (!byName.has(a.alias.toLowerCase())) byName.set(a.alias.toLowerCase(), a.driver_id);

    for (const r of rows) {
        r.driverId = byName.get(r.name.toLowerCase()) ?? null;
        r.resolution = r.driverId ? 'known' : null; // known | alias | create | skip
    }

    const id = String(nextId++);
    const plan = {
        id, userId, createdAt: Date.now(),
        league, season, round, division,
        seasonId: seasonRow.id, raceId: raceRow?.id ?? null,
        rows, drivers, aliases, hasQ2: Boolean(q2Rows),
        ...loadStarters({ league, season, round, division, teams, teamAliases })
    };
    assignTeams(plan);
    plans.set(id, plan);
    return plan;
}

const driverName = (plan, id) => plan.drivers.find(d => d.id === id)?.name ?? '?';
const unresolved = plan => plan.rows.filter(r => !r.resolution);
// Drivers to identify first, then teams to pick.
const pendingAll = plan => [...unresolved(plan), ...plan.rows.filter(r => r.resolution && needsTeam(r))];

// ---------------------------------------------------------------- teams (from starters)

const INDEPENDENT = { id: null, label: 'Independent' };

function loadConfig() {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '../../config.json'), 'utf-8'));
}

/*
 * The league's teams (team role -> DB team) and that round's starters.
 * starters.json only keeps the current week: if it's another round, the
 * starters aren't used and every team is asked.
 */
function loadStarters({ league, season, round, division, teams, teamAliases }) {
    const config = loadConfig();
    const code = league.toUpperCase();
    // A code that matches more than one team (e.g. SPR: Sparta / Spark) is
    // treated as missing rather than guessed.
    const dbTeam = short => {
        const n = norm(short);
        const ids = new Set([
            ...teams.filter(x => norm(x.short_name) === n || norm(x.name) === n).map(x => x.id),
            ...teamAliases.filter(x => norm(x.short_name) === n || norm(x.alias) === n).map(x => x.team_id)
        ]);
        return ids.size === 1 ? teams.find(x => x.id === [...ids][0]) || null : null;
    };
    // Team role id -> { id, label } for this league.
    const leagueTeams = {};
    for (const [roleId, t] of Object.entries(config.team_roles || {})) {
        if (t.league !== code) continue;
        const row = dbTeam(t.name);
        leagueTeams[roleId] = { id: row?.id ?? null, label: t.name, missing: !row };
    }

    // That round's starters: this week's, or archived when the next week opened.
    const roundName = `${code}S${season}${division || ''}R${round}`;
    const week = starterStore.getRoundByName(roundName);
    const sameRound = Boolean(week);
    const starters = []; // { name, team }
    if (sameRound) {
        for (const [roleId, list] of Object.entries(week.teams || {})) {
            for (const e of list) starters.push({ name: e.name, team: leagueTeams[roleId] || { id: null, label: '?', missing: true } });
        }
        for (const e of week.independents || []) starters.push({ name: e.name, team: INDEPENDENT });
    }
    return {
        leagueTeams,
        noTeams: Object.keys(leagueTeams).length === 0,
        starters,
        startersNote: sameRound ? '' : `No starters saved for ${roundName}: pick each driver's team.`
    };
}

// Team of each row: manual pick > matching starter > (league without teams) independent.
function assignTeams(plan) {
    for (const r of plan.rows) {
        if (r.teamManual) continue;
        r.team = null;
        if (plan.noTeams) { r.team = INDEPENDENT; continue; }
        const names = new Set([norm(r.name)]);
        if (r.driverId) {
            names.add(norm(driverName(plan, r.driverId)));
            for (const a of plan.aliases) if (a.driver_id === r.driverId) names.add(norm(a.alias));
        }
        const st = plan.starters.find(x => names.has(norm(x.name)));
        if (st) r.team = st.team;
    }
}

const needsTeam = r => r.resolution !== 'skip' && !r.team;

// ---------------------------------------------------------------- preview message

const fmt = ms => {
    if (ms == null) return '—';
    const m = Math.floor(ms / 60000), s = ((ms % 60000) / 1000).toFixed(2);
    return m ? `${m}:${s.padStart(5, '0')}` : s;
};

function previewMessage(plan, notice = '') {
    const title = `${plan.league} S${plan.season}${plan.division || ''} · R${plan.round}`;
    const lines = plan.rows.map(r => {
        let who;
        if (r.resolution === 'known') who = r.name;
        else if (r.resolution === 'alias') who = `${r.name} → ${driverName(plan, r.driverId)}`;
        else if (r.resolution === 'create') who = `${r.name} (new driver)`;
        else if (r.resolution === 'skip') who = `~~${r.name}~~ (skipped)`;
        else who = `❓ ${r.name}`;
        const flags = `${r.dnf ? ' · DNF' : ''}${r.fastest_lap ? ' · ⏱️FL' : ''}`;
        const team = r.resolution === 'skip' ? '' : r.team ? ` [${r.team.label}]` : ' [❓ team]';
        return `\`P${String(r.position).padEnd(2)}\` ${who}${team} · grid ${r.grid ?? '—'} · Q ${fmt(r.quali_time_ms)} · race ${fmt(r.race_time_ms)}${flags}`;
    });

    assignTeams(plan);
    const pending = pendingAll(plan);
    const embed = new EmbedBuilder()
        .setColor(pending.length ? '#e67e22' : '#2ecc71')
        .setTitle(`📤 Upload results — ${title}`)
        .setDescription(lines.join('\n').slice(0, 4000))
        .setFooter({
            text: `${plan.raceId ? 'Race exists (empty)' : 'Race will be created'} · ` +
                `${plan.hasQ2 ? 'grid from Q2 + Q1' : 'grid from qualifying'} · raw results, no penalties`
        });

    const rows = [];
    for (const r of pending.slice(0, MAX_SELECTS)) {
        if (r.resolution) { rows.push(new ActionRowBuilder().addComponents(teamMenu(plan, r))); continue; }
        const candidates = plan.drivers
            .map(d => ({ d, s: similarity(r.name, d.name) }))
            .sort((a, b) => b.s - a.s)
            .slice(0, CANDIDATES);
        const menu = new StringSelectMenuBuilder()
            .setCustomId(`rup_pick_${plan.id}_${r.position}`)
            .setPlaceholder(`"${r.name}" not found: who is it?`.slice(0, 150))
            .addOptions(
                ...candidates.map(({ d }) => ({ label: d.name.slice(0, 100), value: `d${d.id}` })),
                { label: `Create new driver "${r.name}"`.slice(0, 100), value: 'create', emoji: '🆕' },
                { label: 'Skip this row (not saved)', value: 'skip', emoji: '⏭️' }
            );
        rows.push(new ActionRowBuilder().addComponents(menu));
    }

    // The dropdowns only fit the closest names: for anyone else, type it.
    const firstUnknown = unresolved(plan)[0];
    rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`rup_confirm_${plan.id}`).setLabel('Confirm upload').setStyle(ButtonStyle.Success)
            .setDisabled(pending.length > 0),
        ...(firstUnknown ? [new ButtonBuilder().setCustomId(`rup_type_${plan.id}_${firstUnknown.position}`)
            .setLabel(`✏️ Type who "${firstUnknown.name}" is`.slice(0, 80)).setStyle(ButtonStyle.Primary)] : []),
        new ButtonBuilder().setCustomId(`rup_cancel_${plan.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    ));

    const missingTeams = Object.values(plan.leagueTeams).filter(t => t.missing).map(t => t.label);
    const content = notice || [
        plan.startersNote && `ℹ️ ${plan.startersNote}`,
        missingTeams.length && `⚠️ Not in the database's teams: ${missingTeams.join(', ')} (saved without team).`,
        pending.length
            ? `⚠️ ${pending.length} pending: pick who each driver is / their team to enable **Confirm**.`
            : 'Check the results and press **Confirm upload**.'
    ].filter(Boolean).join('\n');
    return { content, embeds: [embed], components: rows };
}

function teamMenu(plan, r) {
    const options = Object.entries(plan.leagueTeams)
        .map(([roleId, t]) => ({ label: t.label.slice(0, 100), value: `t${roleId}` }))
        .slice(0, 24);
    options.push({ label: 'Independent (no team)', value: 'ind', emoji: '🧍' });
    const who = r.resolution === 'known' || r.resolution === 'create' ? r.name : driverName(plan, r.driverId);
    return new StringSelectMenuBuilder()
        .setCustomId(`rup_team_${plan.id}_${r.position}`)
        .setPlaceholder(`${who} isn't in the starters: team?`.slice(0, 150))
        .addOptions(options);
}

// ---------------------------------------------------------------- saving

async function save(plan) {
    // New drivers first, then aliases, then the race (if needed) and its results.
    for (const r of plan.rows.filter(x => x.resolution === 'create')) {
        const [created] = await db.insert('drivers', [{ name: r.name }]);
        r.driverId = created.id;
    }
    const aliases = plan.rows.filter(r => r.resolution === 'alias').map(r => ({ alias: r.name, driver_id: r.driverId }));
    if (aliases.length) await db.insert('driver_aliases', aliases).catch(err => console.warn('⚠️ [Upload] aliases:', err.message));

    let raceId = plan.raceId, createdRace = false;
    if (!raceId) {
        const [race] = await db.insert('races', [{ season_id: plan.seasonId, round: plan.round }]);
        raceId = race.id;
        createdRace = true;
    } else {
        const existing = await db.select('results', 'id', { race_id: `eq.${raceId}`, limit: '1' });
        if (existing.length) throw new Error('This round got results in the meantime. Nothing was uploaded.');
    }

    const results = plan.rows.filter(r => r.resolution !== 'skip').map(r => ({
        race_id: raceId,
        driver_id: r.driverId,
        team_id: r.team?.id ?? null,
        session: 'race',
        position: r.position,
        grid: r.grid,
        quali_time_ms: r.quali_time_ms,
        race_time_ms: r.race_time_ms,
        dnf: r.dnf,
        fastest_lap: r.fastest_lap
    }));

    try {
        await db.insert('results', results);
    } catch (err) {
        if (createdRace) await db.remove('races', { id: `eq.${raceId}` }).catch(() => { });
        throw err;
    }
    return results.length;
}

// ---------------------------------------------------------------- components

const isUploadComponent = id => id.startsWith('rup_');

async function handleUploadComponent(interaction) {
    const [, action, planId, position] = interaction.customId.split('_');
    const plan = plans.get(planId);
    if (!plan) return interaction.update({ content: '⌛ This upload expired. Run `/results upload` again.', embeds: [], components: [] });
    if (interaction.user.id !== plan.userId) return interaction.reply({ content: '❌ This upload is not yours.', ephemeral: true });

    if (action === 'cancel') {
        plans.delete(planId);
        return interaction.update({ content: '❎ Upload cancelled. Nothing was saved.', embeds: [], components: [] });
    }

    if (action === 'type') {
        const row = plan.rows.find(r => String(r.position) === position);
        return interaction.showModal(new ModalBuilder().setCustomId(`rup_typed_${plan.id}_${position}`).setTitle(`Who is "${row.name}"?`.slice(0, 45))
            .addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('name').setLabel('Driver name in the database (or an alias)').setStyle(TextInputStyle.Short).setRequired(true)
            )));
    }

    if (action === 'typed') {
        const row = plan.rows.find(r => String(r.position) === position);
        const typed = interaction.fields.getTextInputValue('name').trim();
        const n = norm(typed);
        const hit = plan.drivers.find(d => norm(d.name) === n)
            || plan.drivers.find(d => d.id === plan.aliases.find(a => norm(a.alias) === n)?.driver_id);
        if (!hit) {
            const close = plan.drivers.map(d => ({ d, s: similarity(typed, d.name) })).sort((a, b) => b.s - a.s).slice(0, 5).map(x => `**${x.d.name}**`);
            return interaction.reply({ content: `❌ No driver called "${typed}". Closest: ${close.join(', ')}.\nType one of them, or pick "Create new driver" in the dropdown.`, ephemeral: true });
        }
        row.resolution = norm(row.name) === norm(hit.name) ? 'known' : 'alias';
        row.driverId = hit.id;
        return interaction.update(previewMessage(plan));
    }

    if (action === 'team') {
        const row = plan.rows.find(r => String(r.position) === position);
        const value = interaction.values[0];
        row.team = value === 'ind' ? INDEPENDENT : plan.leagueTeams[value.slice(1)];
        row.teamManual = true;
        return interaction.update(previewMessage(plan));
    }

    if (action === 'pick') {
        const row = plan.rows.find(r => String(r.position) === position);
        const value = interaction.values[0];
        if (value === 'create') row.resolution = 'create';
        else if (value === 'skip') row.resolution = 'skip';
        else { row.resolution = 'alias'; row.driverId = Number(value.slice(1)); }
        return interaction.update(previewMessage(plan));
    }

    if (action === 'confirm') {
        assignTeams(plan);
        if (pendingAll(plan).length) return interaction.update(previewMessage(plan));
        plans.delete(planId);
        await interaction.update({ content: '⏳ Uploading…', components: [] });
        try {
            const count = await save(plan);
            console.log(`📤 [Upload] ${plan.league} S${plan.season}${plan.division || ''} R${plan.round}: ${count} results by ${interaction.user.tag}`);
            return interaction.editReply({ content: `✅ Uploaded **${count}** results to ${plan.league} S${plan.season}${plan.division || ''} R${plan.round}.` });
        } catch (err) {
            console.error('❌ [Upload]', err.message);
            return interaction.editReply({ content: `❌ Upload failed: ${err.message}` });
        }
    }
}

module.exports = { createPlan, previewMessage, isUploadComponent, handleUploadComponent, buildRows, parseCsv };
