const fs = require('fs');
const path = require('path');
const { SlashCommandBuilder } = require('discord.js');
const R = require('../services/resultsWatcher');

// Only in the results channel (config "resultados.canal_id"), and only for
// members with one of config "resultados.roles_permitidos".
function resultsConfig() {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../config.json'), 'utf-8'));
    return config.resultados || {};
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('results')
        .setDescription('Capture results from an online lobby')
        .addSubcommand(sub => sub
            .setName('listen')
            .setDescription('Listen to a lobby and post its qualifying and race results')
            .addStringOption(opt => opt
                .setName('lobby')
                .setDescription('Online lobby')
                .setRequired(true)
                .setAutocomplete(true)))
        .addSubcommand(sub => sub
            .setName('stop')
            .setDescription('Stop listening to a lobby')
            .addStringOption(opt => opt
                .setName('lobby')
                .setDescription('Lobby being listened to')
                .setRequired(true)
                .setAutocomplete(true))),

    async autocomplete(interaction) {
        const query = interaction.options.getFocused().toLowerCase();
        const choice = (key, name) => ({ name: name.slice(0, 100), value: key });

        if (interaction.options.getSubcommand() === 'stop') {
            return interaction.respond([...R.watching.entries()]
                .filter(([, w]) => w.lobby.name.toLowerCase().includes(query))
                .slice(0, 25)
                .map(([key, w]) => choice(key, w.lobby.name)));
        }

        const lobbies = await R.listLobbies().catch(() => []);
        return interaction.respond(lobbies
            .filter(l => l.name.toLowerCase().includes(query))
            .slice(0, 25)
            .map(l => choice(R.lobbyKey(l), `${l.name} · ${l.players} players · ${l.state}${R.isWatching(R.lobbyKey(l)) ? ' · 👂' : ''}`)));
    },

    async execute(interaction) {
        const cfg = resultsConfig();
        if (interaction.channelId !== cfg.canal_id) {
            return interaction.reply({ content: `❌ This command can only be used in <#${cfg.canal_id}>.`, ephemeral: true });
        }
        if (!(cfg.roles_permitidos || []).some(id => interaction.member.roles.cache.has(id))) {
            return interaction.reply({ content: '❌ You are not allowed to use this command.', ephemeral: true });
        }

        const key = interaction.options.getString('lobby');

        if (interaction.options.getSubcommand() === 'stop') {
            const name = R.watching.get(key)?.lobby.name;
            if (!R.stopListening(key)) {
                return interaction.reply({ content: '⚠️ Not listening to that lobby.', ephemeral: true });
            }
            // Public, so everyone in the channel knows the capture ended.
            return interaction.reply(`🔕 ${interaction.user} stopped listening to **${name}**.`);
        }

        const lobby = R.seenLobby(key);
        if (!lobby) return interaction.reply({ content: '❌ Pick the lobby from the suggestions list.', ephemeral: true });
        if (R.isWatching(key)) return interaction.reply({ content: `👂 Already listening to **${lobby.name}**.`, ephemeral: true });

        try {
            R.listen(interaction.client, lobby);
        } catch (err) {
            return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
        }
        // Public, so everyone in the channel knows a capture is running.
        return interaction.reply(`👂 ${interaction.user} started listening to **${lobby.name}**. ` +
            'The qualifying and race CSVs will be posted here; use /results stop after race ends.');
    }
};
