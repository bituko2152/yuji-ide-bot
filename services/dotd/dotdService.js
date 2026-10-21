const fs = require('fs');
const path = require('path');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { parseCsv } = require('../results/resultsUpload');

/*
 * Driver of the Day: /dotd posts a poll from a race CSV (the one /results
 * listen posts), one button per driver ("P2 · Glow ▲4"). One vote per person:
 * press another driver to move it, the same one to take it back. Counts stay
 * hidden until it closes (48 h), then the buttons are disabled and the winner
 * and top 3 are posted as a reply. Who can start one: config "dotd"
 * ({ "<server id>" | "main": { "roles": [...] } }, "main" = GUILD_ID).
 * data/dotd.json: { "<messageId>": { channelId, title, closesAt, drivers, votes: { userId: index }, closed } }
 */

const storeFile = path.join(__dirname, '../../data/dotd.json');
const configPath = path.join(__dirname, '../../config.json');
const DURATION_MS = 48 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 60 * 1000;
const MAX_DRIVERS = 24; // 5 rows of 5 buttons, the last one is "My vote"
const PER_ROW = 5;
const COLOR = '#f1c40f';
const VOTE = 'dotd_vote_';
const MINE = 'dotd_mine';

function readAll() {
    try { return JSON.parse(fs.readFileSync(storeFile, 'utf-8')); } catch { return {}; }
}
function writeAll(data) {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    fs.writeFileSync(storeFile, JSON.stringify(data, null, 2));
}
function update(messageId, fn) {
    const all = readAll();
    if (!all[messageId]) return null;
    fn(all[messageId]);
    writeAll(all);
    return all[messageId];
}

function canStart(interaction) {
    const servers = JSON.parse(fs.readFileSync(configPath, 'utf-8')).dotd || {};
    const roles = servers[interaction.guildId === process.env.GUILD_ID ? 'main' : interaction.guildId]?.roles || [];
    return Boolean(interaction.member?.roles.cache.some(r => roles.includes(r.id)));
}

// ---------------------------------------------------------------- drivers

// Race CSV rows -> drivers in finishing order, with what the buttons show.
function driversFromCsv(rows) {
    const missing = ['position', 'driver', 'grid', 'dnf'].filter(c => !(c in (rows[0] || {})));
    if (!rows.length || missing.length) throw new Error('Use the race CSV posted by /results listen.');
    return rows
        .sort((a, b) => Number(a.position) - Number(b.position))
        .map(r => {
            const dnf = String(r.dnf).toLowerCase() === 'true';
            const grid = Number(r.grid) || null;
            const finish = Number(r.position);
            return {
                name: r.driver,
                grid,
                finish,
                dnf,
                pole: grid === 1,
                fastest: String(r.fastest_lap).toLowerCase() === 'true'
            };
        });
}

function change(d) {
    if (d.dnf || !d.grid) return '';
    const n = d.grid - d.finish;
    return n > 0 ? ` ▲${n}` : n < 0 ? ` ▼${-n}` : ' =';
}

// "P2 · Glow ▲4 🟣⏱️" / "DNF · Georus"
function label(d) {
    const marks = (d.pole ? ' 🟣' : '') + (d.fastest ? ' ⏱️' : '');
    return `${d.dnf ? 'DNF' : `P${d.finish}`} · ${d.name}${change(d)}${marks}`.slice(0, 80);
}

// "P6 → P2 ▲4"
function result(d) {
    return `P${d.grid ?? '?'} → ${d.dnf ? 'DNF' : `P${d.finish}`}${change(d)}`;
}

// ---------------------------------------------------------------- views

const ts = (ms, f) => `<t:${Math.floor(ms / 1000)}:${f}>`;

function pollView(poll) {
    const votes = Object.keys(poll.votes).length;
    const embed = new EmbedBuilder()
        .setColor(poll.closed ? '#2b2d31' : COLOR)
        .setTitle(`🏆 Driver of the Day · ${poll.title}`)
        .setDescription(
            (poll.closed
                ? 'Voting is closed. The result is in the reply below.'
                : 'Who was your driver of the day? Press their name to vote.\n' +
                  'One vote each: press another driver to change it, or the same one to take it back. ' +
                  'Votes stay hidden until the poll closes.') +
            '\n\n-# ▲▼ positions gained or lost from the grid · 🟣 pole · ⏱️ fastest lap')
        .addFields(
            { name: 'Votes', value: `**${votes}**`, inline: true },
            { name: poll.closed ? 'Closed' : 'Closes', value: poll.closed ? ts(poll.closesAt, 'f') : `${ts(poll.closesAt, 'f')} (${ts(poll.closesAt, 'R')})`, inline: true }
        );

    const buttons = poll.drivers.map((d, i) => new ButtonBuilder()
        .setCustomId(VOTE + i)
        .setLabel(label(d))
        .setStyle(d.dnf ? ButtonStyle.Secondary : ButtonStyle.Primary)
        .setDisabled(poll.closed));
    buttons.push(new ButtonBuilder().setCustomId(MINE).setLabel('My vote').setStyle(ButtonStyle.Secondary).setDisabled(poll.closed));
    const rows = [];
    for (let i = 0; i < buttons.length; i += PER_ROW) rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + PER_ROW)));
    return { embeds: [embed], components: rows };
}

function winnerView(poll) {
    const counts = poll.drivers.map((d, i) => ({ d, n: 0, i }));
    for (const i of Object.values(poll.votes)) if (counts[i]) counts[i].n++;
    const total = Object.keys(poll.votes).length;
    const embed = new EmbedBuilder().setColor(COLOR).setTitle(`🏆 Driver of the Day · ${poll.title}`);
    if (!total) return { embeds: [embed.setColor('#2b2d31').setDescription('Nobody voted, so there is no driver of the day this time.')] };

    const ranked = counts.filter(c => c.n).sort((a, b) => b.n - a.n || a.i - b.i);
    const pct = n => `${Math.round(n / total * 100)}%`;
    const votes = n => `${n} vote${n === 1 ? '' : 's'} (${pct(n)})`;
    const winners = ranked.filter(c => c.n === ranked[0].n);
    const head = winners.map(w => `## ${w.d.name}\n${result(w.d)} · **${votes(w.n)}**`).join('\n');

    // Top 3 by votes; drivers on the same votes share the medal.
    const medals = ['🥇', '🥈', '🥉'];
    const lines = [];
    let place = -1, last = null;
    for (const c of ranked) {
        if (c.n !== last) { place++; last = c.n; }
        if (place > 2) break;
        lines.push(`${medals[place]} **${c.d.name}** · ${result(c.d)} · ${votes(c.n)}`);
    }
    embed.setDescription(`${winners.length > 1 ? '**Shared driver of the day!**\n' : ''}${head}\n\n${lines.join('\n')}`)
        .setFooter({ text: `${total} vote${total === 1 ? '' : 's'}` });
    return { embeds: [embed] };
}

// ---------------------------------------------------------------- actions

// /dotd csv title
async function start(interaction) {
    if (!canStart(interaction)) {
        return interaction.reply({ content: '❌ You don\'t have permission to start a Driver of the Day poll.', flags: MessageFlags.Ephemeral });
    }
    const file = interaction.options.getAttachment('csv');
    const title = interaction.options.getString('title').trim();
    if (!/\.csv$/i.test(file.name)) return interaction.reply({ content: '❌ The file must be a .csv.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let drivers;
    try {
        const res = await fetch(file.url);
        if (!res.ok) throw new Error('Couldn\'t download the file.');
        drivers = driversFromCsv(parseCsv(await res.text()));
    } catch (err) {
        return interaction.editReply(`❌ ${err.message}`);
    }
    if (!drivers.length) return interaction.editReply('❌ The CSV has no drivers.');
    if (drivers.length > MAX_DRIVERS) return interaction.editReply(`❌ Up to ${MAX_DRIVERS} drivers fit in a poll (this race has ${drivers.length}).`);

    const poll = { channelId: interaction.channelId, title, closesAt: Date.now() + DURATION_MS, drivers, votes: {}, closed: false, by: interaction.user.id };
    const message = await interaction.channel.send({ ...pollView(poll), allowedMentions: { parse: [] } });
    const all = readAll();
    all[message.id] = poll;
    writeAll(all);
    return interaction.editReply('✅ Driver of the Day poll posted.');
}

const isDotdButton = id => id.startsWith(VOTE) || id === MINE;

async function handleButton(interaction) {
    const messageId = interaction.message.id;
    const poll = readAll()[messageId];
    if (!poll || poll.closed || Date.now() >= poll.closesAt) {
        return interaction.reply({ content: '🔒 This poll is closed.', flags: MessageFlags.Ephemeral });
    }
    const userId = interaction.user.id;

    if (interaction.customId === MINE) {
        const i = poll.votes[userId];
        return interaction.reply({ content: i == null ? 'You haven\'t voted yet.' : `🗳️ You voted for **${poll.drivers[i].name}**.`, flags: MessageFlags.Ephemeral });
    }

    const index = Number(interaction.customId.slice(VOTE.length));
    if (!poll.drivers[index]) return interaction.reply({ content: '⚠️ Unknown driver.', flags: MessageFlags.Ephemeral });
    let reply;
    const updated = update(messageId, p => {
        if (p.votes[userId] === index) {
            delete p.votes[userId];
            reply = `↩️ Vote for **${p.drivers[index].name}** taken back.`;
        } else {
            reply = p.votes[userId] == null ? `✅ You voted for **${p.drivers[index].name}**.` : `🔁 Vote changed to **${p.drivers[index].name}**.`;
            p.votes[userId] = index;
        }
    });
    await interaction.reply({ content: reply, flags: MessageFlags.Ephemeral });
    await interaction.message.edit({ ...pollView(updated), allowedMentions: { parse: [] } }).catch(() => { });
}

async function close(client, messageId) {
    const poll = update(messageId, p => { p.closed = true; });
    const channel = await client.channels.fetch(poll.channelId).catch(() => null);
    if (!channel) return console.warn(`⚠️ [DOTD] Channel ${poll.channelId} not found.`);
    const message = await channel.messages.fetch(messageId).catch(() => null);
    await message?.edit({ ...pollView(poll), allowedMentions: { parse: [] } }).catch(() => { });
    await channel.send({
        ...winnerView(poll),
        ...(message ? { reply: { messageReference: messageId, failIfNotExists: false } } : {}),
        allowedMentions: { parse: [], repliedUser: false }
    });
    console.log(`🏆 [DOTD] "${poll.title}" closed with ${Object.keys(poll.votes).length} vote(s).`);
}

async function tick(client) {
    for (const [messageId, poll] of Object.entries(readAll())) {
        if (poll.closed || Date.now() < poll.closesAt) continue;
        await close(client, messageId).catch(err => console.error(`❌ [DOTD] Closing "${poll.title}":`, err.message));
    }
}

function startDotdLoop(client) {
    const run = () => tick(client).catch(err => console.error('❌ [DOTD]', err.message));
    run();
    setInterval(run, CHECK_EVERY_MS);
}

module.exports = { start, handleButton, isDotdButton, startDotdLoop, driversFromCsv, label, winnerView };
