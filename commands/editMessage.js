const { ContextMenuCommandBuilder, ApplicationCommandType } = require('discord.js');
const { openEdit } = require('../services/messages/messageService');

module.exports = {
    data: new ContextMenuCommandBuilder()
        .setName('Edit message')
        .setType(ApplicationCommandType.Message),

    execute: openEdit
};
