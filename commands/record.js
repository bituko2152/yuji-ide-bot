const { SlashCommandBuilder, EmbedBuilder, escapeMarkdown } = require('discord.js');
const lb = require('../services/steam/steamLeaderboards');
const catalog = require('../services/steam/leaderboardCatalog');
const { fetchPersonaNames, profileUrl } = require('../services/steam/steamProfiles');

const TOP = 10;
const MEDALS = ['🥇', '🥈', '🥉'];

// Scores are lap times in milliseconds, shown rounded to hundredths like the
// game does (33166 -> 33.17, 75250 -> 1:15.25).
function formatTime(ms) {
    const cs = Math.round(ms / 10);
    const minutes = Math.floor(cs / 6000);
    const seconds = ((cs % 6000) / 100).toFixed(2);
    return minutes ? `${minutes}:${seconds.padStart(5, '0')}` : seconds;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('record')
        .setDescription('Top 10 lap times of a track from the Ultimate Racing 2D 2 Steam leaderboards')
        .addStringOption(opt => opt
            .setName('track')
            .setDescription('Track')
            .setRequired(true)
            .setAutocomplete(true))
        .addStringOption(opt => opt
            .setName('class')
            .setDescription('Car class')
            .setRequired(true)
            .setAutocomplete(true)),

    async autocomplete(interaction) {
        const focused = interaction.options.getFocused(true);
        const map = focused.name === 'class' ? await catalog.getClasses() : await catalog.getTracks();
        return interaction.respond(catalog.search(map, focused.value));
    },

    async execute(interaction) {
        const trackKey = interaction.options.getString('track');
        const classKey = interaction.options.getString('class');

        // Only usable in the channels set in config.json records.canales (if any).
        const allowed = catalog.recordsChannels();
        if (allowed.length && !allowed.includes(interaction.channelId)) {
            const list = allowed.map(id => `<#${id}>`).join(', ');
            return interaction.reply({ content: `❌ This command can only be used in ${list}.`, ephemeral: true });
        }

        await interaction.deferReply();
        const [tracks, classes] = await Promise.all([catalog.getTracks(), catalog.getClasses()]);

        // Only values picked from the autocomplete list are accepted.
        if (!tracks[trackKey] || !classes[classKey]) {
            return interaction.editReply('❌ Pick the track and class from the suggestions list.');
        }

        const track = tracks[trackKey];
        const carClass = classes[classKey];

        const name = catalog.leaderboardName(classKey, trackKey);

        let board, entries;
        try {
            board = await lb.findLeaderboard(name);
            if (board?.entries) entries = await lb.getEntries(board.id, 1, TOP);
        } catch (err) {
            console.error('❌ [Record]', err.message);
            return interaction.editReply('⚠️ Steam leaderboards are not available right now, try again later.');
        }
        if (!board || !entries?.length) {
            return interaction.editReply(`ℹ️ There are no lap times yet for **${carClass}** at **${track}**.`);
        }

        const names = await fetchPersonaNames(entries.map(e => e.steamId));

        const lines = entries.map((e, i) => {
            const pos = MEDALS[e.rank - 1] || `\`${String(e.rank).padStart(2)}.\``;
            const name = names[i] ? escapeMarkdown(names[i]).replace(/[[\]]/g, '\\$&') : 'Unknown driver';
            return `${pos} \`${formatTime(e.score)}\` — [${name}](${profileUrl(e.steamId)})`;
        });

        const embed = new EmbedBuilder()
            .setColor('#f1c40f')
            .setTitle(`⏱️ ${track} — ${carClass}`)
            .setDescription(lines.join('\n'))
            .setFooter({ text: `Top ${entries.length} of ${board.entries} times · Steam leaderboards` })
            .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
    }
};
