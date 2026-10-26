const { SlashCommandBuilder } = require('discord.js');
const starterStore = require('../services/starters/starterStore');
const S = require('../services/starters/starterService');

/*
 * A team owner (TO) signs up drivers of their own team for this round's
 * starters: drivers who hold both the team's role and the league's driver role.
 * A driver already in the starters (Independent, another team) is moved to the
 * team, and their pending request is cancelled. Nobody is notified: they show
 * up on the board.
 */
module.exports = {
    data: new SlashCommandBuilder()
        .setName('setattendance')
        .setDescription('Team owners: sign up drivers of your team for this round\'s starters')
        .addUserOption(opt => opt
            .setName('driver')
            .setDescription('Driver of your team')
            .setRequired(true))
        .addUserOption(opt => opt
            .setName('driver2')
            .setDescription('Another driver of your team')
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

        // The TO's team: a team of this league whose role they hold, with the league manager role.
        const team = S.teamsOf(cat, config).find(t => S.isTO(interaction.member, t.roleId, cat, config));
        if (!team) {
            return interaction.editReply(`❌ Only a team owner (TO) of a **${cat}** team can set its lineup.`);
        }

        const driverRoleId = config.league_driver_roles?.[cat];
        const users = [interaction.options.getUser('driver'), interaction.options.getUser('driver2')]
            .filter(Boolean)
            .filter((u, i, all) => all.findIndex(x => x.id === u.id) === i);

        const lines = [];
        for (const user of users) {
            const member = await interaction.guild.members.fetch(user.id).catch(() => null);
            if (!member) { lines.push(`❌ ${user} is not in this server.`); continue; }
            if (!member.roles.cache.has(team.roleId) || !driverRoleId || !member.roles.cache.has(driverRoleId)) {
                lines.push(`❌ ${user} needs the **${team.name}** and **${cat}** driver roles.`);
                continue;
            }
            const res = S.placeUser(cat, config, member.id, member.displayName, team.roleId);
            if (res === 'already') { lines.push(`ℹ️ ${user} is already in for **${team.name}**.`); continue; }
            if (res === 'full') { lines.push(`❌ **${team.name}** is full: ${user} was not added.`); continue; }
            await S.cancelPendingRequests(interaction.client, cat, member.id);
            lines.push(`✅ ${user} is in for **${team.name}** in **${round.roundName}**.`);
        }

        S.requestBoardUpdate(interaction.client, cat);
        return interaction.editReply(lines.join('\n'));
    }
};
