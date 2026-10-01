const { SlashCommandBuilder } = require('discord.js');
const starterStore = require('../services/starterStore');
const S = require('../services/starterService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('removeattendance')
        .setDescription('Remove a driver from this round\'s starters (leave empty to remove yourself)')
        .addUserOption(opt => opt
            .setName('driver')
            .setDescription('Driver to remove (TO or manager only). Leave empty to remove yourself')
            .setRequired(false)),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const config = S.loadConfig();
        const cat = S.categoryFromChannel(interaction.channelId, config);
        if (!cat) {
            return interaction.editReply('❌ This command can only be used in a league\'s starters channel.');
        }

        const round = starterStore.getRound(cat);
        if (!S.isOpen(round)) {
            return interaction.editReply(`⚠️ There are no open starters for **${cat}** right now.`);
        }

        const target = interaction.options.getUser('driver') ?? interaction.user;
        const isSelf = target.id === interaction.user.id;

        const entry = S.findEntry(round, target.id);
        if (!entry) {
            return interaction.editReply(isSelf
                ? 'ℹ️ You are not signed up for this round.'
                : `ℹ️ ${target} is not signed up for this round.`);
        }

        // Removing someone else: managers can remove anyone; otherwise only the TO of the driver's team.
        if (!isSelf && !S.canManage(interaction.member, config)) {
            if (entry.kind === 'independent') {
                return interaction.editReply('❌ Independents can only remove themselves (or be removed by a manager).');
            }
            if (!S.isTO(interaction.member, entry.teamRoleId, cat, config)) {
                return interaction.editReply(`❌ Only a team owner of **${S.targetLabel(entry.teamRoleId, config)}** or a manager can remove their drivers.`);
            }
        }

        S.removeUser(cat, target.id);
        if (isSelf) await S.cancelPendingRequests(interaction.client, cat, target.id);
        S.requestBoardUpdate(interaction.client, cat);

        return interaction.editReply(isSelf
            ? `✅ You've been removed from **${round.roundName}**.`
            : `✅ ${target} has been removed from **${round.roundName}**.`);
    }
};
