const { SlashCommandBuilder } = require('discord.js');
const { openNew } = require('../services/messages/messageService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('message')
        .setDescription('Post a message as the bot in this channel (editable later by your role)'),

    execute: openNew
};
