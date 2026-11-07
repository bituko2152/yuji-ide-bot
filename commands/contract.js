const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const contractStore = require('../services/contracts/contractStore');
const { teamColor } = require('../services/core/teamColors');
const lineups = require('../services/lineups/lineupService');

// Offers accepted and still waiting for their 24 h: their seat is taken.
const waitingFor = (categoria, teamRoleId, seatType) => Object.values(contractStore.allContracts())
    .filter(c => c.status === 'accepted' && !c.granted && c.categoria === categoria && c.teamRoleId === teamRoleId && c.seatType === seatType)
    .map(c => c.toUserId);

function loadConfig() {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '../config.json'), 'utf-8'));
}

/**
 * Returns the list of team roles (from config.team_roles) that this
 * member actually holds, so they can only offer for team(s) their own
 * manager role represents.
 */
function getManagedTeamRoles(member, config) {
    return Object.entries(config.team_roles)
        .filter(([roleId]) => member.roles.cache.has(roleId))
        .map(([roleId, info]) => ({ roleId, ...info, color: teamColor(info) }));
}

module.exports = {
    waitingFor,
    data: new SlashCommandBuilder()
        .setName('offercontract')
        .setDescription('Offer a driver contract for your team to a server member')
        .addUserOption(opt => opt.setName('driver').setDescription('Player to offer the contract to').setRequired(true))
        .addStringOption(opt => opt.setName('seat').setDescription('Driver type').setRequired(true)
            .addChoices(
                { name: 'Main Driver', value: 'main' },
                { name: 'Reserve Driver', value: 'reserve' }
            )),

    async execute(interaction) {
        const config = loadConfig();
        const member = interaction.member;
        const target = interaction.options.getUser('driver');
        const seatType = interaction.options.getString('seat'); // 'main' | 'reserve' — cosmetic only
        const seatLabel = seatType === 'main' ? 'Main Driver' : 'Reserve Driver';

        if (target.bot) {
            return interaction.reply({ content: '❌ You cannot offer a contract to a bot.', ephemeral: true });
        }

        // The league is determined by the CHANNEL the command is run in,
        // not by "the first team role the manager happens to have" — this
        // avoids issues with managers who hold roles for several teams/leagues.
        const leagueChannels = config.league_channels || {};
        const categoria = Object.entries(leagueChannels).find(([, chId]) => chId === interaction.channelId)?.[0];

        if (!categoria) {
            return interaction.reply({
                content: '❌ This command can only be used in your league\'s designated channel. Use /offercontract in the right channel.',
                ephemeral: true
            });
        }

        const managedTeams = getManagedTeamRoles(member, config);
        if (managedTeams.length === 0) {
            return interaction.reply({
                content: '❌ You don\'t have any team manager role configured, so you can\'t offer contracts.',
                ephemeral: true
            });
        }

        // Among the teams this manager holds, keep only the one(s) that
        // belong to this channel's league.
        let teamsInThisLeague = managedTeams.filter(t => t.league === categoria);
        // An owner who is also a driver / reserve elsewhere: the team they run, from the lineup.
        if (teamsInThisLeague.length > 1) {
            const staffOf = lineups.staffTeams(categoria, member.id);
            const run = teamsInThisLeague.filter(t => staffOf.includes(t.roleId));
            if (run.length) teamsInThisLeague = run;
        }
        if (teamsInThisLeague.length === 0) {
            return interaction.reply({
                content: `❌ None of your teams belong to the **${categoria}** league, so you can't offer here.`,
                ephemeral: true
            });
        }
        if (teamsInThisLeague.length > 1) {
            return interaction.reply({
                content: `⚠️ You have several teams in the **${categoria}** league (${teamsInThisLeague.map(t => t.name).join(', ')}). Contact an admin to fix this configuration before offering.`,
                ephemeral: true
            });
        }

        const team = teamsInThisLeague[0];

        const ligaManagerRoleId = config.league_manager_roles?.[categoria];
        if (ligaManagerRoleId && !member.roles.cache.has(ligaManagerRoleId)) {
            return interaction.reply({
                content: `❌ Your team role belongs to the **${categoria}** category, but you don't have the manager role for that league.`,
                ephemeral: true
            });
        }

        const ligaJugadorRoleId = config.league_driver_roles?.[categoria];
        if (!ligaJugadorRoleId || ligaJugadorRoleId === '???') {
            return interaction.reply({
                content: `❌ The player role for the **${categoria}** category isn't configured (league_driver_roles in config.json).`,
                ephemeral: true
            });
        }

        const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
        if (!targetMember) {
            return interaction.reply({ content: '❌ Could not find that member in the server.', ephemeral: true });
        }

        if (!lineups.hasFreeSeat(categoria, team.roleId, seatType, waitingFor(categoria, team.roleId, seatType))) {
            return interaction.reply({ content: `❌ The ${seatLabel.toLowerCase()} seat is full or there are no free seats at **${team.name}**: use /release first.`, ephemeral: true });
        }

        const contractId = randomUUID();

        const embedColor = team.color || '#2ecc71'; // falls back to the old default green

        const embed = new EmbedBuilder()
            .setColor(embedColor)
            .setTitle('🏎️ Driver Contract Offer')
            .setThumbnail(target.displayAvatarURL({ dynamic: true, size: 256 }))
            .setDescription(
                `${target} has received an offer to join **${team.name}** (${categoria}) as a **${seatLabel}**.\n\n` +
                `Offered by: ${interaction.user}\n` +
                `Once accepted, after **24 hours** you will automatically be granted the team role and the **${categoria}** league role.`
            )
            .setFooter({ text: `Contract #${contractId.slice(0, 8)}` })
            .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`contract_accept_${contractId}`).setLabel('✅ Accept').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`contract_decline_${contractId}`).setLabel('❌ Decline').setStyle(ButtonStyle.Danger)
        );

        const channel = interaction.channel;
        const sentMessage = await channel.send({ content: `${target}`, embeds: [embed], components: [row] });

        contractStore.createContract(contractId, {
            id: contractId,
            messageId: sentMessage.id,
            channelId: channel.id,
            guildId: interaction.guild.id,
            fromUserId: interaction.user.id,
            toUserId: target.id,
            teamRoleId: team.roleId,
            teamName: team.name,
            seatType,
            seatLabel,
            categoria,
            ligaRoleId: ligaJugadorRoleId,
            // Leagues with separate main / reserve roles (config seat_roles).
            seatRoleId: config.seat_roles?.[categoria]?.[seatType] || null,
            status: 'pending',
            createdAt: Date.now(),
            acceptedAt: null,
            grantAt: null,
            granted: false
        });

        return interaction.reply({ content: `✅ ${seatLabel} offer sent to ${target} for **${team.name}**.`, ephemeral: true });
    }
};