const fs = require('fs');
const path = require('path');
const { SlashCommandBuilder } = require('discord.js');
const R = require('../services/results/resultsWatcher');
const U = require('../services/results/resultsUpload');

// Only in the results channel (config "resultados.canal_id"), and only for
// members with one of config "resultados.roles_permitidos"
// (/results upload: "resultados.roles_subida" instead).
function resultsConfig() {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../config.json'), 'utf-8'));
    return config.resultados || {};
}

const LEAGUES = ['UL', 'CL', 'JL', 'AL'];
const DEFAULT_Q2_LEAGUES = ['UL', 'CL'];       // Q1 + Q2
const DEFAULT_DIVISION_LEAGUES = ['JL', 'AL']; // seasons split in A/B

async function upload(interaction, cfg) {
    const league = interaction.options.getString('league');
    const division = interaction.options.getString('division');
    const needsDivision = (cfg.ligas_division || DEFAULT_DIVISION_LEAGUES).includes(league);
    if (needsDivision && !division) {
        return interaction.reply({ content: `❌ ${league} seasons are split in A/B: set the \`division\` option.`, ephemeral: true });
    }
    if (!needsDivision && division) {
        return interaction.reply({ content: `❌ ${league} has no divisions: leave \`division\` empty.`, ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });
    try {
        const plan = await U.createPlan({
            userId: interaction.user.id,
            league,
            season: interaction.options.getInteger('season'),
            round: interaction.options.getInteger('round'),
            division,
            race: interaction.options.getAttachment('race'),
            quali: interaction.options.getAttachment('quali'),
            q2: interaction.options.getAttachment('q2'),
            needsQ2: (cfg.ligas_q2 || DEFAULT_Q2_LEAGUES).includes(league)
        });
        return interaction.editReply(U.previewMessage(plan));
    } catch (err) {
        return interaction.editReply(`❌ ${err.message}`);
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('results')
        .setDescription('Capture results from an online lobby')
        .addSubcommand(sub => sub
            .setName('listen')
            .setDescription('Listen to a lobby and post its qualifying and race results')
            .addStringOption(opt => opt
                .setName('lobby')
                .setDescription('Online lobby')
                .setRequired(true)
                .setAutocomplete(true)))
        .addSubcommand(sub => sub
            .setName('stop')
            .setDescription('Stop listening to a lobby')
            .addStringOption(opt => opt
                .setName('lobby')
                .setDescription('Lobby being listened to')
                .setRequired(true)
                .setAutocomplete(true)))
        .addSubcommand(sub => sub
            .setName('upload')
            .setDescription('Upload race + qualifying CSVs to the results database (with preview)')
            .addAttachmentOption(opt => opt.setName('race').setDescription('Race CSV').setRequired(true))
            .addAttachmentOption(opt => opt.setName('quali').setDescription('Qualifying CSV (Q1 in UL/CL)').setRequired(true))
            .addStringOption(opt => opt.setName('league').setDescription('League').setRequired(true)
                .addChoices(...LEAGUES.map(l => ({ name: l, value: l }))))
            .addIntegerOption(opt => opt.setName('season').setDescription('Season number, e.g. 26').setRequired(true).setMinValue(1))
            .addIntegerOption(opt => opt.setName('round').setDescription('Round number, e.g. 3').setRequired(true).setMinValue(1))
            .addAttachmentOption(opt => opt.setName('q2').setDescription('Q2 CSV (UL/CL)').setRequired(false))
            .addStringOption(opt => opt.setName('division').setDescription('Division (JL/AL)').setRequired(false)
                .addChoices({ name: 'A', value: 'A' }, { name: 'B', value: 'B' }))),

    async autocomplete(interaction) {
        const query = interaction.options.getFocused().toLowerCase();
        const choice = (key, name) => ({ name: name.slice(0, 100), value: key });

        if (interaction.options.getSubcommand() === 'stop') {
            return interaction.respond([...R.watching.entries()]
                .filter(([, w]) => w.lobby.name.toLowerCase().includes(query))
                .slice(0, 25)
                .map(([key, w]) => choice(key, w.lobby.name)));
        }

        const lobbies = await R.listLobbies().catch(() => []);
        return interaction.respond(lobbies
            .filter(l => l.name.toLowerCase().includes(query))
            .slice(0, 25)
            .map(l => choice(R.lobbyKey(l), `${l.name} · ${l.players} players · ${l.state}${R.isWatching(R.lobbyKey(l)) ? ' · 👂' : ''}`)));
    },

    async execute(interaction) {
        const cfg = resultsConfig();
        if (interaction.channelId !== cfg.canal_id) {
            const where = cfg.canal_id ? `<#${cfg.canal_id}>` : 'the results channel (config "resultados.canal_id" is not set)';
            return interaction.reply({ content: `❌ This command can only be used in ${where}.`, ephemeral: true });
        }

        const isUpload = interaction.options.getSubcommand() === 'upload';
        const roles = (isUpload ? cfg.roles_subida : cfg.roles_permitidos) || [];
        if (!roles.some(id => interaction.member.roles.cache.has(id))) {
            return interaction.reply({ content: '❌ You are not allowed to use this command.', ephemeral: true });
        }
        if (isUpload) return upload(interaction, cfg);

        const key = interaction.options.getString('lobby');

        if (interaction.options.getSubcommand() === 'stop') {
            const name = R.watching.get(key)?.lobby.name;
            if (!R.stopListening(key)) {
                return interaction.reply({ content: '⚠️ Not listening to that lobby.', ephemeral: true });
            }
            // Public, so everyone in the channel knows the capture ended.
            return interaction.reply(`🔕 ${interaction.user} stopped listening to **${name}**.`);
        }

        const lobby = R.seenLobby(key);
        if (!lobby) return interaction.reply({ content: '❌ Pick the lobby from the suggestions list.', ephemeral: true });
        if (R.isWatching(key)) return interaction.reply({ content: `👂 Already listening to **${lobby.name}**.`, ephemeral: true });

        try {
            R.listen(interaction.client, lobby);
        } catch (err) {
            return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
        }
        // Public, so everyone in the channel knows a capture is running.
        return interaction.reply(`👂 ${interaction.user} started listening to **${lobby.name}**. ` +
            'The qualifying and race CSVs will be posted here; use /results stop after race ends.');
    }
};
