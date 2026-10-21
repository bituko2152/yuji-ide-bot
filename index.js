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

// Server-specific settings (channel / role ids) are not in the repo.
if (!fs.existsSync(path.join(__dirname, 'config.json'))) {
    console.error('❌ config.json not found: copy config.example.json to config.json and fill in your server\'s ids.');
    process.exit(1);
}
try {
    JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));
} catch (err) {
    console.error(`❌ config.json is not valid JSON (${err.message}): fix it, or restore it from .config.backup.json.`);
    process.exit(1);
}

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
} = require('./services/core/buttonHandler');

const {
    startLobbyLoop
} = require('./services/steam/lobbyService');

const {
    startNewsLoop
} = require('./services/steam/newsService');

const {
    startPresenceLoop
} = require('./services/core/presenceService');

const {
    startContractLoop
} = require('./services/contracts/contractService');

const {
    startCleanupLoop
} = require('./services/core/cleanupService');

const {
    startStarterLoop
} = require('./services/starters/starterService');

const {
    startMockLoop,
    stopMocks
} = require('./services/mocks/mockService');

const {
    startRaceCheckLoop
} = require('./services/racecheck/raceCheckService');

const {
    startResultsLoop,
    stopAll: stopListeningAll
} = require('./services/results/resultsWatcher');

const {
    handleReportComponent,
    isReportComponent,
    migrateOldPolls,
    recoverLostPolls
} = require('./services/reports/reportService');

const {
    handleUploadComponent,
    isUploadComponent
} = require('./services/results/resultsUpload');

const {
    handleModal: handleMessageModal,
    isMessageComponent
} = require('./services/messages/messageService');

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

    // Other servers (e.g. the mobile one) only get the commands listed for
    // them in config.json "extra_servers": [{ "id", "commands": [...] }].
    const extraServers = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8')).extra_servers || [];
    for (const server of extraServers) {
        if (!server.id) continue;
        const body = commandsArray.filter(c => (server.commands || []).includes(c.name));
        try {
            await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, server.id), { body });
            console.log(`✅ ${body.length} slash command(s) registered in server ${server.id}.`);
        } catch (error) {
            console.error(`❌ Could not register commands in server ${server.id}:`, error.message);
        }
    }

    // Live list of online lobbies (queries the game's master servers directly).
    startLobbyLoop(client);

    // Announces the developer's Steam news posts (patches, updates).
    startNewsLoop(client);

    // Bot status: how many people are playing UR2D2 right now (Steam).
    startPresenceLoop(client);

    // Periodic check for accepted contracts pending role grant.
    startContractLoop(client);

    // Daily cleanup: removes polls/contracts older than 15 days from disk.
    startCleanupLoop();

    // Weekly starters (open/close rounds) + auto-advance of the /report round.
    startStarterLoop(client);

    // Daily practice races (Mocks), hosted by Yuji himself.
    startMockLoop(client);

    // Weekly anonymous race checks (e.g. OMRL on the mobile server).
    startRaceCheckLoop(client);

    // Stops /results listeners once their lobby closes.
    startResultsLoop(client);

    // Reports of the current rounds still on the old poll -> S26 penalty system.
    migrateOldPolls(client).catch(err => console.error('❌ [Reports] Poll migration failed:', err.message));

    // Report messages whose poll was lost from data/polls.json get it back.
    recoverLostPolls(client).catch(err => console.error('❌ [Reports] Poll recovery failed:', err.message));
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
     * Handle report dropdowns and forms (votes, "Submit result")
     */
    if ((interaction.isStringSelectMenu() || interaction.isModalSubmit()) && isReportComponent(interaction.customId)) {
        await handleReportComponent(interaction).catch(error => {
            console.error('❌ Error handling report interaction:', error);
        });

        return;
    }

    /*
     * Handle /results upload preview dropdowns (who is each unknown driver)
     */
    if ((interaction.isStringSelectMenu() || interaction.isModalSubmit()) && isUploadComponent(interaction.customId)) {
        await handleUploadComponent(interaction).catch(error => {
            console.error('❌ Error handling results upload interaction:', error);
        });

        return;
    }

    /*
     * Handle the /message form (new message / edit)
     */
    if (interaction.isModalSubmit() && isMessageComponent(interaction.customId)) {
        await handleMessageModal(interaction).catch(error => {
            console.error('❌ Error handling message form:', error);
        });

        return;
    }

    /*
     * Handle slash commands and message context menus (e.g. "Edit message")
     */
    if (!interaction.isChatInputCommand() && !interaction.isMessageContextMenuCommand()) {
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

// On stop/restart, leave the lobbies being listened to (otherwise the lobby keeps
// a ghost connection that counts as a player until it times out).
for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
        stopListeningAll();
        stopMocks();
        setTimeout(() => process.exit(0), 700);
    });
}

// An error nobody caught (a timer, a lobby message, a Discord event) is logged
// instead of taking the whole bot down with it.
process.on('unhandledRejection', err => console.error('❌ Unhandled rejection:', err));
client.on('error', err => console.error('❌ Discord client error:', err));

// Login using the existing environment variable
client.login(process.env.DISCORD_TOKEN);
