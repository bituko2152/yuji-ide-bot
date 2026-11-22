const { dataFile, readJson, writeJson } = require('../core/jsonStore');
const {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, ModalBuilder,
    LabelBuilder, UserSelectMenuBuilder, TextInputBuilder, TextInputStyle, FileUploadBuilder, MessageFlags, ChannelType
} = require('discord.js');
const { readConfig } = require('../core/config');
const { getWindow, WEEK_MS } = require('../starters/starterCalendar');
const { INFRACTIONS, CHOICES, PPTS_TABLES, choice, penaltyFor, bansReached } = require('./rulebook');

/*
 * Mobile league stewards (Stewards Rulebook V.2.3B), config "mobile_stewards":
 *
 *  /report (any channel)  league -> form: driver, explanation, clip file and/or link.
 *                         Open from the race; closes 48 h after a steward
 *                         runs /start-deadline (when the race footage is out).
 *  /share-pov             the reported driver (told in a DM, not who reported
 *                         them) adds their clip while it's voted.
 *  Vote                   one message per report in its league's post of the
 *                         votes forum; League Stewards vote A-J, hidden (Head
 *                         Stewards can see them). Any steward closes it (picking the
 *                         exact infraction of a grouped choice); the penalty
 *                         comes from the escalation tables (same driver, same
 *                         race) and the penalty points.
 *  Decision               a steward publishes it in the decisions channel, one
 *                         message per incident, with the points and any ban.
 *  Appeal                 24 h button on the decision: TO/TP of the driver's
 *                         team (2 per season) or the driver if Independent (1);
 *                         only a lost appeal uses one up.
 *                         A private thread in the appeals channel with a new
 *                         vote; a steward closes it -> accepted (penalty changed)
 *                         or rejected, published in the decisions channel.
 *
 * State in data/stewards.json.
 */

const storeFile = dataFile('stewards.json');
const DAY_MS = 24 * 60 * 60 * 1000;
const APPEAL_MS = DAY_MS;
const REPORT_WINDOW_MS = 48 * 60 * 60 * 1000; // reports close 48 h after /start-deadline (once the footage is out)
const ID = 'stw:';

// ---------------------------------------------------------------- store

function readAll() {
    return { reports: {}, appeals: {}, next: 1, ...readJson(storeFile) };
}
function writeAll(data) {
    writeJson(storeFile, data);
}
function update(id, fn) {
    const all = readAll();
    if (!all.reports[id]) return null;
    fn(all.reports[id], all);
    writeAll(all);
    return all.reports[id];
}

// ---------------------------------------------------------------- config / roles

const settings = () => readConfig().mobile_stewards || null;
const isMobile = guildId => settings()?.guild === guildId;
const has = (member, role) => Boolean(role && member?.roles.cache.has(role));
const roles = () => settings()?.roles || {};
const isHead = member => has(member, roles().head);
const isSteward = member => has(member, roles().steward) || isHead(member);

// ---------------------------------------------------------------- calendar

// "EMRL Sprint" -> its settings and base league.
function leagueOf(key) {
    const cfg = settings()?.leagues?.[key];
    return cfg ? { key, base: cfg.league || key, ...cfg } : null;
}

// The calendar of a league: the starters' one (race = its closing time), or a
// race check's (OMRL: season / format there, race = its closing time).
function calendarFor(base) {
    const config = readConfig();
    const check = (config.race_checks || []).find(c => c.name === base);
    if (!check) return config;
    return { starters: { ...config.starters,
        first_season: { ...config.starters.first_season, [base]: check.season },
        format: { ...config.starters.format, [base]: check.format || 'AB' },
        closes: { ...config.starters.closes, [base]: check.close } } };
}

/** The latest race of a league already run at `now`: { round, raceAt, deadline, season }. */
function lastRace(league, now = Date.now()) {
    const cal = calendarFor(league.base);
    for (let w = 0; w <= 3; w++) {
        const win = getWindow(league.base, cal, now - w * WEEK_MS);
        if (win.status === 'before') return null;
        if (!win.open || win.closesAt > now) continue;
        const season = Number(win.roundName.match(/S(\d+)/)?.[1]);
        return {
            round: win.roundName.slice(league.base.length).replace(/R(\d+)$/, ' R$1'),
            raceAt: win.closesAt,
            // Set by /start-deadline for this race; until then no deadline.
            deadline: readAll().windows?.[league.key]?.round === win.roundName.slice(league.base.length).replace(/R(\d+)$/, ' R$1')
                ? readAll().windows[league.key].deadline : null,
            // Penalty points seasons follow the shared (UMRL) calendar.
            season: Number(getWindow('UMRL', readConfig(), win.closesAt).roundName?.match(/S(\d+)/)?.[1]) || season
        };
    }
    return null;
}

// ---------------------------------------------------------------- /report

function reportModal(key, late) {
    return new ModalBuilder()
        .setCustomId(`${ID}report:${key}:${late ? 1 : 0}`)
        .setTitle(`${key} incident report`.slice(0, 45))
        .addLabelComponents(
            new LabelBuilder().setLabel('Driver reported')
                .setUserSelectMenuComponent(new UserSelectMenuBuilder().setCustomId('driver').setMaxValues(1)),
            new LabelBuilder().setLabel('What happened').setDescription('Short explanation of the incident')
                .setTextInputComponent(new TextInputBuilder().setCustomId('explanation').setStyle(TextInputStyle.Paragraph).setMaxLength(1000)),
            new LabelBuilder().setLabel('Clip').setDescription('Upload it here, or paste a link below')
                .setFileUploadComponent(new FileUploadBuilder().setCustomId('clip').setRequired(false).setMaxValues(3)),
            new LabelBuilder().setLabel('Clip link').setDescription('YouTube, Medal, Drive…')
                .setTextInputComponent(new TextInputBuilder().setCustomId('link').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(300))
        );
}

const ephemeral = content => ({ content, flags: MessageFlags.Ephemeral });

/** /report on the mobile server: checks, then the form. */
async function openReport(interaction) {
    const s = settings();
    const key = interaction.options.getString('league');
    const late = interaction.options.getBoolean('intentional_targeting') || false;
    const league = leagueOf(key);
    if (!s || !league) return interaction.reply(ephemeral('❌ Reports for this league aren\'t set up.'));
    const driverRole = readConfig().league_driver_roles?.[league.base];
    if (driverRole && !interaction.member.roles.cache.has(driverRole) && !isHead(interaction.member)) {
        return interaction.reply(ephemeral(`❌ Only **${league.base}** drivers can report.`));
    }
    const race = lastRace(league);
    if (!race) return interaction.reply(ephemeral(`❌ There's no **${key}** race to report yet.`));
    if (race.deadline && Date.now() > race.deadline && !late) {
        return interaction.reply(ephemeral(`❌ Reports for **${key} ${race.round}** closed <t:${Math.floor(race.deadline / 1000)}:R>. Only Intentional Targeting can be reported later (option \`intentional_targeting\`).`));
    }
    return interaction.showModal(reportModal(key, late));
}

function reportEmbed(r, stage) {
    const clips = r.clips.map(c => `${c.by === r.culpritId ? '🔁 POV' : '🎥'} ${c.url}`).join('\n') || '—';
    const e = new EmbedBuilder()
        .setColor(stage === 'appeal' ? '#e67e22' : '#3498db')
        .setTitle(`${stage === 'appeal' ? '⚖️ Appeal · ' : ''}Report #${r.id} · ${r.key} ${r.round}${r.late ? ' · Intentional Targeting (late)' : ''}`)
        .addFields(
            { name: 'Reported', value: `<@${r.culpritId}>`, inline: true },
            { name: 'By', value: `<@${r.reporterId}>`, inline: true },
            { name: 'What happened', value: r.explanation.slice(0, 1024) },
            { name: 'Clips', value: clips.slice(0, 1024) }
        );
    if (stage === 'appeal' && r.result) e.addFields({ name: 'Original decision', value: describe(r.result) });
    if (r.notified === false && stage !== 'appeal') e.setFooter({ text: '⚠️ Driver not notified (DMs closed): let them know about /share-pov.' });
    return e;
}

const voteState = (r, stage) => (stage === 'appeal' ? r.appeal : r);

function voteComponents(r, stage) {
    const st = voteState(r, stage);
    const s = stage === 'appeal' ? 'a' : 'o';
    return [
        new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
            .setCustomId(`${ID}vote:${r.id}:${s}`)
            .setPlaceholder('Your vote (hidden)')
            .addOptions(CHOICES.map(c => ({ label: `${c.id} · ${c.label}`, value: c.id })))),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`${ID}close:${r.id}:${s}`).setLabel(`Close vote (${Object.keys(st.votes).length})`).setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`${ID}votes:${r.id}:${s}`).setLabel('See votes').setStyle(ButtonStyle.Secondary)
        )
    ];
}

async function submitReport(interaction) {
    const [, , key, late] = interaction.customId.split(':');
    const league = leagueOf(key);
    const race = league && lastRace(league);
    if (!race) return interaction.reply(ephemeral('❌ That race is no longer open for reports.'));
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const culprit = interaction.fields.getSelectedUsers('driver')?.first();
    const explanation = interaction.fields.getTextInputValue('explanation').trim();
    const files = [...(interaction.fields.getUploadedFiles('clip')?.values() || [])];
    const link = interaction.fields.getTextInputValue('link').trim();
    if (!culprit) return interaction.editReply('❌ Pick the driver you report.');
    if (culprit.id === interaction.user.id) return interaction.editReply('❌ You can\'t report yourself.');
    if (!files.length && !/^https?:\/\//i.test(link)) return interaction.editReply('❌ Add the clip: upload it, or paste a link (https://…).');

    const post = await interaction.client.channels.fetch(league.post).catch(() => null);
    if (!post) return interaction.editReply('❌ The voting post for this league isn\'t found. Tell a Head Steward.');

    const all = readAll();
    const id = all.next++;
    const report = {
        id, key, base: league.base, round: race.round, season: race.season, raceAt: race.raceAt, late: late === '1',
        culpritId: culprit.id, reporterId: interaction.user.id, explanation, createdAt: Date.now(),
        clips: link ? [{ by: interaction.user.id, url: link }] : [],
        votes: {}, status: 'voting'
    };
    // The clip goes up again with the vote message: form uploads expire.
    const payload = { embeds: [reportEmbed(report, 'report')], components: voteComponents(report, 'report'), allowedMentions: { parse: [] } };
    // Too big to upload again (Discord's limit): the form's link is kept instead (valid for a while).
    let sent = await post.send({ ...payload, files: files.map(f => ({ attachment: f.url, name: f.name })) }).catch(() => null);
    if (!sent) {
        report.clips.push(...files.map(f => ({ by: interaction.user.id, url: f.url })));
        sent = await post.send({ ...payload, embeds: [reportEmbed(report, 'report')] }).catch(() => null);
    }
    if (!sent) return interaction.editReply('❌ The report couldn\'t be posted for the stewards. Try again, or tell a Head Steward.');
    report.clips.push(...[...sent.attachments.values()].map(a => ({ by: interaction.user.id, url: a.url })));
    report.vote = { channelId: sent.channelId, messageId: sent.id };
    all.reports[id] = report;
    writeAll(all);
    // The reported driver hears about it in private (not who reported them).
    report.notified = await culprit.send({ embeds: [new EmbedBuilder()
        .setColor('#3498db')
        .setTitle(`🚓 Incident report #${id} · ${key} ${race.round}`)
        .setDescription(`You were reported to the League Stewards.\n\n**What happened:** ${explanation.slice(0, 1500)}\n**Clip:** ${report.clips[0]?.url || '—'}\n\n` +
            'You can add your own clip of the incident with `/share-pov` on the server until the stewards close the vote.')] })
        .then(() => true, () => false);
    update(id, x => { x.notified = report.notified; });
    if (sent.attachments.size || !report.notified) await sent.edit({ embeds: [reportEmbed(report, 'report')] }).catch(() => { });
    console.log(`🚓 [Stewards] Report #${id} ${key} ${race.round}: ${interaction.user.tag} -> ${culprit.tag}.`);
    return interaction.editReply(`✅ Report **#${id}** sent to the stewards. <@${culprit.id}> can add their view with \`/share-pov\`.`);
}

// ---------------------------------------------------------------- /start-deadline

/** Footage is out: reports for a league's latest race close 48 h from now. */
async function openWindow(interaction) {
    if (!isSteward(interaction.member)) return interaction.reply(ephemeral('❌ Only League Stewards can start the countdown.'));
    const key = interaction.options.getString('league');
    const league = leagueOf(key);
    const race = league && lastRace(league);
    if (!race) return interaction.reply(ephemeral(`❌ There's no **${key}** race yet.`));
    const all = readAll();
    // Once started, the countdown of a race can't be restarted.
    const open = all.windows?.[key];
    if (open?.round === race.round && open.season === race.season) {
        return interaction.reply(ephemeral(`❌ The **${key} ${race.round}** countdown is already running: reports close <t:${Math.floor(open.deadline / 1000)}:R>.`));
    }
    const deadline = Date.now() + REPORT_WINDOW_MS;
    all.windows = { ...(all.windows || {}), [key]: { round: race.round, season: race.season, openedAt: Date.now(), deadline, by: interaction.user.id } };
    writeAll(all);
    console.log(`🚓 [Stewards] Reports for ${key} ${race.round} close ${new Date(deadline).toISOString()} (${interaction.user.tag}).`);
    return interaction.reply({
        content: `🎥 The **${key} ${race.round}** footage is out: reports close <t:${Math.floor(deadline / 1000)}:f> (<t:${Math.floor(deadline / 1000)}:R>). Use \`/report\` with the clip.`,
        allowedMentions: { parse: [] }
    });
}

// ---------------------------------------------------------------- /share-pov

/** Open reports against this user, for the autocomplete. */
function openReportsAgainst(userId) {
    return Object.values(readAll().reports)
        .filter(r => r.culpritId === userId && (r.status === 'voting' || r.appeal?.status === 'voting'));
}

async function sharePov(interaction) {
    const id = Number(interaction.options.getString('report'));
    const file = interaction.options.getAttachment('clip');
    const link = interaction.options.getString('link')?.trim();
    const r = readAll().reports[id];
    if (!r || r.culpritId !== interaction.user.id) return interaction.reply(ephemeral('❌ That isn\'t an open report against you.'));
    const stage = r.appeal?.status === 'voting' ? 'appeal' : r.status === 'voting' ? 'report' : null;
    if (!stage) return interaction.reply(ephemeral('❌ The stewards already closed that vote.'));
    if (!file && !/^https?:\/\//i.test(link || '')) return interaction.reply(ephemeral('❌ Add your clip: a file or a link (https://…).'));
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const where = stage === 'appeal' ? r.appeal.vote : r.vote;
    const channel = await interaction.client.channels.fetch(where.channelId).catch(() => null);
    const msg = await channel?.messages.fetch(where.messageId).catch(() => null);
    if (!msg) return interaction.editReply('❌ The vote message wasn\'t found.');
    const base = { content: `🔁 Alternative POV from <@${r.culpritId}> for report #${r.id}${link ? `\n${link}` : ''}`,
        reply: { messageReference: msg.id, failIfNotExists: false }, allowedMentions: { parse: [] } };
    // A file too big to upload again: its link instead.
    const pov = await channel.send({ ...base, files: file ? [{ attachment: file.url, name: file.name }] : [] })
        .catch(() => channel.send({ ...base, content: `${base.content}${file ? `\n${file.url}` : ''}` }));
    const urls = [...(link ? [link] : []), ...(pov.attachments.size ? [...pov.attachments.values()].map(a => a.url) : file ? [file.url] : [])];
    const updated = update(id, x => x.clips.push(...urls.map(url => ({ by: x.culpritId, url }))));
    await msg.edit({ embeds: [reportEmbed(updated, stage)] }).catch(() => { });
    return interaction.editReply(`✅ Your POV was added to report #${id}.`);
}

// ---------------------------------------------------------------- voting

async function handleVote(interaction) {
    const [, , id, s] = interaction.customId.split(':');
    const stage = s === 'a' ? 'appeal' : 'report';
    if (!isSteward(interaction.member)) return interaction.reply(ephemeral('❌ Only League Stewards vote.'));
    const r = readAll().reports[id];
    if (!r || voteState(r, stage)?.status !== 'voting') return interaction.reply(ephemeral('⚠️ This vote is closed.'));
    const c = interaction.values[0];
    const updated = update(id, x => { voteState(x, stage).votes[interaction.user.id] = c; });
    await interaction.update({ components: voteComponents(updated, stage) });
    return interaction.followUp(ephemeral(`🗳️ Your vote: **${c} · ${choice(c).label}** (hidden, you can change it until it's closed).`));
}

function tally(votes) {
    const count = {};
    for (const c of Object.values(votes)) count[c] = (count[c] || 0) + 1;
    return count;
}

async function showVotes(interaction) {
    const [, , id, s] = interaction.customId.split(':');
    if (!isHead(interaction.member)) return interaction.reply(ephemeral('❌ Only Head Stewards can see the votes.'));
    const r = readAll().reports[id];
    const votes = voteState(r, s === 'a' ? 'appeal' : 'report')?.votes || {};
    const lines = CHOICES.map(c => [c, Object.entries(votes).filter(([, v]) => v === c.id).map(([u]) => `<@${u}>`)])
        .filter(([, who]) => who.length).map(([c, who]) => `**${c.id} · ${c.label}** (${who.length}): ${who.join(', ')}`);
    return interaction.reply(ephemeral(lines.join('\n') || 'No votes yet.'));
}

// A steward closes it -> the infraction (asked when the winner groups several, or on a tie).
async function closeVote(interaction) {
    const [, , id, s] = interaction.customId.split(':');
    if (!isSteward(interaction.member)) return interaction.reply(ephemeral('❌ Only League Stewards close votes.'));
    const r = readAll().reports[id];
    const st = r && voteState(r, s === 'a' ? 'appeal' : 'report');
    if (st?.status !== 'voting') return interaction.reply(ephemeral('⚠️ Already closed.'));
    const count = tally(st.votes);
    const max = Math.max(0, ...Object.values(count));
    if (!max) return interaction.reply(ephemeral('⚠️ Nobody has voted yet.'));
    const winners = CHOICES.filter(c => count[c.id] === max);
    const options = winners.flatMap(c => c.infractions.flatMap(inf => (INFRACTIONS[inf].cars
        ? [1, 2, 3, 4, 5].map(n => ({ label: `${INFRACTIONS[inf].name} · ${n} car${n > 1 ? 's' : ''} impeded`, value: `${inf}:${n}` }))
        : [{ label: INFRACTIONS[inf].name, value: inf }])));
    if (options.length === 1) return finish(interaction, r.id, s, options[0].value);
    const tie = winners.length > 1 ? `Tie between ${winners.map(c => c.id).join(', ')} (${max} each). ` : '';
    return interaction.reply({
        ...ephemeral(`${tie}Which infraction exactly?`),
        components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
            .setCustomId(`${ID}pick:${r.id}:${s}`).addOptions(options.slice(0, 25)))]
    });
}

async function pickInfraction(interaction) {
    const [, , id, s] = interaction.customId.split(':');
    if (!isSteward(interaction.member)) return interaction.reply(ephemeral('❌ Only League Stewards close votes.'));
    return finish(interaction, Number(id), s, interaction.values[0]);
}

// Same driver, same race (league key + season + round), decided before.
const sameRace = (a, b) => a.key === b.key && a.round === b.round && a.season === b.season;
const finalResult = r => (r.appeal?.accepted ? r.appeal.result : r.result);

function decide(r, value, by) {
    const [infraction, cars] = value.split(':');
    const earlier = Object.values(readAll().reports)
        .filter(x => x.id !== r.id && x.culpritId === r.culpritId && sameRace(x, r) && finalResult(x)?.infraction === infraction);
    const n = earlier.length + 1;
    return { infraction, cars: Number(cars) || null, n, ...penaltyFor(infraction, n, Number(cars) || 1), by, at: Date.now() };
}

function describe(res) {
    const inf = INFRACTIONS[res.infraction];
    if (res.infraction === 'NONE') return 'No penalty';
    const what = res.dsq ? 'DSQ' : res.warning ? 'Warning' : `+${res.seconds} s`;
    const extra = [res.cars ? `${res.cars} car${res.cars > 1 ? 's' : ''} impeded` : null,
        res.n > 1 && !inf.cars ? `${res.n}${['', 'st', 'nd', 'rd'][res.n] || 'th'} in this race` : null].filter(Boolean).join(', ');
    return `${inf.name}${extra ? ` (${extra})` : ''} → **${what}**${res.ppts ? ` · ${res.ppts} penalty point${res.ppts > 1 ? 's' : ''}` : ''}${inf.note ? `\n${inf.note}` : ''}`;
}

async function finish(interaction, id, s, value) {
    const stage = s === 'a' ? 'appeal' : 'report';
    const r = readAll().reports[id];
    const result = decide(r, value, interaction.user.id);
    const updated = update(id, x => { const st = voteState(x, stage); st.status = 'closed'; st.result = result; });
    const where = stage === 'appeal' ? updated.appeal.vote : updated.vote;
    const channel = await interaction.client.channels.fetch(where.channelId).catch(() => null);
    const msg = await channel?.messages.fetch(where.messageId).catch(() => null);
    const count = tally(voteState(updated, stage).votes);
    const summary = CHOICES.filter(c => count[c.id]).map(c => `${c.id}: ${count[c.id]}`).join(' · ');
    const embed = reportEmbed(updated, stage).addFields({ name: `Result (closed by ${interaction.user.username})`, value: `${describe(result)}\nVotes: ${summary}` });

    // From the button: a new answer; from the infraction menu: that menu is replaced.
    const answer = content => (interaction.isStringSelectMenu() ? interaction.update({ content, components: [] }) : interaction.reply(ephemeral(content)));
    if (stage === 'appeal') {
        await msg?.edit({ embeds: [embed], components: [] }).catch(() => { });
        await answer('✅ Appeal vote closed, publishing the outcome.');
        return publishAppeal(interaction.client, id, channel);
    }
    await msg?.edit({ embeds: [embed], components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${ID}publish:${id}`).setLabel('Publish decision').setStyle(ButtonStyle.Success))] }).catch(() => { });
    return answer(`✅ Vote closed: ${describe(result)}. Any steward can publish it now.`);
}

// ---------------------------------------------------------------- decisions

// Points of a driver this season in a table, from the decisions published.
function seasonPoints(culpritId, season, table, exceptId = null) {
    return Object.values(readAll().reports)
        .filter(x => x.id !== exceptId && x.culpritId === culpritId && x.season === season && PPTS_TABLES[x.base] === table && x.publishedAt)
        .reduce((sum, x) => sum + (finalResult(x)?.ppts || 0), 0);
}

function decisionEmbed(r, res, title) {
    const table = PPTS_TABLES[r.base];
    const total = seasonPoints(r.culpritId, r.season, table);
    return new EmbedBuilder()
        .setColor(res.dsq ? '#8b0000' : res.infraction === 'NONE' ? '#2ecc71' : res.warning ? '#f1c40f' : '#e67e22')
        .setTitle(title)
        .setDescription(`**Driver:** <@${r.culpritId}>\n**Race:** ${r.key} ${r.round}\n**Decision:** ${describe(res)}\n` +
            `**Penalty points:** ${total} this season (${table} table)\n**Clip:** ${r.clips[0]?.url || '—'}`);
}

async function postDecision(client, r, res, title, beforePoints, components = []) {
    const s = settings();
    const channel = await client.channels.fetch(s.decisions_channel).catch(() => null);
    if (!channel) throw new Error('decisions channel not found');
    const bans = bansReached(beforePoints, seasonPoints(r.culpritId, r.season, PPTS_TABLES[r.base]));
    const head = roles().head;
    return channel.send({
        content: bans.length ? `🚫 <@${r.culpritId}> reached a **${bans.join(' and a ')}** on the ${PPTS_TABLES[r.base]} table.${head ? ` <@&${head}>` : ''}` : undefined,
        embeds: [decisionEmbed(r, res, title)],
        components,
        allowedMentions: { users: [r.culpritId], roles: bans.length && head ? [head] : [] }
    });
}

async function publish(interaction) {
    const [, , id] = interaction.customId.split(':');
    if (!isSteward(interaction.member)) return interaction.reply(ephemeral('❌ Only League Stewards publish decisions.'));
    const r = readAll().reports[id];
    if (!r?.result || r.publishedAt) return interaction.reply(ephemeral('⚠️ Already published.'));
    // Decisions go out only once reports for that race are closed.
    const win = readAll().windows?.[r.key];
    const sameRace = win?.round === r.round && win.season === r.season;
    if (sameRace ? Date.now() < win.deadline : !win || win.openedAt < r.createdAt) {
        return interaction.reply(ephemeral(sameRace
            ? `⏳ Reports for **${r.key} ${r.round}** close <t:${Math.floor(win.deadline / 1000)}:R>: publish after that.`
            : `⏳ The **${r.key} ${r.round}** countdown hasn't started (\`/start-deadline\`): publish once reports are closed.`));
    }
    await interaction.deferUpdate();
    const before = seasonPoints(r.culpritId, r.season, PPTS_TABLES[r.base]);
    update(id, x => { x.publishedAt = Date.now(); x.publishedBy = interaction.user.id; x.status = 'published'; });
    const appeal = new ActionRowBuilder().addComponents(new ButtonBuilder()
        .setCustomId(`${ID}appeal:${id}`).setLabel('Appeal (24 h)').setStyle(ButtonStyle.Secondary));
    const sent = await postDecision(interaction.client, readAll().reports[id], r.result, `🚓 Stewards decision · Report #${id}`, before,
        r.result.infraction === 'NONE' ? [] : [appeal]);
    update(id, x => { x.decision = { channelId: sent.channelId, messageId: sent.id }; });
    await interaction.message.edit({ components: [] }).catch(() => { });
    console.log(`🚓 [Stewards] Report #${id} published by ${interaction.user.tag}: ${r.result.infraction}.`);
}

// ---------------------------------------------------------------- appeals

// Who can appeal: TO/TP of the driver's team in that league, or the driver if Independent.
async function appealRights(guild, member, r) {
    const config = readConfig();
    const culprit = await guild.members.fetch(r.culpritId).catch(() => null);
    const team = Object.entries(config.team_roles).find(([roleId, t]) => t.league === r.base && culprit?.roles.cache.has(roleId));
    if (!team) return { allowed: member.id === r.culpritId, key: `ind:${r.culpritId}`, limit: 1, who: 'the driver (Independent)' };
    const { runsTeam } = require('../lineups/lineupService');
    return { allowed: runsTeam(member, team[0], r.base, config.league_manager_roles?.[r.base]), key: `team:${team[0]}`, limit: 2, who: `the ${team[1].name} Team Owner / Principal`, teamRole: team[0] };
}

async function appeal(interaction) {
    const [, , id] = interaction.customId.split(':');
    const r = readAll().reports[id];
    if (!r?.publishedAt) return interaction.reply(ephemeral('⚠️ This decision can\'t be appealed.'));
    if (r.appeal) return interaction.reply(ephemeral('⚠️ This decision was already appealed.'));
    if (Date.now() - r.publishedAt > APPEAL_MS) return interaction.reply(ephemeral('❌ Appeals close 24 h after the decision.'));
    const rights = await appealRights(interaction.guild, interaction.member, r);
    if (!rights.allowed) return interaction.reply(ephemeral(`❌ Only ${rights.who} can appeal this decision.`));
    // Only lost appeals use one up; one still being voted is held until it ends.
    const lost = readAll().appeals[r.season]?.[rights.key] || 0;
    const pending = Object.values(readAll().reports).filter(x => x.appeal?.key === rights.key && x.appeal.status === 'voting' && x.season === r.season).length;
    const left = rights.limit - lost - pending;
    if (left <= 0) return interaction.reply(ephemeral(`❌ No appeals left this season (${lost} lost${pending ? `, ${pending} being voted` : ''}, ${rights.limit} allowed).`));
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const channel = await interaction.client.channels.fetch(settings().appeals_channel).catch(() => null);
    if (!channel) return interaction.editReply('❌ The appeals channel isn\'t found.');
    const thread = await channel.threads.create({
        name: `Appeal · Report #${id} · ${r.key} ${r.round}`.slice(0, 100),
        type: ChannelType.PrivateThread, invitable: false, autoArchiveDuration: 4320
    });
    const all = readAll();
    all.reports[id].appeal = { by: interaction.user.id, key: rights.key, at: Date.now(), threadId: thread.id, votes: {}, status: 'voting' };
    writeAll(all);

    // Who's in: the appellant, both drivers and the stewards.
    const members = await interaction.guild.members.fetch().catch(() => null);
    const stewards = members ? [...members.filter(m => isSteward(m)).keys()] : [];
    for (const uid of new Set([interaction.user.id, r.culpritId, r.reporterId, ...stewards])) await thread.members.add(uid).catch(() => { });

    const updated = readAll().reports[id];
    await thread.send({ content: `⚖️ <@${interaction.user.id}> appealed the decision on report #${id} (${left} appeal${left === 1 ? '' : 's'} left this season; only a lost one uses it up). Explain here why it should change; stewards vote below and one of them closes it.`, allowedMentions: { users: [interaction.user.id] } });
    const vote = await thread.send({ embeds: [reportEmbed(updated, 'appeal')], components: voteComponents(updated, 'appeal'), allowedMentions: { parse: [] } });
    update(id, x => { x.appeal.vote = { channelId: thread.id, messageId: vote.id }; });
    await interaction.message.edit({ components: [] }).catch(() => { });
    console.log(`⚖️ [Stewards] Report #${id} appealed by ${interaction.user.tag}.`);
    return interaction.editReply(`✅ Appeal opened: ${thread}`);
}

async function publishAppeal(client, id, thread) {
    const r = readAll().reports[id];
    const before = seasonPoints(r.culpritId, r.season, PPTS_TABLES[r.base], id) + (r.result.ppts || 0);
    const changed = r.appeal.result.infraction !== r.result.infraction || r.appeal.result.cars !== r.result.cars;
    // A won appeal doesn't use one up; a lost one does.
    update(id, (x, all) => {
        x.appeal.accepted = changed;
        if (!changed) all.appeals[x.season] = { ...(all.appeals[x.season] || {}), [x.appeal.key]: (all.appeals[x.season]?.[x.appeal.key] || 0) + 1 };
    });
    const now = readAll().reports[id];
    await postDecision(client, now, finalResult(now),
        changed ? `✅ Appeal accepted · Report #${id}` : `❌ Appeal rejected · Report #${id}`, before);
    await thread?.send(changed ? '✅ Appeal accepted: the corrected decision is published.' : '❌ Appeal rejected: the decision stays.').catch(() => { });
    await thread?.setLocked(true).catch(() => { });
    await thread?.setArchived(true).catch(() => { });
    console.log(`⚖️ [Stewards] Appeal on report #${id} ${changed ? 'accepted' : 'rejected'}.`);
}

// ---------------------------------------------------------------- routing

const isStewardComponent = customId => customId.startsWith(ID);

async function handleComponent(interaction) {
    const action = interaction.customId.split(':')[1];
    const handlers = { report: submitReport, vote: handleVote, votes: showVotes, close: closeVote, pick: pickInfraction, publish, appeal };
    const handler = handlers[action];
    if (handler) return handler(interaction);
}

module.exports = {
    isMobile, openReport, openWindow, sharePov, openReportsAgainst, isStewardComponent, handleComponent,
    lastRace, leagueOf
};
