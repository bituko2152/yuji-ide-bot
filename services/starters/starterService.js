const fs = require('fs');
const path = require('path');
const { AttachmentBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const starterStore = require('./starterStore');
const { getWindow, weekStartAt, WEEK_MS } = require('./starterCalendar');
const { renderBoard } = require('./starterBoard');

const TICK_MS = 60 * 1000;     // 1 min is plenty to catch the start of the week
const TEAM_SLOTS = 2;
const BOARD_DEBOUNCE_MS = 1500;

function loadConfig() {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '../../config.json'), 'utf-8'));
}

// ---------------------------------------------------------------- helpers

function categoryFromChannel(channelId, config) {
    const channels = config.starters?.channels || {};
    return Object.entries(channels).find(([, id]) => id === channelId)?.[0] || null;
}

function teamsOf(cat, config) {
    return Object.entries(config.team_roles || {})
        .filter(([, t]) => t.league === cat)
        .map(([roleId, t]) => ({ roleId, ...t }));
}

function independentSlots(cat, config) {
    return config.starters?.independent_slots?.[cat] ?? 6;
}

function isOpen(round) {
    return !!round && round.open && Date.now() < round.closesAt;
}

// TO of a team = league manager role + that team's role, at the same time.
function isTO(member, teamRoleId, cat, config) {
    const managerRoleId = config.league_manager_roles?.[cat];
    if (!managerRoleId || managerRoleId === '???') return false;
    return member.roles.cache.has(managerRoleId) && member.roles.cache.has(teamRoleId);
}

// Managers (manager_role / manager_users) can remove anyone: any team or Independent.
function canManage(member, config) {
    const s = config.starters || {};
    if ((s.manager_users || []).includes(member.id)) return true;
    const roleId = s.manager_role;
    return !!roleId && roleId !== '???' && member.roles.cache.has(roleId);
}

function targetLabel(target, config) {
    return target === 'independent' ? 'Independent' : (config.team_roles[target]?.name ?? '???');
}

const MEMBERS_FETCH_COOLDOWN_MS = 10 * 60 * 1000;
const lastMembersFetch = new Map();

async function getTeamOwners(guild, teamRoleId, cat, config) {
    const managerRoleId = config.league_manager_roles?.[cat];
    if (!managerRoleId || managerRoleId === '???') return [];

    const find = () => {
        const role = guild.roles.cache.get(teamRoleId);
        return role ? [...role.members.filter(m => m.roles.cache.has(managerRoleId)).values()] : [];
    };

    let owners = find();
    // Member cache may be cold: fetch once and retry. Fetching every member is
    // expensive, so at most once per MEMBERS_FETCH_COOLDOWN_MS per server.
    const last = lastMembersFetch.get(guild.id) || 0;
    if (!owners.length && Date.now() - last >= MEMBERS_FETCH_COOLDOWN_MS) {
        lastMembersFetch.set(guild.id, Date.now());
        await guild.members.fetch().catch(() => null);
        owners = find();
    }
    return owners;
}

// ---------------------------------------------------------------- state ops (sync)

function findEntry(round, userId) {
    for (const [teamRoleId, list] of Object.entries(round.teams)) {
        if (list.some(e => e.userId === userId)) return { kind: 'team', teamRoleId };
    }
    if (round.independents.some(e => e.userId === userId)) return { kind: 'independent' };
    return null;
}

function detach(round, userId) {
    for (const list of Object.values(round.teams)) {
        const i = list.findIndex(e => e.userId === userId);
        if (i !== -1) list.splice(i, 1);
    }
    const j = round.independents.findIndex(e => e.userId === userId);
    if (j !== -1) round.independents.splice(j, 1);
}

/**
 * Puts a user in `target` ('independent' or a team role id), removing them
 * from wherever they were before (this is the "override").
 * Returns 'ok' | 'already' | 'full'. Nothing changes unless it returns 'ok'.
 */
function placeUser(cat, config, userId, name, target) {
    let result = 'ok';
    starterStore.updateRound(cat, round => {
        const list = target === 'independent'
            ? round.independents
            : (round.teams[target] ||= []);
        const cap = target === 'independent' ? independentSlots(cat, config) : TEAM_SLOTS;

        if (list.some(e => e.userId === userId)) { result = 'already'; return; }
        if (list.length >= cap) { result = 'full'; return; }

        detach(round, userId);
        list.push({ userId, name });
    });
    return result;
}

function removeUser(cat, userId) {
    starterStore.updateRound(cat, round => detach(round, userId));
}

// ---------------------------------------------------------------- board message

function leagueRoleMention(cat, config) {
    const id = config.league_driver_roles?.[cat];
    return id && id !== '???' ? `<@&${id}>` : '';
}

function buildContent(round, closed, mention = '') {
    if (closed) return `🔒 **Starters ${round.roundName}** — closed.`;
    const ts = Math.floor(round.closesAt / 1000);
    return `${mention ? mention + '\n' : ''}📋 **Starters ${round.roundName}**\nCloses <t:${ts}:F> (<t:${ts}:R>). Use \`/attend\` in this channel to check in, \`/removeattendance\` to remove yourself.`;
}

function buildBoardFile(cat, round, config) {
    const png = renderBoard({
        roundName: round.roundName,
        teams: teamsOf(cat, config),
        independentSlots: independentSlots(cat, config),
        round
    });
    return new AttachmentBuilder(png, { name: `starters-${round.roundName}.png` });
}

// While the round is open the board is kept as the last message of the
// channel, like the lobby list: edited in place while it's the last one,
// re-posted at the bottom (old copy deleted) once someone writes below it
// (TO request messages below it don't count, see isBuried).
// Only the very first message of the week (openRound) pings the league
// role; re-posts are silent and don't even show the mention.
async function updateBoard(client, cat, { closed = false } = {}) {
    const round = starterStore.getRound(cat);
    if (!round?.messageId) return;

    const channel = await client.channels.fetch(round.channelId).catch(() => null);
    const message = await channel?.messages.fetch(round.messageId).catch(() => null);

    const config = loadConfig();
    const isPingMessage = round.messageId === round.pingMessageId;
    const mention = closed || !isPingMessage ? '' : leagueRoleMention(cat, config);
    const payload = {
        content: buildContent(round, closed, mention),
        files: [buildBoardFile(cat, round, config)],
        allowedMentions: { parse: [] } // safety net: updates never notify
    };

    const buried = !message || await isBuried(channel, round);
    if (closed || !buried) {
        if (message) await message.edit({ ...payload, attachments: [] });
        return;
    }

    if (!channel) return;
    const sent = await channel.send({ ...payload, content: buildContent(round, false), flags: MessageFlags.SuppressNotifications });
    starterStore.updateRound(cat, r => { r.messageId = sent.id; });
    await message?.delete().catch(() => { });
}

// True when something other than pending TO request messages was posted
// below the board (those requests alone don't make it move).
async function isBuried(channel, round) {
    if (channel.lastMessageId === round.messageId) return false;
    const requestIds = new Set(Object.values(round.requests || {}).map(r => r.messageId));
    const below = await channel.messages.fetch({ after: round.messageId, limit: 50 }).catch(() => null);
    if (!below) return false;
    return below.some(m => !requestIds.has(m.id));
}

// Called every tick: moves an open board back to the bottom if something was
// posted below it (chat, etc. — not TO requests).
async function keepBoardLast(client, cat) {
    const round = starterStore.getRound(cat);
    if (!isOpen(round) || !round.messageId) return;

    const channel = await client.channels.fetch(round.channelId).catch(() => null);
    if (channel && await isBuried(channel, round)) requestBoardUpdate(client, cat);
}

// Many people sign up at once around race time: coalesce edits into one.
const pendingUpdates = new Map();
function requestBoardUpdate(client, cat) {
    if (pendingUpdates.has(cat)) return;
    pendingUpdates.set(cat, setTimeout(() => {
        pendingUpdates.delete(cat);
        updateBoard(client, cat).catch(err => console.error(`❌ [Starters] Error updating ${cat} board:`, err.message));
    }, BOARD_DEBOUNCE_MS));
}

// ---------------------------------------------------------------- requests (TO approval)

async function cancelPendingRequests(client, cat, userId) {
    const round = starterStore.getRound(cat);
    if (!round) return;

    const mine = Object.entries(round.requests || {}).filter(([, r]) => r.userId === userId);
    if (!mine.length) return;

    starterStore.updateRound(cat, r => { for (const [id] of mine) delete r.requests[id]; });

    const channel = await client.channels.fetch(round.channelId).catch(() => null);
    for (const [, req] of mine) {
        await channel?.messages.delete(req.messageId).catch(() => { });
    }
}

async function handleStarterButton(interaction) {
    // starter_accept_<cat>_<reqId> / starter_decline_<cat>_<reqId>
    const [, action, cat, reqId] = interaction.customId.split('_');
    const config = loadConfig();
    const round = starterStore.getRound(cat);
    const req = round?.requests?.[reqId];

    if (!req || !isOpen(round)) {
        return interaction.reply({ content: '⚠️ This request is no longer available.', ephemeral: true });
    }

    const teamName = targetLabel(req.teamRoleId, config);
    if (!isTO(interaction.member, req.teamRoleId, cat, config)) {
        return interaction.reply({ content: `❌ Only a team owner of **${teamName}** can answer this request.`, ephemeral: true });
    }

    if (action === 'decline') {
        starterStore.updateRound(cat, r => { delete r.requests[reqId]; });
        const embed = EmbedBuilder.from(interaction.message.embeds[0])
            .setColor('#e74c3c')
            .addFields({ name: 'Status', value: `❌ Declined by ${interaction.user}` });
        return interaction.update({ content: '', embeds: [embed], components: [] });
    }

    if (action === 'accept') {
        const res = placeUser(cat, config, req.userId, req.name, req.teamRoleId);

        if (res === 'full') {
            starterStore.updateRound(cat, r => { delete r.requests[reqId]; });
            const embed = EmbedBuilder.from(interaction.message.embeds[0])
                .setColor('#e74c3c')
                .addFields({ name: 'Status', value: `❌ **${teamName}** is already full.` });
            return interaction.update({ content: '', embeds: [embed], components: [] });
        }

        starterStore.updateRound(cat, r => { delete r.requests[reqId]; });
        await interaction.reply({ content: `✅ <@${req.userId}> added to **${teamName}**.`, ephemeral: true });
        // Once accepted, the request message is removed.
        await interaction.message.delete().catch(() => { });
        requestBoardUpdate(interaction.client, cat);
    }
}

// ---------------------------------------------------------------- open / close rounds

async function openRound(client, cat, win, config) {
    const channelId = config.starters.channels[cat];
    const channel = await client.channels.fetch(channelId);

    const round = {
        roundName: win.roundName,
        weekStart: win.weekStart,
        closesAt: win.closesAt,
        open: true,
        channelId,
        messageId: null,
        teams: {},
        independents: [],
        requests: {}
    };

    // Send first, persist after: if sending fails, the next tick retries.
    const roleId = config.league_driver_roles?.[cat];
    const hasRole = roleId && roleId !== '???';
    const message = await channel.send({
        content: buildContent(round, false, leagueRoleMention(cat, config)),
        files: [buildBoardFile(cat, round, config)],
        allowedMentions: hasRole ? { roles: [roleId] } : { parse: [] }
    });
    round.messageId = message.id;
    round.pingMessageId = message.id; // the only message that shows/sends the role ping
    starterStore.setRound(cat, round);

    console.log(`📋 [Starters] Opened ${round.roundName} in ${cat}.`);
}

async function closeRound(client, cat) {
    const round = starterStore.getRound(cat);
    if (!round || !round.open) return;

    // Pending approval messages no longer make sense.
    const channel = await client.channels.fetch(round.channelId).catch(() => null);
    for (const req of Object.values(round.requests || {})) {
        await channel?.messages.delete(req.messageId).catch(() => { });
    }

    await updateBoard(client, cat, { closed: true }).catch(err =>
        console.error(`❌ [Starters] Error closing ${cat} board:`, err.message));

    starterStore.updateRound(cat, r => { r.open = false; r.requests = {}; });
    console.log(`🔒 [Starters] Closed ${round.roundName} in ${cat}.`);
}

// ---------------------------------------------------------------- reports

const CONFIG_PATH = path.join(__dirname, '../../config.json');

/**
 * Every Monday 00:00 UTC that follows a race week, the race that was just
 * run becomes the current round for /report (report_leagues.round),
 * reports are switched on, and ONE generic announcement is posted for all
 * leagues. Idempotent: it only fires once per week (tracked in _meta).
 */
// report_leagues.<cat> = { active: true, round } written into the config.json
// text in place; the whole file is only rewritten if that entry can't be found.
function setRoundInText(text, cat, roundName) {
    const start = text.indexOf('"report_leagues"');
    const end = start < 0 ? -1 : text.indexOf('\n  }', start);
    const entry = new RegExp(`("${cat}"\\s*:\\s*\\{)([^}]*)(\\})`);
    if (start >= 0 && end > start && entry.test(text.slice(start, end))) {
        const block = text.slice(start, end).replace(entry, (m, open, body, close) => {
            body = body.replace(/("round"\s*:\s*")[^"]*(")/, `$1${roundName}$2`).replace(/("active"\s*:\s*)(true|false)/, '$1true');
            return open + body + close;
        });
        const out = text.slice(0, start) + block + text.slice(end);
        const parsed = JSON.parse(out).report_leagues?.[cat];
        if (parsed?.round === roundName && parsed.active === true) return out;
    }
    const fresh = JSON.parse(text);
    fresh.report_leagues[cat] = { ...(fresh.report_leagues[cat] || {}), active: true, round: roundName };
    return JSON.stringify(fresh, null, 2);
}

async function syncReports(client, config) {
    const now = Date.now();
    const weekStart = weekStartAt(now);
    const meta = starterStore.getMeta();
    if (meta.reportsWeekStart === weekStart) return;

    // Round of the race window that ended at this week's Monday 00:00.
    const justRaced = {};
    // Only the leagues with /report (report_leagues); the mobile ones have none.
    for (const cat of Object.keys(config.starters.format).filter(c => config.report_leagues?.[c])) {
        const prev = getWindow(cat, config, now - WEEK_MS);
        if (prev.open) justRaced[cat] = prev.roundName;
    }

    if (Object.keys(justRaced).length) {
        // Re-read from disk right before writing so we don't clobber a /setround.
        // Only the round values change in the text, so the file keeps its hand-made layout.
        let text = fs.readFileSync(CONFIG_PATH, 'utf-8');
        for (const [cat, roundName] of Object.entries(justRaced)) text = setRoundInText(text, cat, roundName);
        fs.writeFileSync(CONFIG_PATH, text);

        const channelId = config.report_announcements_channel;
        if (!channelId || channelId === '???') {
            console.warn('⚠️ [Reports] report_announcements_channel not configured: rounds updated, no announcement sent.');
        } else {
            const channel = await client.channels.fetch(channelId).catch(() => null);
            if (channel) {
                const lines = Object.entries(justRaced).map(([cat, round]) => `**${cat}** — \`${round}\``);
                const embed = new EmbedBuilder()
                    .setColor('#e67e22')
                    .setTitle('📢 Reports are now open')
                    .setDescription(`Incident reports are open for the races that were just run:\n\n${lines.join('\n')}\n\nUse \`/report\` to submit your incident.`)
                    .setTimestamp();
                // Ping every category's league role, not just the ones that raced.
                const roleIds = Object.values(config.league_driver_roles || {}).filter(id => id && id !== '???');
                await channel.send({
                    content: roleIds.map(id => `<@&${id}>`).join(' ') || undefined,
                    embeds: [embed],
                    allowedMentions: { roles: roleIds }
                });
            } else {
                console.warn('⚠️ [Reports] Could not fetch the announcements channel.');
            }
        }
        console.log(`📢 [Reports] Reports opened: ${Object.values(justRaced).join(', ')}`);
    }

    starterStore.setMeta({ ...meta, reportsWeekStart: weekStart });
}

// ---------------------------------------------------------------- scheduler

const warned = new Set();
let running = false;

async function tick(client) {
    if (running) return;
    running = true;
    try {
        const config = loadConfig();
        if (!config.starters) return;

        for (const cat of Object.keys(config.starters.channels)) {
            const channelId = config.starters.channels[cat];
            if (!channelId || channelId === '???') {
                if (!warned.has(cat)) {
                    console.warn(`⚠️ [Starters] No starters channel configured for ${cat}, skipping it.`);
                    warned.add(cat);
                }
                continue;
            }

            try {
                const win = getWindow(cat, config);
                if (win.status === 'before') continue;

                const current = starterStore.getRound(cat);

                // Closing time changed in config.json for this week's round -> apply it.
                if (current?.open && current.weekStart === win.weekStart && current.closesAt !== win.closesAt) {
                    starterStore.updateRound(cat, r => { r.closesAt = win.closesAt; });
                    requestBoardUpdate(client, cat);
                }

                // Closing time reached, or a different week than the stored one -> close it.
                if (current?.open && (current.weekStart !== win.weekStart || Date.now() >= win.closesAt)) {
                    await closeRound(client, cat);
                }

                // Race week without a round yet, once its opening time comes -> open it. (Break week: nothing.)
                if (win.open && Date.now() >= win.opensAt && Date.now() < win.closesAt) {
                    const stored = starterStore.getRound(cat);
                    if (!stored || stored.weekStart !== win.weekStart) {
                        await openRound(client, cat, win, config);
                    }
                }

                await keepBoardLast(client, cat);
            } catch (err) {
                console.error(`❌ [Starters] Error processing ${cat}:`, err.message);
            }
        }

        await syncReports(client, config).catch(err => console.error('❌ [Reports] Error syncing reports:', err.message));
    } finally {
        running = false;
    }
}

function startStarterLoop(client) {
    const run = () => tick(client).catch(err => console.error('❌ [Starters] Tick failed:', err.message));
    run();
    setInterval(run, TICK_MS);
}

module.exports = {
    startStarterLoop,
    handleStarterButton,
    loadConfig,
    categoryFromChannel,
    teamsOf,
    isOpen,
    isTO,
    canManage,
    targetLabel,
    getTeamOwners,
    findEntry,
    placeUser,
    removeUser,
    cancelPendingRequests,
    requestBoardUpdate,
    TEAM_SLOTS
};
