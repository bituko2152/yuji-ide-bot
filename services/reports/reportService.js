const fs = require('fs');
const path = require('path');
const {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder,
    StringSelectMenuBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');
const pollStore = require('./pollStore');

/*
 * /report message (S26 penalty system): one embed with the report and the
 * vote tally, a "Level" and a "Type" dropdown to vote (one vote each:
 * level + time/position), "View voters" and "Submit result".
 *
 * Submit result (stewards): private message with the same two dropdowns,
 * prefilled with the most voted level/type, the standard amount (editable),
 * Confirm / Cancel. Confirm posts to config "canal_resultados_reports_id":
 *
 *   Report: <@culprit> | JL | S22A R1
 *   Result: <offense> | <kind of penalty>
 *   Penalty: <amount>
 *   Proof: <link>
 */

// `time` / `position`: standard amounts. Levels without them take no type.
const LEVELS = [
    { id: 'L0', label: 'No penalty', hint: 'Level 0 · No penalty', kind: 'No penalty', penalty: '-' },
    { id: 'L1', label: 'Level 1', hint: 'Warning, then +1s or 1 position', time: '1.00s', position: '1 position', warning: true },
    { id: 'L2', label: 'Level 2', hint: '+3s or 2 positions', time: '3.00s', position: '2 positions' },
    { id: 'L3', label: 'Level 3', hint: '+5s or 3 positions', time: '5.00s', position: '3 positions' },
    { id: 'INT', label: 'Intentional', hint: 'At least +10s or 5 positions', time: '10.00s', position: '5 positions' },
    { id: 'MAL', label: 'Malicious', hint: 'DSQ, sent to the URA', kind: 'DSQ', penalty: 'DSQ + sent to the URA' },
    { id: 'LAG', label: 'Lag', hint: '2+ teleports reported → DNF', kind: 'DNF', penalty: 'DNF' }
];
const TYPES = [
    { id: 'time', label: 'Time', kind: 'Time penalty' },
    { id: 'position', label: 'Position', kind: 'Position penalty' },
    { id: 'warning', label: 'Warning', kind: 'Warning', hint: 'Level 1 only (first Level 1)' }
];
// Side line colour of the posted result, by severity.
const RESULT_COLORS = {
    L0: '#2ecc71', L1: '#f1c40f', L2: '#e67e22', L3: '#d35400', INT: '#e74c3c', MAL: '#8b0000', LAG: '#95a5a6'
};
const level = id => LEVELS.find(l => l.id === id);
const type = id => TYPES.find(t => t.id === id);
const needsType = l => Boolean(l?.time);
const validType = (l, t) => needsType(l) && (t === 'time' || t === 'position' || (t === 'warning' && l.warning));

function loadConfig() {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '../../config.json'), 'utf-8'));
}

function isSteward(member, config) {
    return !!config.rol_stewards_id && member.roles.cache.has(config.rol_stewards_id);
}

// "JLS22AR1" / "CL23R1" -> "JL S22A R1"
function roundLabel(round) {
    const m = String(round || '').match(/^(UL|CL|JL|AL)S?(\d+[AB]?)R(\d+)$/i);
    return m ? `${m[1].toUpperCase()} S${m[2].toUpperCase()} R${m[3]}` : (round || 'N/A');
}

// Final decision -> { offense, kind, penalty }
function decision(levelId, typeId, amount) {
    const l = level(levelId);
    if (!needsType(l)) return { offense: l.label, kind: l.kind, penalty: l.penalty };
    const t = type(typeId);
    const penalty = t.id === 'warning' ? '-' : amount || l[t.id];
    return { offense: l.label, kind: t.kind, penalty };
}

// ---------------------------------------------------------------- report message

function tally(poll) {
    const byLevel = {};
    for (const v of Object.values(poll.voters || {})) {
        const entry = byLevel[v.level] ||= { count: 0, types: {} };
        entry.count++;
        if (v.type && validType(level(v.level), v.type)) entry.types[v.type] = (entry.types[v.type] || 0) + 1;
    }
    const parts = LEVELS.filter(l => byLevel[l.id]).map(l => {
        const { count, types } = byLevel[l.id];
        const t = Object.entries(types).map(([id, n]) => `${type(id).label} ${n}`).join(' · ');
        return `${l.label} ×${count}${t ? ` (${t})` : ''}`;
    });
    return parts.length ? parts.join('\n') : 'No votes yet';
}

function reportEmbed(poll) {
    const r = poll.report;
    const embed = new EmbedBuilder()
        .setColor(poll.submitted ? '#2ecc71' : '#2b2d31')
        .setTitle(`🚨 Incident Report #${poll.reportId}`)
        .addFields(
            { name: 'Culprit', value: r.culpritId ? `<@${r.culpritId}>` : '?', inline: true },
            { name: 'Round', value: roundLabel(r.round), inline: true },
            { name: 'Reported by', value: r.reporterId ? `<@${r.reporterId}>` : (r.reporterName || '?'), inline: true },
            { name: 'Description', value: `> ${r.description || '-'}`.slice(0, 1024) },
            { name: 'Proof', value: r.proof ? `[Click here](${r.proof})` : '-', inline: true },
            poll.submitted
                ? { name: 'Result', value: `✅ ${poll.submitted.offense} | ${poll.submitted.kind} | ${poll.submitted.penalty}\nby <@${poll.submitted.by}>`, inline: true }
                : { name: 'Votes', value: tally(poll), inline: true }
        )
        .setTimestamp(poll.createdAt || Date.now());
    if (r.avatarUrl) embed.setThumbnail(r.avatarUrl);
    return embed;
}

function levelMenu(customId, selected) {
    return new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder('Level')
        .addOptions(LEVELS.map(l => ({ label: l.label, value: l.id, description: l.hint, default: l.id === selected })));
}

function typeMenu(customId, selected, levelId) {
    const l = level(levelId);
    const types = TYPES.filter(t => t.id !== 'warning' || !l || l.warning);
    return new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder('Type: Time or Position')
        .setDisabled(Boolean(l) && !needsType(l))
        .addOptions(types.map(t => ({ label: t.label, value: t.id, description: t.hint, default: t.id === selected })));
}

function reportComponents(poll) {
    const voters = new ButtonBuilder().setCustomId('report_voters').setLabel('👁️ View voters').setStyle(ButtonStyle.Secondary);
    if (poll.submitted) return [new ActionRowBuilder().addComponents(voters)];

    const level = levelMenu('report_vote_level', null);
    level.addOptions({ label: 'Remove my vote', value: 'remove', emoji: '🗑️' });
    return [
        new ActionRowBuilder().addComponents(level),
        new ActionRowBuilder().addComponents(typeMenu('report_vote_type', null, null)),
        new ActionRowBuilder().addComponents(
            voters,
            new ButtonBuilder().setCustomId('report_submit').setLabel('📤 Submit result').setStyle(ButtonStyle.Success)
        )
    ];
}

const render = poll => ({ embeds: [reportEmbed(poll)], components: reportComponents(poll) });

// ---------------------------------------------------------------- creation

function createPoll(messageId, data) {
    return pollStore.createPoll(messageId, {
        reportId: data.reportId,
        threadId: data.threadId,
        overrides: { report: data.report, voters: {}, votes: undefined, baseVotes: undefined, levelVotes: undefined, createdAt: Date.now() }
    });
}

// ---------------------------------------------------------------- voting

async function handleVoteSelect(interaction) {
    const messageId = interaction.message.id;
    const poll = pollStore.getPoll(messageId);
    if (!poll?.voters) return interaction.reply({ content: '⚠️ This report is closed or too old.', ephemeral: true });
    if (poll.submitted) return interaction.reply({ content: '⚠️ The result was already submitted.', ephemeral: true });

    const value = interaction.values[0];
    const userId = interaction.user.id;
    let note;

    const updated = pollStore.updatePoll(messageId, p => {
        const vote = p.voters[userId] || {};
        if (interaction.customId === 'report_vote_level') {
            if (value === 'remove') { delete p.voters[userId]; note = '🗑️ Your vote was removed.'; return; }
            vote.level = value;
        } else {
            vote.type = value;
        }
        p.voters[userId] = vote;

        const l = level(vote.level);
        if (!l) note = `✅ Type: ${type(vote.type).label} — now pick the level.`;
        else if (!needsType(l)) note = `✅ Your vote: **${l.label}**.`;
        else if (!validType(l, vote.type)) note = `✅ ${l.label} — now pick ${l.warning ? 'Warning, Time or Position' : 'Time or Position'}.`;
        else note = `✅ Your vote: **${l.label} · ${type(vote.type).label}**.`;
    });

    // The dropdowns reset (they can't show each steward's own choice);
    // the tally in the embed is what changes.
    await interaction.update(render(updated));
    return interaction.followUp({ content: note, ephemeral: true });
}

async function handleVotersButton(interaction) {
    const poll = pollStore.getPoll(interaction.message.id);
    if (!poll?.voters) return interaction.reply({ content: '⚠️ This report is closed or too old.', ephemeral: true });

    const lines = Object.entries(poll.voters).map(([uid, v]) => {
        const l = level(v.level);
        const t = l && validType(l, v.type) ? ` · ${type(v.type).label}` : (needsType(l) ? ' · (no type)' : '');
        return `<@${uid}> → **${l ? l.label : '(no level)'}${t}**`;
    });
    const embed = new EmbedBuilder().setColor('#5865F2').setTitle('👁️ Voters for this report')
        .setDescription(lines.length ? lines.join('\n') : 'No votes yet.');

    // Visible to everyone in the thread, without pinging the voters.
    const thread = poll.threadId ? await interaction.guild.channels.fetch(poll.threadId).catch(() => null) : null;
    if (thread) {
        await thread.send({ embeds: [embed], allowedMentions: { parse: [] } });
        return interaction.reply({ content: '✅ Voter list posted in the thread.', ephemeral: true });
    }
    return interaction.reply({ embeds: [embed], ephemeral: true });
}

// ---------------------------------------------------------------- submit result

function mostVoted(poll) {
    const count = (list, key) => list.reduce((acc, v) => { if (v[key]) acc[v[key]] = (acc[v[key]] || 0) + 1; return acc; }, {});
    const votes = Object.values(poll.voters || {});
    const top = obj => Object.entries(obj).sort((a, b) => b[1] - a[1])[0]?.[0];
    const levelId = top(count(votes, 'level')) || 'L0';
    const l = level(levelId);
    const typeId = needsType(l) ? (top(count(votes.filter(v => v.level === levelId && validType(l, v.type)), 'type')) || 'time') : null;
    return { level: levelId, type: typeId, amount: null };
}

function submitView(messageId, poll, draft) {
    const d = decision(draft.level, draft.type, draft.amount);
    const r = poll.report;
    const channelId = loadConfig().canal_resultados_reports_id;
    const content =
        `**Submit result · Report #${poll.reportId}** → posted in <#${channelId}>\n` +
        `>>> Report: <@${r.culpritId}> | ${roundLabel(r.round).replace(' ', ' | ')}\n` +
        `Result: ${d.offense} | ${d.kind}\nPenalty: ${d.penalty}\nProof: ${r.proof}`;

    const l = level(draft.level);
    const editable = needsType(l) && draft.type !== 'warning';
    return {
        content,
        components: [
            new ActionRowBuilder().addComponents(levelMenu(`report_sub_level_${messageId}`, draft.level)),
            new ActionRowBuilder().addComponents(typeMenu(`report_sub_type_${messageId}`, draft.type, draft.level)),
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`report_amount_${messageId}`).setLabel('✏️ Edit amount').setStyle(ButtonStyle.Secondary).setDisabled(!editable),
                new ButtonBuilder().setCustomId(`report_confirm_${messageId}`).setLabel('Confirm').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`report_cancel_${messageId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
            )
        ],
        allowedMentions: { parse: [] }
    };
}

async function handleSubmitButton(interaction) {
    if (!isSteward(interaction.member, loadConfig())) {
        return interaction.reply({ content: '❌ Only stewards can submit the result.', ephemeral: true });
    }
    const messageId = interaction.message.id;
    const poll = pollStore.getPoll(messageId);
    if (!poll?.voters) return interaction.reply({ content: '⚠️ This report is closed or too old.', ephemeral: true });
    if (poll.submitted) return interaction.reply({ content: '⚠️ The result was already submitted.', ephemeral: true });

    const draft = mostVoted(poll);
    pollStore.updatePoll(messageId, p => { p.draft = draft; });
    return interaction.reply({ ...submitView(messageId, poll, draft), ephemeral: true });
}

// Level / type changed in the private submit view.
async function handleSubmitSelect(interaction) {
    const [, , field, messageId] = interaction.customId.split('_'); // report_sub_<level|type>_<id>
    const updated = pollStore.updatePoll(messageId, p => {
        if (!p.draft) return;
        p.draft[field] = interaction.values[0];
        p.draft.amount = null; // new level/type -> its standard amount
        const l = level(p.draft.level);
        if (!needsType(l)) p.draft.type = null;
        else if (!validType(l, p.draft.type)) p.draft.type = 'time';
    });
    if (!updated?.draft || updated.submitted) return interaction.update({ content: '⚠️ Already submitted or expired.', components: [] });
    return interaction.update(submitView(messageId, updated, updated.draft));
}

async function handleAmountButton(interaction) {
    const messageId = interaction.customId.slice('report_amount_'.length);
    const poll = pollStore.getPoll(messageId);
    if (!poll?.draft) return interaction.update({ content: '⚠️ Expired.', components: [] });
    const current = decision(poll.draft.level, poll.draft.type, poll.draft.amount).penalty;
    return interaction.showModal(new ModalBuilder().setCustomId(`report_amountmodal_${messageId}`).setTitle('Edit amount')
        .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('amount').setLabel('Penalty').setStyle(TextInputStyle.Short)
                .setValue(current).setPlaceholder('15.00s, 7 positions…').setRequired(true).setMaxLength(50))));
}

async function handleAmountModal(interaction) {
    const messageId = interaction.customId.slice('report_amountmodal_'.length);
    const updated = pollStore.updatePoll(messageId, p => {
        if (p.draft) p.draft.amount = interaction.fields.getTextInputValue('amount').trim();
    });
    if (!updated?.draft || updated.submitted) return interaction.update({ content: '⚠️ Already submitted or expired.', components: [] });
    return interaction.update(submitView(messageId, updated, updated.draft));
}

async function handleConfirmButton(interaction) {
    const [, action, messageId] = interaction.customId.split('_'); // report_confirm_<id> / report_cancel_<id>
    if (action === 'cancel') return interaction.update({ content: '❎ Cancelled, nothing was posted.', components: [] });

    const config = loadConfig();
    if (!isSteward(interaction.member, config)) return interaction.update({ content: '❌ Only stewards can submit the result.', components: [] });

    const poll = pollStore.getPoll(messageId);
    if (!poll?.draft || poll.submitted) return interaction.update({ content: '⚠️ Already submitted or expired.', components: [] });

    const reportsChannel = await interaction.client.channels.fetch(config.canal_reportes_id).catch(() => null);
    const message = await reportsChannel?.messages.fetch(messageId).catch(() => null);
    const target = config.canal_resultados_reports_id
        ? await interaction.client.channels.fetch(config.canal_resultados_reports_id).catch(() => null) : null;
    if (!message || !target) {
        return interaction.update({ content: '❌ Report message or results channel (config "canal_resultados_reports_id") not found.', components: [] });
    }

    const r = poll.report;
    const d = decision(poll.draft.level, poll.draft.type, poll.draft.amount);
    // Embed (box with a coloured side line, by severity) so each result
    // stands apart in the channel. Mentions inside embeds don't notify.
    await target.send({
        embeds: [new EmbedBuilder()
            .setColor(RESULT_COLORS[poll.draft.level] || '#2b2d31')
            .setDescription(
                `**Report:** <@${r.culpritId}> | ${roundLabel(r.round).replace(' ', ' | ')}\n` +
                `**Result:** ${d.offense} | ${d.kind}\n**Penalty:** ${d.penalty}\n**Proof:** ${r.proof}`)]
    });

    const updated = pollStore.updatePoll(messageId, p => {
        p.submitted = { by: interaction.user.id, at: Date.now(), ...d };
        delete p.draft;
    });
    await message.edit({ ...render(updated), allowedMentions: { parse: [] } });
    return interaction.update({ content: '✅ Result submitted.', components: [] });
}

// ---------------------------------------------------------------- migration

// Report data from an old-format message (fields "ID:", "Culprit:", ...).
function parseOldReport(message) {
    const f = Object.fromEntries((message.embeds[0]?.fields || []).map(x => [x.name.replace(/:$/, ''), x.value]));
    return {
        culpritId: f.Culprit?.match(/<@!?(\d+)>/)?.[1] || null,
        round: (f.Round || '').replace(/`/g, '').trim(),
        description: (f.Description || '').replace(/^>\s?/, ''),
        proof: f.Proof?.match(/\((https?:\/\/[^)]+)\)/)?.[1] || '',
        reporterName: (f.Notes || '').match(/Submitted by (.+)$/)?.[1] || null,
        reporterId: null,
        avatarUrl: message.embeds[0]?.thumbnail?.url || null
    };
}

/*
 * Reports of the current rounds still on an older poll get the S26 message
 * (votes reset). Editing a message doesn't ping again.
 */
async function migrateOldPolls(client) {
    const config = loadConfig();
    const currentRounds = new Set(Object.values(config.config_categorias || {}).map(c => c.round));
    const channel = await client.channels.fetch(config.canal_reportes_id).catch(() => null);
    if (!channel) return;

    for (const [messageId, poll] of Object.entries(pollStore.readAll())) {
        if (poll.report) continue; // already S26
        const message = await channel.messages.fetch(messageId).catch(() => null);
        if (!message) continue;
        const report = parseOldReport(message);
        if (!currentRounds.has(report.round)) continue;

        const updated = pollStore.updatePoll(messageId, p => {
            p.report = report;
            p.voters = {};
            delete p.votes;
            delete p.baseVotes;
            delete p.levelVotes;
            delete p.draft;
            delete p.submitted;
            p.createdAt ??= message.createdTimestamp;
        });
        await message.edit({ ...render(updated), allowedMentions: { parse: [] } });
        console.log(`🔁 [Reports] Report ${poll.reportId} moved to the S26 penalty system.`);
    }
}

// ---------------------------------------------------------------- routing

async function handleReportComponent(interaction) {
    const id = interaction.customId;
    if (id.startsWith('vote_')) return interaction.reply({ content: '⚠️ This poll is closed or too old.', ephemeral: true });
    if (id === 'report_vote_level' || id === 'report_vote_type') return handleVoteSelect(interaction);
    if (id === 'report_voters') return handleVotersButton(interaction);
    if (id === 'report_submit') return handleSubmitButton(interaction);
    if (id.startsWith('report_sub_')) return handleSubmitSelect(interaction);
    if (id.startsWith('report_amountmodal_')) return handleAmountModal(interaction);
    if (id.startsWith('report_amount_')) return handleAmountButton(interaction);
    if (id.startsWith('report_confirm_') || id.startsWith('report_cancel_')) return handleConfirmButton(interaction);
    return null;
}

const isReportComponent = id => id.startsWith('report_') || id.startsWith('vote_');

module.exports = { render, createPoll, migrateOldPolls, handleReportComponent, isReportComponent };
