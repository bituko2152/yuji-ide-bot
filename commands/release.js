const { readConfig } = require('../services/core/config');
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const fs = require('fs');
const path = require('path');
const lineups = require('../services/lineups/lineupService');
const { teamColor } = require('../services/core/teamColors');

/*
 * /release            -> a driver leaves their team in this channel's league.
 * /release driver:@x  -> a team owner ends that driver's contract; the driver
 *                        has to agree with a button.
 * Either way, at once: the team role (and seat role) goes, the seat is freed
 * in the lineup and it's announced here.
 */

const loadConfig = () => readConfig();
const leagueOf = (config, channelId) => Object.entries(config.league_channels || {}).find(([, id]) => id === channelId)?.[0];
const teamsIn = (config, member, cat) => Object.entries(config.team_roles)
    .filter(([roleId, t]) => t.league === cat && member.roles.cache.has(roleId))
    .map(([roleId, t]) => ({ roleId, ...t }));

async function release(guild, channel, cat, team, member, endedBy) {
    const config = loadConfig();
    const seatRoles = Object.values(config.seat_roles?.[cat] || {}).filter(id => id && member.roles.cache.has(id));
    await member.roles.remove([team.roleId, ...seatRoles]);
    await lineups.releaseDriver(guild.client, cat, member.id).catch(err => console.error('❌ [Lineups] Release not shown:', err.message));
    const embed = new EmbedBuilder()
        .setColor(teamColor(team) || '#95a5a6')
        .setTitle('👋 Contract ended')
        .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
        .setDescription(endedBy
            ? `${member} and **${team.name}** (${cat}) have ended their contract by mutual agreement with ${endedBy}. The team role has been removed.`
            : `${member} has left **${team.name}** (${cat}). The team role has been removed.`)
        .setTimestamp();
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => { });
    console.log(`👋 [Contracts] ${member.user.tag} left ${team.name} (${cat}).`);
}

// release_<accept|decline>_<teamRoleId>_<driverId>_<ownerId>
async function handleReleaseButton(interaction) {
    const [, action, teamRoleId, driverId, ownerId] = interaction.customId.split('_');
    if (interaction.user.id !== driverId) {
        return interaction.reply({ content: '❌ This is not for you.', flags: MessageFlags.Ephemeral });
    }
    const config = loadConfig();
    const team = { roleId: teamRoleId, ...config.team_roles[teamRoleId] };
    const embed = EmbedBuilder.from(interaction.message.embeds[0]);
    if (action === 'decline') {
        return interaction.update({ embeds: [embed.setColor('#e74c3c').addFields({ name: 'Status', value: `❌ Declined by ${interaction.user}` })], components: [] });
    }
    const member = await interaction.guild.members.fetch(driverId).catch(() => null);
    if (!member?.roles.cache.has(teamRoleId)) {
        return interaction.update({ embeds: [embed.addFields({ name: 'Status', value: `⚠️ ${interaction.user} is no longer in ${team.name}.` })], components: [] });
    }
    await interaction.update({ embeds: [embed.setColor('#2ecc71').addFields({ name: 'Status', value: `✅ Agreed by ${interaction.user}` })], components: [] });
    await release(interaction.guild, interaction.channel, team.league, team, member, `<@${ownerId}>`);
}

module.exports = {
    handleReleaseButton,
    data: new SlashCommandBuilder()
        .setName('release')
        .setDescription('Leave your team, or (team owners) end a driver\'s contract by mutual agreement')
        .addUserOption(o => o.setName('driver').setDescription('Team owners: the driver whose contract ends (they must agree)')),

    async execute(interaction) {
        const config = loadConfig();
        const cat = leagueOf(config, interaction.channelId);
        if (!cat) {
            return interaction.reply({ content: '❌ Use /release in your league\'s contracts channel.', flags: MessageFlags.Ephemeral });
        }
        const target = interaction.options.getUser('driver');

        if (!target || target.id === interaction.user.id) {
            // Several team roles (owner of one, driver of another): the team they drive for.
            let mine = teamsIn(config, interaction.member, cat);
            const seat = lineups.seatTeam(cat, interaction.user.id);
            if (mine.length > 1 && seat) mine = mine.filter(t => t.roleId === seat);
            const [team, other] = mine;
            if (!team) return interaction.reply({ content: `❌ You aren't in any **${cat}** team.`, flags: MessageFlags.Ephemeral });
            if (other) return interaction.reply({ content: '⚠️ You have several team roles in this league: ask an admin.', flags: MessageFlags.Ephemeral });
            await interaction.reply({ content: `✅ You have left **${team.name}**.`, flags: MessageFlags.Ephemeral });
            return release(interaction.guild, interaction.channel, cat, team, interaction.member, null);
        }

        const managerRole = config.league_manager_roles?.[cat];
        const staffOf = lineups.staffTeams(cat, interaction.user.id);
        const owned = teamsIn(config, interaction.member, cat);
        const team = owned.find(t => staffOf.includes(t.roleId)) || (owned.length === 1 ? owned[0] : null);
        if (!team || (managerRole && !interaction.member.roles.cache.has(managerRole))) {
            return interaction.reply({ content: `❌ Only a **${cat}** team owner can end a driver's contract.`, flags: MessageFlags.Ephemeral });
        }
        const driver = await interaction.guild.members.fetch(target.id).catch(() => null);
        if (!driver?.roles.cache.has(team.roleId)) {
            return interaction.reply({ content: `❌ ${target} isn't in **${team.name}**.`, flags: MessageFlags.Ephemeral });
        }
        const embed = new EmbedBuilder()
            .setColor(teamColor(team) || '#e67e22')
            .setTitle('📝 Contract termination')
            .setThumbnail(target.displayAvatarURL({ size: 256 }))
            .setDescription(`${interaction.user} proposes to end ${target}'s contract with **${team.name}** (${cat}) by mutual agreement.\n\n${target}, if you agree, you'll leave the team at once.`)
            .setTimestamp();
        const id = `${team.roleId}_${target.id}_${interaction.user.id}`;
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`release_accept_${id}`).setLabel('✅ Agree').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`release_decline_${id}`).setLabel('❌ Decline').setStyle(ButtonStyle.Danger)
        );
        await interaction.channel.send({ content: `${target}`, embeds: [embed], components: [row] });
        return interaction.reply({ content: `✅ Proposal sent to ${target}.`, flags: MessageFlags.Ephemeral });
    }
};
