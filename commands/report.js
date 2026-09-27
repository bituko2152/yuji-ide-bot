const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs');
const path = require('path');
const pollStore = require('../services/pollStore');

function generateButtons(votes) {
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('vote_A').setLabel(`A (${votes.A})`).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('vote_B').setLabel(`B (${votes.B})`).setStyle(ButtonStyle.Primary)
    );
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('vote_C').setLabel(`C (${votes.C})`).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('vote_D').setLabel(`D (${votes.D})`).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('vote_E').setLabel(`E (${votes.E})`).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('vote_F').setLabel(`F (${votes.F})`).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('vote_G').setLabel(`G (${votes.G})`).setStyle(ButtonStyle.Secondary)
    );
    const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('vote_view').setLabel('👁️ View voters').setStyle(ButtonStyle.Secondary)
    );
    return [row1, row2, row3];
}

module.exports = {
    generateButtons, // exported for reuse from the global handler in index.js

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
        const categorySettings = config.config_categorias[category];

        if (!categorySettings || categorySettings.activo === false) {
            return interaction.reply({
                content: `❌ Submissions for category **${category}** are currently closed or unconfigured.`,
                ephemeral: true
            });
        }

        const culprit = interaction.options.getUser('culprit');
        const evidence = interaction.options.getString('evidence');
        const description = interaction.options.getString('description');
        const currentRound = categorySettings.round;

        const reportsChannel = interaction.guild.channels.cache.get(config.canal_reportes_id);
        if (!reportsChannel) {
            return interaction.reply({ content: '❌ The reports channel is not properly configured in the system.', ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });

        const reportId = Math.floor(1000 + Math.random() * 9000);

        const reportEmbed = new EmbedBuilder()
            .setColor('#2b2d31')
            .setTitle('Incident Report')
            .setThumbnail(culprit.displayAvatarURL({ dynamic: true }))
            .addFields(
                { name: 'ID:', value: `\`${reportId}\`` },
                { name: 'Culprit:', value: `${culprit} (${culprit.tag})` },
                { name: 'Round:', value: `\`${currentRound || 'N/A'}\`` },
                { name: 'Description:', value: `> ${description}` },
                { name: 'Proof:', value: `[Click here](${evidence})` },
                { name: 'Notes:', value: `> Submitted by ${interaction.user.username}` }
            )
            .setFooter({ text: `Created by ${interaction.user.username}` })
            .setTimestamp();

        const pollEmbed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('📊 Stewards Verdict Poll')
            .setDescription(
                `**Base Verdict:**\n🇦 No Penalty\n🇧 Penalty\n\n` +
                `**Severity Level (If Penalty):**\n🇨 LvL 1\n🇩 LvL 2\n🇪 LvL 3\n🇫 LvL 4\n🇬 LvL 5\n\n` +
                `_Click "View voters" to see who voted what._`
            );

        const votes = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0, G: 0 };

        const sentMessage = await reportsChannel.send({
            content: config.rol_stewards_id ? `<@&${config.rol_stewards_id}>` : undefined,
            embeds: [reportEmbed, pollEmbed],
            components: generateButtons(votes),
            allowedMentions: config.rol_stewards_id ? { roles: [config.rol_stewards_id] } : undefined
        });

        const thread = await sentMessage.startThread({
            name: `Report ${reportId} - ${culprit.username}`,
            autoArchiveDuration: 1440,
            reason: 'Discussion thread for race stewards evaluation.'
        });

        // We persist the state to disk (instead of an in-memory collector)
        // so the buttons keep working even if the bot restarts.
        pollStore.createPoll(sentMessage.id, {
            reportId,
            threadId: thread.id
        });

        return interaction.editReply({ content: `✅ Incident report \`#${reportId}\` has been successfully dispatched to the stewards channel.` });
    }
};