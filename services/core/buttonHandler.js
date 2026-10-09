const { EmbedBuilder } = require('discord.js');
const contractStore = require('../contracts/contractStore');
const { handleReportComponent, isReportComponent } = require('../reports/reportService');
const { handleStarterButton } = require('../starters/starterService');
const { handleUploadComponent, isUploadComponent } = require('../results/resultsUpload');

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

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

    if (isReportComponent(interaction.customId)) {
        await handleReportComponent(interaction);
        return true;
    }
    if (interaction.customId.startsWith('contract_')) {
        await handleContractButton(interaction);
        return true;
    }
    if (interaction.customId.startsWith('starter_')) {
        await handleStarterButton(interaction);
        return true;
    }
    if (isUploadComponent(interaction.customId)) {
        await handleUploadComponent(interaction);
        return true;
    }
    return false;
}

module.exports = { handleButtonInteraction };
