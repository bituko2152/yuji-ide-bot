const { SlashCommandBuilder } = require('discord.js');
const stewards = require('../services/stewards/stewardService');

// Mobile server: the reported driver adds their own clip to a report being voted.
module.exports = {
    data: new SlashCommandBuilder()
        .setName('share-pov')
        .setDescription('Add your point of view to a report against you')
        .addStringOption(o => o.setName('report').setDescription('The report against you').setRequired(true).setAutocomplete(true))
        .addAttachmentOption(o => o.setName('clip').setDescription('Your clip'))
        .addStringOption(o => o.setName('link').setDescription('Or a link to your clip (YouTube, Medal…)')),

    async autocomplete(interaction) {
        const open = stewards.openReportsAgainst(interaction.user.id);
        await interaction.respond(open.slice(0, 25).map(r => ({
            name: `#${r.id} · ${r.key} ${r.round} · ${r.explanation}`.slice(0, 100),
            value: String(r.id)
        })));
    },

    execute: interaction => stewards.sharePov(interaction)
};
