const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { randomUUID } = require('crypto');
const starterStore = require('../services/starters/starterStore');
const S = require('../services/starters/starterService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('attend')
        .setDescription('Check in as a starter for the next race of this league')
        // Optional: leagues without teams (e.g. AL, independents only) just use /attend.
        .addStringOption(opt => opt
            .setName('team')
            .setDescription('Team to race for (or Independent). Not needed in leagues without teams')
            .setRequired(false)
            .setAutocomplete(true)),

    // Choices depend on the channel the command is typed in: each league's
    // starters channel only lists that league's teams.
    async autocomplete(interaction) {
        const config = S.loadConfig();
        const cat = S.categoryFromChannel(interaction.channelId, config);
        if (!cat) return interaction.respond([]);

        const focused = interaction.options.getFocused().toLowerCase();
        const choices = S.teamsOf(cat, config).map(t => ({ name: t.nombre, value: t.roleId }));
        choices.push({ name: 'Independent', value: 'independent' });

        return interaction.respond(
            choices.filter(c => c.name.toLowerCase().includes(focused)).slice(0, 25)
        );
    },

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const config = S.loadConfig();
        const member = interaction.member;

        const cat = S.categoryFromChannel(interaction.channelId, config);
        if (!cat) {
            return interaction.editReply('❌ This command can only be used in a league\'s starters channel.');
        }

        const playerRoleId = config.roles_liga_jugador?.[cat];
        if (!playerRoleId || playerRoleId === '???') {
            return interaction.editReply(`❌ The driver role for **${cat}** isn't configured (roles_liga_jugador in config.json).`);
        }
        if (!member.roles.cache.has(playerRoleId)) {
            return interaction.editReply(`❌ You need the **${cat}** driver role to sign up.`);
        }

        const round = starterStore.getRound(cat);
        if (!S.isOpen(round)) {
            return interaction.editReply(`⚠️ There are no open starters for **${cat}** right now (break week or not opened yet).`);
        }

        // A league with no teams is independents only: no need to pick anything.
        const hasTeams = S.teamsOf(cat, config).length > 0;
        const target = hasTeams ? interaction.options.getString('team') : 'independent';
        if (!target) {
            return interaction.editReply('❌ Pick your team (or Independent) in the `team` option.');
        }
        const isIndependent = target === 'independent';
        const team = isIndependent ? null : config.roles_equipos[target];
        if (!isIndependent && (!team || team.categoria !== cat)) {
            return interaction.editReply('❌ That team is not valid for this league.');
        }

        const label = S.targetLabel(target, config);
        const name = member.displayName;

        // Any new /attend replaces whatever the user had pending.
        await S.cancelPendingRequests(interaction.client, cat, member.id);

        // Independent, or a team whose role you already hold -> added directly.
        if (isIndependent || member.roles.cache.has(target)) {
            const res = S.placeUser(cat, config, member.id, name, target);
            if (res === 'already') return interaction.editReply(`ℹ️ You are already signed up for **${label}**.`);
            if (res === 'full') return interaction.editReply(`❌ **${label}** is already full.`);

            S.requestBoardUpdate(interaction.client, cat);
            return interaction.editReply(`✅ You're in for **${round.roundName}** as **${label}**.`);
        }

        // Not in that team -> needs approval from that team's TO.
        const current = starterStore.getRound(cat);
        if ((current.teams[target] || []).some(e => e.userId === member.id)) {
            return interaction.editReply(`ℹ️ You are already signed up for **${label}**.`);
        }
        if ((current.teams[target] || []).length >= S.TEAM_SLOTS) {
            return interaction.editReply(`❌ **${label}** is already full.`);
        }

        const owners = await S.getTeamOwners(interaction.guild, target, cat, config);
        const reqId = randomUUID().slice(0, 8);

        const embed = new EmbedBuilder()
            .setColor(team.color || '#5865F2')
            .setTitle('📝 Starter request')
            .setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 256 }))
            .setDescription(
                `${member} wants to race for **${label}** in **${round.roundName}**.\n` +
                `A team owner (TO) of **${label}** has to accept or decline.`
            )
            .setFooter({ text: `Request #${reqId}` })
            .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`starter_accept_${cat}_${reqId}`).setLabel('✅ Accept').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`starter_decline_${cat}_${reqId}`).setLabel('❌ Decline').setStyle(ButtonStyle.Danger)
        );

        const message = await interaction.channel.send({
            content: owners.length ? owners.map(o => `${o}`).join(' ') : undefined,
            embeds: [embed],
            components: [row],
            allowedMentions: { users: owners.map(o => o.id) }
        });

        starterStore.updateRound(cat, r => {
            r.requests[reqId] = { userId: member.id, name, teamRoleId: target, messageId: message.id };
        });

        return interaction.editReply(`📨 Request sent. A TO of **${label}** has to accept it.`);
    }
};
