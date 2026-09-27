require('dotenv').config();

const {
    Client,
    GatewayIntentBits,
    Collection,
    REST,
    Routes
    // EmbedBuilder // only needed by lobbyService, currently disabled below
} = require('discord.js');

const fs = require('fs');
const path = require('path');

const express = require('express');
const app = express();

app.get('/', (req, res) => {
    res.send('Yuji Ide is awake! 🏎️');
});

app.listen(3000, () => {
    console.log('Keep-alive server ready.');
});

const {
    handleButtonInteraction
} = require('./services/buttonHandler');

// Steam lobby listing is disabled: it requires the real Steam desktop
// client running (via steamworks.js), which isn't possible on Wispbyte's
// container hosting. Re-enable if/when that service is hosted elsewhere.
// const {
//     startLobbyLoop
// } = require('./services/lobbyService');

const {
    startContractLoop
} = require('./services/contractService');

const {
    startCleanupLoop
} = require('./services/cleanupService');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Collection to store commands in the bot
client.commands = new Collection();
const commandsArray = [];

// Read all files from the "commands" folder
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs
    .readdirSync(commandsPath)
    .filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);

    if ('data' in command && 'execute' in command) {
        client.commands.set(
            command.data.name,
            command
        );

        commandsArray.push(
            command.data.toJSON()
        );
    } else {
        console.log(
            `[⚠️ WARNING] The command at ${filePath} is missing "data" or "execute" properties.`
        );
    }
}

// Event when the bot connects successfully
client.once('ready', async () => {
    console.log(
        `🤖 Bot connected as ${client.user.tag}`
    );

    console.log(
        '🔄 Registering slash commands...'
    );

    const rest = new REST({
        version: '10'
    }).setToken(
        process.env.DISCORD_TOKEN
    );

    try {
        // Registers commands directly to your test server (Guild)
        await rest.put(
            Routes.applicationGuildCommands(
                process.env.CLIENT_ID,
                process.env.GUILD_ID
            ),
            {
                body: commandsArray
            }
        );

        console.log(
            '✅ All slash commands have been registered successfully.'
        );
    } catch (error) {
        console.error(error);
    }

    // Steam lobby listing disabled — see note near the top of this file.
    // startLobbyLoop(client, EmbedBuilder);

    // Periodic check for accepted contracts pending role grant.
    startContractLoop(client);

    // Daily cleanup: removes polls/contracts older than 15 days from disk.
    startCleanupLoop();
});

// Handle commands and buttons
client.on('interactionCreate', async interaction => {

    /*
     * Handle buttons
     */
    if (interaction.isButton()) {
        try {
            const handled = await handleButtonInteraction(
                interaction
            );

            if (handled) {
                return;
            }
        } catch (error) {
            console.error(
                '❌ Error handling button interaction:',
                error
            );

            if (
                !interaction.replied &&
                !interaction.deferred
            ) {
                await interaction.reply({
                    content:
                        '❌ There was an error processing this button.',
                    ephemeral: true
                }).catch(() => { });
            }
        }

        return;
    }

    /*
     * Handle slash commands
     */
    if (!interaction.isChatInputCommand()) {
        return;
    }

    const command = client.commands.get(
        interaction.commandName
    );

    if (!command) {
        return;
    }

    try {
        await command.execute(interaction);
    } catch (error) {
        console.error(error);

        if (
            interaction.replied ||
            interaction.deferred
        ) {
            await interaction.followUp({
                content:
                    '❌ There was an error executing this command.',
                ephemeral: true
            }).catch(() => { });
        } else {
            await interaction.reply({
                content:
                    '❌ There was an error executing this command.',
                ephemeral: true
            }).catch(() => { });
        }
    }
});

// Login using the existing environment variable
client.login(process.env.DISCORD_TOKEN);