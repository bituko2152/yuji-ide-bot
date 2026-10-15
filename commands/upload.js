const fs = require('fs');
const path = require('path');
const { SlashCommandBuilder } = require('discord.js');

/*
 * /upload replay: puts a replay on the website (Replays tab), by hand.
 *
 * The replay is the file attached to a message (link or id, default: the
 * newest replay of that session in the results channel) or an attached file.
 * It goes to the replays Worker with a PUT:
 *   https://ur2d-replays.mika2mika.workers.dev/<league>/s<season>[a|b]/r<round>[-sprint|-quali|-quali2].html
 * header "x-upload-key" = .env REPLAYS_UPLOAD_KEY. The same address again
 * replaces the file. No copy is kept: the file stays in Discord.
 * Same channel and roles as /results upload ("results.channel", "results.upload_roles").
 */

const WORKER = 'https://ur2d-replays.mika2mika.workers.dev';
const DIVISION_LEAGUES = ['JL', 'AL'];  // seasons split in A/B, rounds start again at 1
const Q2_LEAGUES = ['UL', 'CL'];         // also a Q2 ("quali2"), as in /results upload
// Address ending per session (agreed with the website).
const SUFFIX = { race: '', sprint: '-sprint', quali: '-quali', quali2: '-quali2' };
const isQuali = session => session === 'quali' || session === 'quali2';

const resultsConfig = () => JSON.parse(fs.readFileSync(path.join(__dirname, '../config.json'), 'utf-8')).results || {};

function replayPath(league, season, division, round, session) {
    return `${league.toLowerCase()}/s${season}${division ? division.toLowerCase() : ''}/r${round}${SUFFIX[session]}.html`;
}

// The replay file of a message: its .html attachment whose name says the session.
function replayIn(message, session) {
    const files = [...(message?.attachments?.values() || [])].filter(a => /_replay\.html$/i.test(a.name));
    const want = isQuali(session) ? /qualifying_replay/i : /(race_replay|[^g]_replay)\.html$/i;
    return files.find(a => want.test(a.name)) || null;
}

async function findReplay(interaction, session, twoPart) {
    const file = interaction.options.getAttachment('file');
    if (file) return { attachment: file, where: 'the attached file' };

    const link = interaction.options.getString('message');
    if (link) {
        const m = link.match(/(?:channels\/\d+\/(\d+)\/)?(\d{17,20})\s*$/);
        if (!m) throw new Error('That message link or id is not valid.');
        const channel = await interaction.client.channels.fetch(m[1] || interaction.channelId).catch(() => null);
        const message = await channel?.messages.fetch(m[2]).catch(() => null);
        if (!message) throw new Error('Message not found.');
        const attachment = [...message.attachments.values()].find(a => /\.html$/i.test(a.name));
        if (!attachment) throw new Error('That message has no replay file.');
        return { attachment, where: message.url };
    }

    // Newest replay of that session posted in this channel. With a Q2 both are
    // qualifying replays: quali2 is the newest one, quali the one before it.
    let before, skip = session === 'quali' && twoPart ? 1 : 0;
    for (let page = 0; page < 5; page++) {
        const batch = await interaction.channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        for (const message of batch.values()) {
            const attachment = replayIn(message, session);
            if (attachment && skip-- <= 0) return { attachment, where: message.url };
        }
        if (batch.size < 100) break;
        before = batch.last().id;
    }
    throw new Error(`No ${isQuali(session) ? 'qualifying' : 'race'} replay found in the last 500 messages: use \`message\` or \`file\`.`);
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('upload')
        .setDescription('Upload to the website')
        .addSubcommand(sub => sub
            .setName('replay')
            .setDescription('Put a replay on the website (Replays tab)')
            .addStringOption(opt => opt.setName('session').setDescription('Which session').setRequired(true)
                .addChoices({ name: 'Race', value: 'race' }, { name: 'Sprint race', value: 'sprint' },
                    { name: 'Qualifying', value: 'quali' }, { name: 'Qualifying 2 (UL / CL)', value: 'quali2' }))
            .addStringOption(opt => opt.setName('league').setDescription('League').setRequired(true)
                .addChoices(...['UL', 'CL', 'JL', 'AL'].map(l => ({ name: l, value: l }))))
            .addIntegerOption(opt => opt.setName('season').setDescription('Season number, e.g. 26').setRequired(true).setMinValue(1))
            .addIntegerOption(opt => opt.setName('round').setDescription('Round (JL/AL: round within the A or B half)').setRequired(true).setMinValue(1))
            .addStringOption(opt => opt.setName('division').setDescription('JL/AL: half of the season')
                .addChoices({ name: 'A', value: 'A' }, { name: 'B', value: 'B' }))
            .addStringOption(opt => opt.setName('message').setDescription('Link or id of the message with the replay (default: the newest one here)'))
            .addAttachmentOption(opt => opt.setName('file').setDescription('Or the replay .html file'))),

    async execute(interaction) {
        const cfg = resultsConfig();
        if (interaction.channelId !== cfg.channel) {
            const where = cfg.channel ? `<#${cfg.channel}>` : 'the results channel (config "results.channel" is not set)';
            return interaction.reply({ content: `❌ This command can only be used in ${where}.`, ephemeral: true });
        }
        if (!(cfg.upload_roles || []).some(id => interaction.member.roles.cache.has(id))) {
            return interaction.reply({ content: '❌ You are not allowed to use this command.', ephemeral: true });
        }
        if (!process.env.REPLAYS_UPLOAD_KEY) {
            return interaction.reply({ content: '❌ The website password is not set on the bot (.env `REPLAYS_UPLOAD_KEY`).', ephemeral: true });
        }

        const session = interaction.options.getString('session');
        const league = interaction.options.getString('league');
        const division = interaction.options.getString('division');
        const needsDivision = DIVISION_LEAGUES.includes(league);
        if (needsDivision && !division) return interaction.reply({ content: `❌ ${league} seasons are split in A/B: set \`division\`.`, ephemeral: true });
        if (!needsDivision && division) return interaction.reply({ content: `❌ ${league} has no divisions: leave \`division\` empty.`, ephemeral: true });

        const twoPart = (cfg.q2_leagues || Q2_LEAGUES).includes(league);
        if (session === 'quali2' && !twoPart) return interaction.reply({ content: `❌ ${league} has no Q2.`, ephemeral: true });

        const target = replayPath(league, interaction.options.getInteger('season'), division, interaction.options.getInteger('round'), session);
        await interaction.deferReply({ ephemeral: true });
        try {
            const { attachment, where } = await findReplay(interaction, session, twoPart);
            const res = await fetch(attachment.url);
            if (!res.ok) throw new Error(`Couldn't download the replay from Discord (${res.status}).`);
            const body = Buffer.from(await res.arrayBuffer());

            const up = await fetch(`${WORKER}/${target}`, { method: 'PUT', headers: { 'x-upload-key': process.env.REPLAYS_UPLOAD_KEY }, body });
            const reply = (await up.text().catch(() => '')).slice(0, 300);
            if (up.status === 403) throw new Error('The website rejected the password (403).');
            if (!up.ok) throw new Error(`The website said ${up.status}: ${reply || 'no details'}`);
            console.log(`🌐 [Replays] ${interaction.user.tag} uploaded ${target} (${(body.length / 1e6).toFixed(1)} MB).`);
            return interaction.editReply(`✅ Uploaded \`${attachment.name}\` (${where}) as **${target}** · ${(body.length / 1e6).toFixed(1)} MB.\n${WORKER}/${target}`);
        } catch (err) {
            console.error('❌ [Replays] Upload:', err.message);
            return interaction.editReply(`❌ ${err.message}`);
        }
    }
};
