require('dotenv').config();

const {
    Client,
    GatewayIntentBits,
    Collection,
    REST,
    Routes
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

const {
    startLobbyLoop
} = require('./services/lobbyService');

const {
    startWorkshopLoop
} = require('./services/workshopService');

const {
    startNewsLoop
} = require('./services/newsService');

const {
    startContractLoop
} = require('./services/contractService');

const {
    startCleanupLoop
} = require('./services/cleanupService');

const {
    startStarterLoop
} = require('./services/starterService');

const {
    startResultsLoop
} = require('./services/resultsWatcher');

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
client.once('clientReady', async () => {
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

    // Live list of online lobbies (queries the game's master servers directly).
    startLobbyLoop(client);

    // Announces new Steam Workshop tracks (tracks only, no car classes).
    startWorkshopLoop(client);

    // Announces the developer's Steam news posts (patches, updates).
    startNewsLoop(client);

    // Periodic check for accepted contracts pending role grant.
    startContractLoop(client);

    // Daily cleanup: removes polls/contracts older than 15 days from disk.
    startCleanupLoop();

    // Weekly starters (open/close rounds) + auto-advance of the /report round.
    startStarterLoop(client);

    // Stops /results listeners once their lobby closes.
    startResultsLoop(client);
});

// Handle commands and buttons
client.on('interactionCreate', async interaction => {

    /*
     * Handle autocomplete (e.g. the team list of /attend)
     */
    if (interaction.isAutocomplete()) {
        const command = client.commands.get(
            interaction.commandName
        );

        if (command && command.autocomplete) {
            try {
                await command.autocomplete(interaction);
            } catch (error) {
                console.error(
                    '❌ Error handling autocomplete:',
                    error
                );
            }
        }

        return;
    }

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
