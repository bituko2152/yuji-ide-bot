const fs = require('fs');
const path = require('path');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { getWindow } = require('../starters/starterCalendar');

/*
 * Weekly anonymous race check (e.g. OMRL on the mobile server).
 *
 * Every week, at the set day/time, the bot posts a message with only the
 * NUMBER of drivers attending and Join / Leave buttons (only for the league
 * role). The names are only shown to UROs: the "Participants" button answers
 * them with a message only they can see. Past the limit, drivers go to the
 * reserve list (first come, first served). At the close time Join / Leave
 * are disabled (Participants keeps working).
 *
 * config.json:
 *   "race_checks": [{
 *     "name": "OMRL",
 *     "channel": "<channel id>",
 *     "driver_role": "<role allowed to join, pinged when it opens (optional)>",
 *     "uro_roles": ["<roles that can see the participants>"],
 *     "lobby_limit": 18,   (only text: lobby is first come, first served)
 *     "limit": 18,         (optional: cap the check, the rest go to reserve)
 *     "open":  { "day": "wednesday", "time": "18:00" },   (UTC as in summer: one hour later in winter)
 *     "close": { "day": "saturday",  "time": "17:45" },   (UTC, first one after publishing)
 *     "season": 9, "format": "AB",   (optional: follows the PC leagues' calendar, starters
 *                                     "first_race_date": round in the title, nothing on break weeks)
 *     "skip_weeks": ["2026-10-14"]   (optional: publishing dates to skip, e.g. posted by hand)
 *   }]
 *
 * data/racechecks.json: { "<name>": { weekKey, messageId, closesAt, open,
 *   drivers: [ { userId, name, at } ] } }   (in join order)
 */

const { europe } = require('../core/europeTime');

const storeFile = path.join(__dirname, '../../data/racechecks.json');
const configPath = path.join(__dirname, '../../config.json');
const CHECK_EVERY_MS = 60 * 1000;
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const loadConfig = () => JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const checksConfig = () => (loadConfig().race_checks || []).filter(c => c.name && c.channel);

function readAll() {
    try { return JSON.parse(fs.readFileSync(storeFile, 'utf-8')); } catch { return {}; }
}
function writeAll(data) {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    fs.writeFileSync(storeFile, JSON.stringify(data, null, 2));
}
function update(name, fn) {
    const all = readAll();
    if (!all[name]) return null;
    fn(all[name]);
    writeAll(all);
    return all[name];
}

// This week's moment for { day, time }, the week starting on Monday.
function weekMoment(now, { day, time }) {
    const [h, m] = String(time).split(':').map(Number);
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m || 0));
    const fromMonday = (now.getUTCDay() + 6) % 7;
    const target = (DAYS.indexOf(String(day).toLowerCase()) + 6) % 7;
    d.setUTCDate(d.getUTCDate() - fromMonday + target);
    return new Date(europe(d.getTime()));
}

// First { day, time } strictly after a moment.
function nextMoment(after, when) {
    let d = weekMoment(after, when);
    while (d <= after) d = new Date(d.getTime() + 7 * 24 * 60 * 60 * 1000);
    return d;
}

// This week's round from the PC leagues' calendar ("S9A R3"); null on a break
// week; undefined when the check doesn't follow the calendar.
function roundOf(cfg, config, at) {
    if (!cfg.season || !config.starters?.first_race_date) return undefined;
    const cal = { starters: { ...config.starters, first_season: { [cfg.name]: cfg.season }, format: { [cfg.name]: cfg.format || 'AB' } } };
    const w = getWindow(cfg.name, cal, at);
    if (!w.open) return w.status === 'before' ? undefined : null;
    return w.roundName.slice(cfg.name.length).replace(/R(\d+)$/, ' R$1');
}

const ts = (ms, f = 'F') => `<t:${Math.floor(ms / 1000)}:${f}>`;

function publicView(cfg, rc) {
    const n = rc.drivers.length, limit = cfg.limit || 0;
    const shown = limit ? `${Math.min(n, limit)} / ${limit}` : String(n);
    const embed = new EmbedBuilder()
        .setColor(rc.open ? '#3498db' : '#2b2d31')
        .setTitle(`🏁 ${cfg.name} Race Check${rc.round ? ` · ${rc.round}` : ''}`)
        .setDescription(
            `Racing in ${cfg.name} this week? Press **Join**. **This is mandatory in order to race.**\n` +
            (limit ? `If the limit of ${limit} drivers is reached, it's first come, first served (the rest go to the reserve list).\n`
                : cfg.lobby_limit ? `The lobby holds ${cfg.lobby_limit} drivers: if more sign up, the spots go to whoever joins the lobby first.\n` : '') +
            'Your in-game name must match your Discord name, to identify you in the race.\n\n' +
            `**${shown}** drivers attending` + (limit && n > limit ? ` · **${n - limit}** in reserve` : '') + '\n\n' +
            (rc.open ? `Closes ${ts(rc.closesAt)} (${ts(rc.closesAt, 'R')})` : '🔒 Closed'));
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`racecheck_join_${cfg.name}`).setLabel('Join').setStyle(ButtonStyle.Success).setDisabled(!rc.open),
        new ButtonBuilder().setCustomId(`racecheck_leave_${cfg.name}`).setLabel('Leave').setStyle(ButtonStyle.Secondary).setDisabled(!rc.open),
        new ButtonBuilder().setCustomId(`racecheck_list_${cfg.name}`).setLabel(`Participants (${n})`).setStyle(ButtonStyle.Secondary)
    );
    return { embeds: [embed], components: [row] };
}

// Names, for UROs only (a message only they can see).
function participantsView(cfg, rc) {
    const limit = cfg.limit || Infinity;
    const line = (d, i) => `${i + 1}. <@${d.userId}> (${d.name}) · ${ts(d.at, 'R')}`;
    const main = rc.drivers.slice(0, limit).map(line).join('\n') || '_Nobody yet._';
    const reserve = rc.drivers.slice(limit).map(line).join('\n');
    return {
        embeds: [new EmbedBuilder()
            .setColor('#3498db')
            .setTitle(`🔒 ${cfg.name}${rc.round ? ` ${rc.round}` : ''} Race Check · participants (${rc.drivers.length})`)
            .setDescription((main + (reserve ? `\n\n**Reserve**\n${reserve}` : '')).slice(0, 4000))
            .setFooter({ text: rc.open ? 'Open' : 'Closed' })],
        allowedMentions: { parse: [] },
        ephemeral: true
    };
}

async function fetchMessage(client, channelId, messageId) {
    const ch = await client.channels.fetch(channelId).catch(() => null);
    return ch && messageId ? ch.messages.fetch(messageId).catch(() => null) : null;
}

async function open(client, cfg, weekKey, closesAt, round) {
    const channel = await client.channels.fetch(cfg.channel).catch(() => null);
    if (!channel) return console.error(`❌ [RaceCheck] ${cfg.name}: channel not found.`);

    const rc = { weekKey, closesAt, open: true, drivers: [], ...(round ? { round } : {}) };
    const message = await channel.send({
        ...(cfg.driver_role ? { content: `<@&${cfg.driver_role}>` } : {}),
        ...publicView(cfg, rc),
        allowedMentions: { roles: cfg.driver_role ? [cfg.driver_role] : [] }
    });
    const all = readAll();
    all[cfg.name] = { ...rc, messageId: message.id };
    writeAll(all);
    console.log(`🏁 [RaceCheck] ${cfg.name} opened (${weekKey}).`);
}

async function tick(client) {
    const now = new Date();
    const config = loadConfig();
    for (const cfg of checksConfig()) {
        try {
            const publishAt = weekMoment(now, cfg.open);
            const weekKey = publishAt.toISOString().slice(0, 10);
            const rc = readAll()[cfg.name];

            if (rc?.open && now.getTime() >= rc.closesAt) {
                const closed = update(cfg.name, r => { r.open = false; });
                const message = await fetchMessage(client, cfg.channel, closed.messageId);
                await message?.edit({ ...publicView(cfg, closed), allowedMentions: { parse: [] } });
                console.log(`🔒 [RaceCheck] ${cfg.name} closed with ${closed.drivers.length} driver(s).`);
                continue;
            }
            const closesAt = nextMoment(publishAt, cfg.close).getTime();
            if (now >= publishAt && now.getTime() < closesAt && rc?.weekKey !== weekKey) {
                // Skipped week (posted by hand) or break week in the calendar: nothing this week.
                const round = roundOf(cfg, config, closesAt);
                if ((cfg.skip_weeks || []).includes(weekKey) || round === null) continue;
                await open(client, cfg, weekKey, closesAt, round);
            }
        } catch (err) {
            console.error(`❌ [RaceCheck] ${cfg.name}:`, err.message);
        }
    }
}

function startRaceCheckLoop(client) {
    tick(client);
    setInterval(() => tick(client), CHECK_EVERY_MS);
}

async function handleRaceCheckButton(interaction) {
    const [, action, ...rest] = interaction.customId.split('_'); // racecheck_<join|leave|list>_<name>
    const name = rest.join('_');
    const cfg = checksConfig().find(c => c.name === name);
    const rc = readAll()[name];
    if (!cfg || !rc || rc.messageId !== interaction.message.id) {
        return interaction.reply({ content: '⚠️ This race check is no longer active.', ephemeral: true });
    }
    const roles = interaction.member?.roles?.cache;

    if (action === 'list') {
        const isUro = (cfg.uro_roles || []).some(id => roles?.has(id))
            || interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
        if (!isUro) return interaction.reply({ content: '❌ Only UROs can see the participants.', ephemeral: true });
        return interaction.reply(participantsView(cfg, rc));
    }

    if (!rc.open || Date.now() >= rc.closesAt) return interaction.reply({ content: '🔒 This race check is closed.', ephemeral: true });
    const userId = interaction.user.id;
    const isIn = rc.drivers.some(d => d.userId === userId);
    if (action === 'join') {
        if (cfg.driver_role && !roles?.has(cfg.driver_role)) {
            return interaction.reply({ content: `❌ Only <@&${cfg.driver_role}> drivers can join.`, ephemeral: true, allowedMentions: { parse: [] } });
        }
        if (isIn) return interaction.reply({ content: "✅ You're already in.", ephemeral: true });
    }
    if (action === 'leave' && !isIn) return interaction.reply({ content: "ℹ️ You weren't in the list.", ephemeral: true });

    const updated = update(name, r => {
        if (action === 'join') r.drivers.push({ userId, name: interaction.member?.displayName || interaction.user.username, at: Date.now() });
        else r.drivers = r.drivers.filter(d => d.userId !== userId);
    });
    await interaction.update({ ...publicView(cfg, updated), allowedMentions: { parse: [] } });

    const pos = updated.drivers.findIndex(d => d.userId === userId) + 1;
    const reserve = action === 'join' && cfg.limit && pos > cfg.limit;
    await interaction.followUp({
        content: action === 'leave' ? `👋 You left the ${name} race check.`
            : reserve ? `🟡 The ${cfg.limit} spots are taken: you're **reserve #${pos - cfg.limit}**. If someone leaves, you move up.`
            : `✅ You're in for ${name}. You can leave until it closes.`,
        ephemeral: true
    });
}

module.exports = { startRaceCheckLoop, handleRaceCheckButton, weekMoment, nextMoment };
