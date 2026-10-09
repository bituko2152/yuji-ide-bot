const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const contractStore = require('../services/contracts/contractStore');

function loadConfig() {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '../config.json'), 'utf-8'));
}

/**
 * Returns the list of team roles (from config.roles_equipos) that this
 * member actually holds, so they can only offer for team(s) their own
 * manager role represents.
 */
function getManagedTeamRoles(member, config) {
    return Object.entries(config.roles_equipos)
        .filter(([roleId]) => member.roles.cache.has(roleId))
        .map(([roleId, info]) => ({ roleId, ...info }));
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('offercontract')
        .setDescription('Offer a driver contract for your team to a server member')
        .addUserOption(opt => opt.setName('driver').setDescription('Player to offer the contract to').setRequired(true))
        .addStringOption(opt => opt.setName('seat').setDescription('Seat type (display only — does not change the role granted)').setRequired(true)
            .addChoices(
                { name: 'Main Seat', value: 'main' },
                { name: 'Reserve Seat', value: 'reserve' }
            )),

    async execute(interaction) {
        const config = loadConfig();
        const member = interaction.member;
        const target = interaction.options.getUser('driver');
        const seatType = interaction.options.getString('seat'); // 'main' | 'reserve' — cosmetic only
        const seatLabel = seatType === 'main' ? 'Main Seat' : 'Reserve Seat';

        if (target.bot) {
            return interaction.reply({ content: '❌ You cannot offer a contract to a bot.', ephemeral: true });
        }

        // The league is determined by the CHANNEL the command is run in,
        // not by "the first team role the manager happens to have" — this
        // avoids issues with managers who hold roles for several teams/leagues.
        const leagueChannels = config.canales_liga || {};
        const categoria = Object.entries(leagueChannels).find(([, chId]) => chId === interaction.channelId)?.[0];

        if (!categoria) {
            return interaction.reply({
                content: '❌ This command can only be used in your league\'s designated channel (UL/CL/JL/AL). Use /offercontract in the right channel.',
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
        const teamsInThisLeague = managedTeams.filter(t => t.categoria === categoria);
        if (teamsInThisLeague.length === 0) {
            return interaction.reply({
                content: `❌ None of your teams belong to the **${categoria}** league, so you can't offer here.`,
                ephemeral: true
            });
        }
        if (teamsInThisLeague.length > 1) {
            return interaction.reply({
                content: `⚠️ You have several teams in the **${categoria}** league (${teamsInThisLeague.map(t => t.nombre).join(', ')}). Contact an admin to fix this configuration before offering.`,
                ephemeral: true
            });
        }

        const team = teamsInThisLeague[0];

        const ligaManagerRoleId = config.roles_liga_manager?.[categoria];
        if (ligaManagerRoleId && !member.roles.cache.has(ligaManagerRoleId)) {
            return interaction.reply({
                content: `❌ Your team role belongs to the **${categoria}** category, but you don't have the manager role for that league.`,
                ephemeral: true
            });
        }

        const ligaJugadorRoleId = config.roles_liga_jugador?.[categoria];
        if (!ligaJugadorRoleId || ligaJugadorRoleId === '???') {
            return interaction.reply({
                content: `❌ The player role for the **${categoria}** category isn't configured (roles_liga_jugador in config.json).`,
                ephemeral: true
            });
        }

        const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
        if (!targetMember) {
            return interaction.reply({ content: '❌ Could not find that member in the server.', ephemeral: true });
        }

        const contractId = randomUUID();

        const teamColor = team.color || '#2ecc71'; // hex from config, falls back to the old default green

        const embed = new EmbedBuilder()
            .setColor(teamColor)
            .setTitle('🏎️ Driver Contract Offer')
            .setThumbnail(target.displayAvatarURL({ dynamic: true, size: 256 }))
            .setDescription(
                `${target} has received an offer to join **${team.nombre}** (${categoria}) as **${seatLabel}**.\n\n` +
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
            teamName: team.nombre,
            seatType,
            seatLabel,
            categoria,
            ligaRoleId: ligaJugadorRoleId,
            status: 'pending',
            createdAt: Date.now(),
            acceptedAt: null,
            grantAt: null,
            granted: false
        });

        return interaction.reply({ content: `✅ ${seatLabel} offer sent to ${target} for **${team.nombre}**.`, ephemeral: true });
    }
};