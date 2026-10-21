const { SlashCommandBuilder } = require('discord.js');
const { start } = require('../services/dotd/dotdService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('dotd')
        .setDescription('Post a Driver of the Day poll from a race CSV (closes after 48 h)')
        .addAttachmentOption(opt => opt
            .setName('csv')
            .setDescription('The race CSV posted by /results listen')
            .setRequired(true))
        .addStringOption(opt => opt
            .setName('title')
            .setDescription('Shown in the poll, e.g. the track: "Assen"')
            .setMaxLength(100)
            .setRequired(true)),

    execute: start
};
