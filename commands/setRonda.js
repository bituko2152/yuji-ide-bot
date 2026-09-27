const { SlashCommandBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');

const SETROUND_ROLE_ID = '000000000000000000';

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setround')
        .setDescription('Configure the reporting status for a category')
        .addStringOption(opt => opt
            .setName('category')
            .setDescription('Category')
            .setRequired(true)
            .addChoices(
                { name: 'UL', value: 'UL' },
                { name: 'CL', value: 'CL' },
                { name: 'JL', value: 'JL' },
                { name: 'AL', value: 'AL' }
            )
        )
        .addStringOption(opt => opt
            .setName('round')
            .setDescription('Round name (e.g., CLS21R10)')
            .setRequired(true)
        )
        .addBooleanOption(opt => opt
            .setName('status')
            .setDescription('Allow reports?')
            .setRequired(true)
        ),

    async execute(interaction) {

        // Comprobar si el usuario tiene el rol autorizado
        if (!interaction.member.roles.cache.has(SETROUND_ROLE_ID)) {
            return interaction.reply({
                content: '❌ You do not have permission to use this command.',
                ephemeral: true
            });
        }

        const cat = interaction.options.getString('category');
        const round = interaction.options.getString('round');
        const status = interaction.options.getBoolean('status');

        const configPath = path.join(__dirname, '../config.json');
        let config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

        config.config_categorias[cat] = {
            activo: status,
            round: round
        };

        fs.writeFileSync(
            configPath,
            JSON.stringify(config, null, 2)
        );

        return interaction.reply({
            content: `Configuration updated: **${cat}** changed to **${round}** (Open status: \`${status}\`)`,
            ephemeral: true
        });
    }
};