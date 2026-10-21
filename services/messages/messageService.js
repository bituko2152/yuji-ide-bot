const fs = require('fs');
const path = require('path');
const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, MessageFlags } = require('discord.js');

/*
 * /message posts a plain message as the bot; "Edit message" (right click ->
 * Apps) lets anyone with one of that server's roles change it later. Roles and
 * the edit log channel per server in config "messages" ("main" = GUILD_ID).
 * Only messages sent with /message can be edited (data/messages.json). Every
 * message sent and every edit is logged in the server's log channel. Up to 3
 * images can be attached; "@Role name" / "@user" typed in the form ping.
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

// ---------------------------------------------------------------- mentions

// A form can't pick mentions like the chat box does, so "@Challenger League",
// "@Bituko" or "#starters" typed as text become real mentions: role names (longest first, so
// "@Challenger League" wins over "@Challenger"), then members by name.
async function toMentions(guild, text) {
    const roles = [...guild.roles.cache.values()]
        .filter(r => r.id !== guild.id)
        .sort((a, b) => b.name.length - a.name.length);
    for (const role of roles) {
        const escaped = role.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        text = text.replace(new RegExp(`@${escaped}(?![\\w])`, 'gi'), `<@&${role.id}>`);
    }
    // "#general" / "#🏁・race-results" -> channel links (longest names first, like roles).
    const channels = [...guild.channels.cache.values()]
        .filter(c => c.name && !c.isThread?.())
        .sort((a, b) => b.name.length - a.name.length);
    for (const channel of channels) {
        const escaped = channel.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        text = text.replace(new RegExp(`#${escaped}(?![\\w-])`, 'gi'), `<#${channel.id}>`);
    }
    const names = [...new Set([...text.matchAll(/@([\w.]{2,32})/g)].map(m => m[1]))];
    for (const name of names) {
        const found = await guild.members.fetch({ query: name, limit: 10 }).catch(() => null);
        const lower = name.toLowerCase();
        const member = found?.find(m => [m.user.username, m.displayName, m.user.globalName]
            .some(n => n?.toLowerCase() === lower));
        if (member) text = text.replace(new RegExp(`@${name.replace(/\./g, '\\.')}(?![\\w.])`, 'g'), `<@${member.id}>`);
    }
    return text;
}

// The other way round, to show a message in the edit form as it was typed.
function fromMentions(guild, text) {
    return text
        .replace(/<@&(\d+)>/g, (m, id) => (guild.roles.cache.get(id) ? `@${guild.roles.cache.get(id).name}` : m))
        .replace(/<@!?(\d+)>/g, (m, id) => (guild.members.cache.get(id) ? `@${guild.members.cache.get(id).user.username}` : m))
        .replace(/<#(\d+)>/g, (m, id) => (guild.channels.cache.get(id) ? `#${guild.channels.cache.get(id).name}` : m));
}

// ---------------------------------------------------------------- images

// Images picked in /message, kept until the form is sent (a form can't hold files).
const pendingImages = new Map(); // userId -> [{ url, name }]
const IMAGE_OPTIONS = ['image', 'image2', 'image3'];

// /message [image] [image2] [image3]
async function openNew(interaction) {
    if (!allowed(interaction)) return denied(interaction);
    const images = IMAGE_OPTIONS.map(o => interaction.options.getAttachment(o)).filter(Boolean);
    if (images.some(a => !a.contentType?.startsWith('image/'))) {
        return interaction.reply({ content: '❌ Only images can be attached.', flags: MessageFlags.Ephemeral });
    }
    pendingImages.set(interaction.user.id, images.map(a => ({ url: a.url, name: a.name })));
    return interaction.showModal(modal(NEW_ID, 'New message'));
}

// Right click -> Apps -> Edit message
async function openEdit(interaction) {
    if (!allowed(interaction)) return denied(interaction);
    const message = interaction.targetMessage;
    if (message.author.id !== interaction.client.user.id || !readAll()[message.id]) {
        return interaction.reply({ content: '❌ Only messages sent with /message can be edited.', flags: MessageFlags.Ephemeral });
    }
    return interaction.showModal(modal(EDIT_ID + message.id, 'Edit message', fromMentions(interaction.guild, message.content)));
}

const isMessageComponent = customId => customId === NEW_ID || customId.startsWith(EDIT_ID);

async function handleModal(interaction) {
    if (!allowed(interaction)) return denied(interaction);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }); // finding the mentioned members can take a moment
    const text = (await toMentions(interaction.guild, interaction.fields.getTextInputValue('text'))).slice(0, MAX);

    if (interaction.customId === NEW_ID) {
        const images = pendingImages.get(interaction.user.id) || [];
        pendingImages.delete(interaction.user.id);
        // Role and user mentions ping on the first send only; @everyone/@here never.
        const sent = await interaction.channel.send({
            content: text,
            files: images.map(i => ({ attachment: i.url, name: i.name })),
            allowedMentions: { parse: ['roles', 'users'] }
        });
        remember(sent.id, { guildId: interaction.guildId, channelId: sent.channelId, by: interaction.user.id, at: Date.now() });
        await interaction.editReply('✅ Message sent.');
        const attached = images.length ? `\n-# ${images.length} image${images.length === 1 ? '' : 's'} attached` : '';
        return log(interaction, `📝 <@${interaction.user.id}> sent ${sent.url}\n${block(text, 1800)}${attached}`);
    }

    const messageId = interaction.customId.slice(EDIT_ID.length);
    const message = await interaction.channel.messages.fetch(messageId).catch(() => null);
    if (!message) return interaction.editReply('❌ The message no longer exists.');
    const before = message.content;
    if (before === text) return interaction.editReply('Nothing changed.');

    // The images stay; only the text changes.
    await message.edit({ content: text, allowedMentions: { parse: [] } });
    await interaction.editReply('✅ Message edited.');
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
