const { SlashCommandBuilder } = require('discord.js');
const { readConfig } = require('../services/core/config');
const stewards = require('../services/stewards/stewardService');

// Mobile server: once the race footage is out, a steward starts the 48 h
// countdown that closes reports for a league's latest race.
module.exports = {
    data: new SlashCommandBuilder()
        .setName('start-deadline')
        .setDescription('Stewards: footage is out, reports for this league close in 48 h')
        .addStringOption(o => o.setName('league').setDescription('League and race').setRequired(true)
            .addChoices(...Object.keys(readConfig().mobile_stewards?.leagues || {}).map(k => ({ name: k, value: k })))),

    execute: interaction => stewards.openWindow(interaction)
};
