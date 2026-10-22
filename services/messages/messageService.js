const fs = require('fs');
const path = require('path');
const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, MessageFlags } = require('discord.js');

/*
 * /message posts a plain message as the bot; "Edit message" (right click ->
 * Apps) lets anyone with one of that server's roles change it later. Roles and
 * the edit log channel per server in config "messages" ("main" = GUILD_ID).
 * Only messages sent with /message can be edited (data/messages.json). Every
 * message sent and every edit is logged in the server's log channel.
 */

const storeFile = path.join(__dirname, '../../data/messages.json');
const NEW_ID = 'msg:new';
const EDIT_ID = 'msg:edit:';
const MAX = 2000;

function readAll() {
    try { return JSON.parse(fs.readFileSync(storeFile, 'utf-8')); }
    catch { return {}; }
}

function remember(messageId, data) {
    const all = readAll();
    all[messageId] = data;
    fs.writeFileSync(storeFile, JSON.stringify(all, null, 2));
}

function serverSettings(guildId) {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../../config.json'), 'utf-8'));
    const servers = config.messages || {};
    return servers[guildId === process.env.GUILD_ID ? 'main' : guildId] || null;
}

function allowed(interaction) {
    const settings = serverSettings(interaction.guildId);
    return Boolean(settings && interaction.member?.roles.cache.some(r => settings.roles.includes(r.id)));
}

function modal(customId, title, value) {
    const input = new TextInputBuilder()
        .setCustomId('text')
        .setLabel('Message')
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(MAX)
        .setRequired(true);
    if (value) input.setValue(value);
    return new ModalBuilder().setCustomId(customId).setTitle(title).addComponents(new ActionRowBuilder().addComponents(input));
}

const denied = interaction => interaction.reply({ content: '❌ You don\'t have permission to do this.', flags: MessageFlags.Ephemeral });

// /message
async function openNew(interaction) {
    if (!allowed(interaction)) return denied(interaction);
    return interaction.showModal(modal(NEW_ID, 'New message'));
}

// Right click -> Apps -> Edit message
async function openEdit(interaction) {
    if (!allowed(interaction)) return denied(interaction);
    const message = interaction.targetMessage;
    if (message.author.id !== interaction.client.user.id || !readAll()[message.id]) {
        return interaction.reply({ content: '❌ Only messages sent with /message can be edited.', flags: MessageFlags.Ephemeral });
    }
    return interaction.showModal(modal(EDIT_ID + message.id, 'Edit message', message.content));
}

const isMessageComponent = customId => customId === NEW_ID || customId.startsWith(EDIT_ID);

async function handleModal(interaction) {
    if (!allowed(interaction)) return denied(interaction);
    const text = interaction.fields.getTextInputValue('text');

    if (interaction.customId === NEW_ID) {
        // Role and user mentions ping on the first send only; @everyone/@here never.
        const sent = await interaction.channel.send({ content: text, allowedMentions: { parse: ['roles', 'users'] } });
        remember(sent.id, { guildId: interaction.guildId, channelId: sent.channelId, by: interaction.user.id, at: Date.now() });
        await interaction.reply({ content: '✅ Message sent.', flags: MessageFlags.Ephemeral });
        return log(interaction, `📝 <@${interaction.user.id}> sent ${sent.url}\n${block(text, 1800)}`);
    }

    const messageId = interaction.customId.slice(EDIT_ID.length);
    const message = await interaction.channel.messages.fetch(messageId).catch(() => null);
    if (!message) return interaction.reply({ content: '❌ The message no longer exists.', flags: MessageFlags.Ephemeral });
    const before = message.content;
    if (before === text) return interaction.reply({ content: 'Nothing changed.', flags: MessageFlags.Ephemeral });

    await message.edit({ content: text, allowedMentions: { parse: [] } });
    await interaction.reply({ content: '✅ Message edited.', flags: MessageFlags.Ephemeral });
    await log(interaction, `✏️ <@${interaction.user.id}> edited ${message.url}\n**Before:**\n${block(before, 900)}\n**After:**\n${block(text, 900)}`);
}

// The text in a code block, cut to fit in one log message.
function block(text, max) {
    const t = (text.length > max ? text.slice(0, max) + '…' : text).replace(/```/g, '`​``');
    return '```\n' + t + '\n```';
}

// Every message sent and every edit (who, link, text), in the server's log channel.
async function log(interaction, content) {
    const channelId = serverSettings(interaction.guildId)?.log_channel;
    const channel = channelId && await interaction.client.channels.fetch(channelId).catch(() => null);
    if (!channel) return console.warn(`⚠️ [Messages] Log channel ${channelId} not found.`);
    await channel.send({ content, allowedMentions: { parse: [] } }).catch(err => console.error('❌ [Messages] Log:', err.message));
}

module.exports = { openNew, openEdit, handleModal, isMessageComponent };
