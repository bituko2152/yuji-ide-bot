const { EmbedBuilder } = require('discord.js');
const pollStore = require('./pollStore');
const contractStore = require('./contractStore');
const { generateButtons } = require('../commands/report');

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

async function handlePollVote(interaction) {
    const choice = interaction.customId.split('_')[1]; // A..G or 'view'
    const messageId = interaction.message.id;
    const poll = pollStore.getPoll(messageId);

    if (!poll) {
        return interaction.reply({ content: "⚠️ Couldn't find this poll's state (it may be too old).", ephemeral: true });
    }

    if (choice === 'view') {
        const baseLines = Object.entries(poll.baseVotes).map(([uid, c]) => `<@${uid}> → **${c}**`);
        const levelLines = Object.entries(poll.levelVotes).map(([uid, c]) => `<@${uid}> → **${c}**`);
        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('👁️ Voters for this poll')
            .addFields(
                { name: 'Base verdict', value: baseLines.length ? baseLines.join('\n') : 'No votes yet.' },
                { name: 'Severity level', value: levelLines.length ? levelLines.join('\n') : 'No votes yet.' }
            );
        // Visible to everyone in the thread, not ephemeral, as requested.
        const thread = poll.threadId ? await interaction.guild.channels.fetch(poll.threadId).catch(() => null) : null;
        if (thread) {
            await thread.send({ embeds: [embed] });
            return interaction.reply({ content: '✅ Voter list posted in the thread.', ephemeral: true });
        }
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    const userId = interaction.user.id;
    const isBaseVote = ['A', 'B'].includes(choice);
    const voteMap = isBaseVote ? 'baseVotes' : 'levelVotes';

    const updated = pollStore.updatePoll(messageId, (p) => {
        const previous = p[voteMap][userId];
        if (previous === choice) {
            p.votes[choice]--;
            delete p[voteMap][userId];
        } else {
            if (previous) p.votes[previous]--;
            p.votes[choice]++;
            p[voteMap][userId] = choice;
        }
    });

    await interaction.update({ components: generateButtons(updated.votes) });
}

async function handleContractButton(interaction) {
    const [, action, contractId] = interaction.customId.split('_'); // contract_accept_<id> / contract_decline_<id>
    const contract = contractStore.getContract(contractId);

    if (!contract) {
        return interaction.reply({ content: "⚠️ This offer no longer exists or is too old.", ephemeral: true });
    }
    if (interaction.user.id !== contract.toUserId) {
        return interaction.reply({ content: '❌ This offer is not for you.', ephemeral: true });
    }
    if (contract.status !== 'pending') {
        return interaction.reply({ content: `⚠️ This offer was already **${contract.status}**.`, ephemeral: true });
    }

    const originalEmbed = interaction.message.embeds[0];

    if (action === 'decline') {
        contractStore.updateContract(contractId, c => { c.status = 'declined'; });

        const updatedEmbed = EmbedBuilder.from(originalEmbed)
            .setColor('#e74c3c')
            .addFields({ name: 'Status', value: `❌ Declined by ${interaction.user}` });

        // Publicly visible edit — everyone in the channel sees the outcome,
        // not just the person who clicked the button.
        await interaction.update({ embeds: [updatedEmbed], components: [] });
        return;
    }

    if (action === 'accept') {
        const now = Date.now();
        const grantAt = now + TWENTY_FOUR_HOURS_MS;
        contractStore.updateContract(contractId, c => {
            c.status = 'accepted';
            c.acceptedAt = now;
            c.grantAt = grantAt;
        });

        const updatedEmbed = EmbedBuilder.from(originalEmbed)
            .setColor('#2ecc71')
            .addFields({
                name: 'Status',
                value: `✅ Accepted by ${interaction.user} — the team and league roles will be granted automatically <t:${Math.floor(grantAt / 1000)}:R>.`
            });

        await interaction.update({ embeds: [updatedEmbed], components: [] });
        return;
    }
}

async function handleButtonInteraction(interaction) {
    if (!interaction.isButton()) return false;

    if (interaction.customId.startsWith('vote_')) {
        await handlePollVote(interaction);
        return true;
    }
    if (interaction.customId.startsWith('contract_')) {
        await handleContractButton(interaction);
        return true;
    }
    return false;
}

module.exports = { handleButtonInteraction };