const { ActivityType } = require('discord.js');

/*
 * Bot status: "Watching 33 players in UR2D2", with the number of people
 * playing Ultimate Racing 2D 2 right now according to Steam
 * (ISteamUserStats/GetNumberOfCurrentPlayers, no API key needed).
 */

const APP_ID = 1285230;
const UPDATE_EVERY_MS = 5 * 60 * 1000;

async function fetchPlayerCount() {
    const res = await fetch(`https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${APP_ID}`);
    if (!res.ok) throw new Error(`GetNumberOfCurrentPlayers returned ${res.status}`);
    const json = await res.json();
    if (json.response?.result !== 1) throw new Error('Steam returned no player count');
    return json.response.player_count;
}

async function updatePresence(client) {
    const players = await fetchPlayerCount();
    client.user.setActivity(`${players} player${players === 1 ? '' : 's'} in UR2D2`, { type: ActivityType.Watching });
}

function startPresenceLoop(client) {
    // On failure the previous status just stays until the next update.
    const tick = () => updatePresence(client).catch(err => console.error('❌ [Presence]', err.message));
    tick();
    setInterval(tick, UPDATE_EVERY_MS);
}

module.exports = { startPresenceLoop, fetchPlayerCount };
