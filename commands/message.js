const { SlashCommandBuilder } = require('discord.js');
const { openNew } = require('../services/messages/messageService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('message')
        .setDescription('Post a message as the bot in this channel (editable later by your role)')
        .addAttachmentOption(opt => opt.setName('image').setDescription('An image to attach').setRequired(false))
        .addAttachmentOption(opt => opt.setName('image2').setDescription('A second image').setRequired(false))
        .addAttachmentOption(opt => opt.setName('image3').setDescription('A third image').setRequired(false)),

    execute: openNew
};
