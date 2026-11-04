const { SlashCommandBuilder, AttachmentBuilder, MessageFlags } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

const MAX_BYTES = 25 * 1024 * 1024;
// The tyre rule (two compounds, one stop) only applies in these leagues.
const TYRE_RULE = /^(UL|CL)/i;

function allowed(interaction, config) {
    return Boolean(config.stewards_role && interaction.member?.roles.cache.has(config.stewards_role));
}

function analyse(html) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, '../services/replay/incidentsWorker.js'), { workerData: html });
        worker.once('message', resolve);
        worker.once('error', reject);
    });
}

function report(result, fileName) {
    const lines = [`Possible incidents: ${result.track}, ${result.laps} laps, ${result.minutes} min`,
        'Times are replay times. Flags to review, not decisions.', ''];
    if (!result.flags.length) lines.push('No incidents flagged.');
    for (const f of result.flags) {
        const lap = f.why.match(/^lap (\d+)/)?.[1];
        const lost = f.names.map(n => `${n} (${f.lost[n] == null ? '?' : `${f.lost[n] > 0 ? '+' : ''}${f.lost[n].toFixed(2)}s`})`).join(', ');
        lines.push(`${f.time.padStart(5)}  lap ${String(lap ?? '?').padEnd(3)} ${f.type}: ${lost}`);
    }
    if (TYRE_RULE.test(fileName)) {
        const broke = result.tyres.filter(t => t.finished && (new Set(t.sets.filter(Boolean)).size < 2 || !t.stops));
        lines.push('', 'Tyre rule:', ...(broke.length
            ? broke.map(t => `  ${t.name}: ${t.sets.join(' > ')} (${t.stops} stops)`)
            : ['  Every finisher used two compounds and stopped.']));
    }
    const net = result.net.filter(n => n.gaps || n.jumps);
    lines.push('', 'Connection (gaps in the data the bot received):', ...(net.length
        ? net.map(n => `  ${n.name}: ${n.gaps} gaps, longest ${n.longest}s, ${n.jumps} jumps`)
        : ['  Nothing to note.']));
    return lines.join('\n');
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('incidents')
        .setDescription('Stewards: list possible incidents from a race replay')
        .addAttachmentOption(opt => opt
            .setName('replay')
            .setDescription('The race replay (.html)')
            .setRequired(true)),

    async execute(interaction) {
        const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../config.json'), 'utf-8'));
        if (!allowed(interaction, config)) {
            return interaction.reply({ content: '❌ Only stewards can use this command.', flags: MessageFlags.Ephemeral });
        }
        const file = interaction.options.getAttachment('replay');
        if (!/\.html?$/i.test(file.name) || file.size > MAX_BYTES) {
            return interaction.reply({ content: '❌ Attach a race replay (.html, up to 25 MB).', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        let result;
        try {
            const res = await fetch(file.url);
            if (!res.ok) throw new Error('download failed');
            const done = await analyse(await res.text());
            if (done.error) return interaction.editReply(done.error);
            result = done.result;
        } catch (err) {
            console.error('❌ [Incidents]', err);
            return interaction.editReply('❌ Couldn\'t read that replay.');
        }

        const text = report(result, file.name);
        const name = `incidents_${file.name.replace(/\.html?$/i, '').replace(/[^\w-]+/g, '_')}.txt`;
        return interaction.editReply(text.length <= 1900
            ? `\`\`\`\n${text}\n\`\`\``
            : { content: `🔎 **${result.flags.length}** possible incidents in ${result.track}.`, files: [new AttachmentBuilder(Buffer.from(text, 'utf-8'), { name })] });
    }
};
