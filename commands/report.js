const { SlashCommandBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { render, createPoll } = require('../services/reports/reportService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('report')
        .setDescription('Report an incident on the track')
        .addUserOption(option =>
            option.setName('culprit').setDescription('The driver at fault').setRequired(true))
        .addStringOption(option =>
            option.setName('category').setDescription('League category')
                .setRequired(true)
                .addChoices(
                    { name: 'UL', value: 'UL' },
                    { name: 'CL', value: 'CL' },
                    { name: 'JL', value: 'JL' },
                    { name: 'AL', value: 'AL' }
                ))
        .addStringOption(option =>
            option.setName('evidence').setDescription('Video link or proof').setRequired(true))
        .addStringOption(option =>
            option.setName('description').setDescription('Brief description of what happened').setRequired(true)),

    async execute(interaction) {
        const configPath = path.join(__dirname, '../config.json');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

        const category = interaction.options.getString('category');
        const categorySettings = config.report_leagues[category];

        if (!categorySettings || categorySettings.active === false) {
            return interaction.reply({
                content: `❌ Submissions for category **${category}** are currently closed or unconfigured.`,
                ephemeral: true
            });
        }

        const culprit = interaction.options.getUser('culprit');
        const evidence = interaction.options.getString('evidence');
        const description = interaction.options.getString('description');
        const currentRound = categorySettings.round;

        const reportsChannel = interaction.guild.channels.cache.get(config.reports_channel);
        if (!reportsChannel) {
            return interaction.reply({ content: '❌ The reports channel is not properly configured in the system.', ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });

        const reportId = Math.floor(1000 + Math.random() * 9000);

        const report = {
            culpritId: culprit.id,
            round: currentRound || 'N/A',
            description,
            proof: evidence,
            reporterId: interaction.user.id,
            avatarUrl: culprit.displayAvatarURL()
        };

        const sentMessage = await reportsChannel.send({
            content: config.stewards_role ? `<@&${config.stewards_role}>` : undefined,
            ...render({ reportId, report, voters: {}, createdAt: Date.now() }),
            allowedMentions: config.stewards_role ? { roles: [config.stewards_role] } : { parse: [] }
        });

        const thread = await sentMessage.startThread({
            name: `Report ${reportId} - ${culprit.username}`,
            autoArchiveDuration: 1440,
            reason: 'Discussion thread for race stewards evaluation.'
        });

        // We persist the state to disk (instead of an in-memory collector)
        // so the votes keep working even if the bot restarts.
        createPoll(sentMessage.id, { reportId, threadId: thread.id, report });

        return interaction.editReply({ content: `✅ Incident report \`#${reportId}\` has been successfully dispatched to the stewards channel.` });
    }
};