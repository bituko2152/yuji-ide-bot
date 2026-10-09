const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const { EmbedBuilder, MessageFlags, escapeMarkdown } = require('discord.js');

/*
 * Live list of Ultimate Racing 2D 2 online lobbies, the same message in every
 * channel of config "canales_lobbies" (can be in different servers),
 * refreshed every few minutes: edited in place while it's the last message,
 * re-posted (silently, old copy deleted) once someone writes below it.
 *
 * The game has its own master servers (one per region) that answer a tiny
 * plain-text UDP protocol on port 6510:
 *   -> "90\n1\n8\n\0"                           request the server list
 *   <- "*<payload>~|1|<msgId>|"                  one packet per lobby (or "*0|0|...~" if none)
 *   <- "ack|2|8|"                                server acks our request
 *   -> "ack\n2\n<msgId>\n\0"                     we ack each lobby packet, like the game does
 *
 * Lobby payload (fields split by "|", some sub-split by "#"):
 *   00server#<name> | <port> | <championship>#<game>#<crossplay on/off>#<pc/mobile: the
 *   platform it's limited to when crossplay is off> | <maxPlayers> | <updatedAt> | <lap, while racing> |
 *   <laps> | <state> | <players> | <players?> | <password, plain text: never shown> |
 *   <version> | <region> | <createdAt>
 * Only the fields we understand are used.
 */

const MASTER_SERVERS = ['64.226.118.45', '138.197.70.132', '159.223.89.233'];
const PORT = 6510;
const LIST_REQUEST = Buffer.from('90\n1\n8\n\0', 'latin1');
const RESPONSE_WAIT_MS = 2500;
const UPDATE_EVERY_MS = 3 * 60 * 1000; // free hosting caps CPU: don't poll every minute

const storeFile = path.join(__dirname, '../../data/lobbyMessage.json');

function loadConfig() {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '../../config.json'), 'utf-8'));
}

// data/lobbyMessage.json: { "<channelId>": "<messageId>" }
// (old single-channel format { messageId } belonged to the first channel)
function readMessageIds(channelIds) {
    try {
        const data = JSON.parse(fs.readFileSync(storeFile, 'utf-8'));
        if ('messageId' in data) return data.messageId ? { [channelIds[0]]: data.messageId } : {};
        return data;
    } catch {
        return {};
    }
}

function writeMessageIds(ids) {
    fs.writeFileSync(storeFile, JSON.stringify(ids));
}

// canales_lobbies: list of channel ids, in any server the bot is in.
function lobbyChannelIds(config) {
    return (config.canales_lobbies || []).filter(id => id && id !== '???');
}

// ---------------------------------------------------------------- protocol

function parseLobby(payload) {
    const f = payload.split('|');
    if (!f[0].startsWith('00server#')) return null;
    const [championship, , crossplay, platform] = (f[2] || '').split('#');
    return {
        name: f[0].slice('00server#'.length),
        port: f[1],
        championship: championship || '?',
        crossplay: crossplay === 'on',
        // Only meaningful without cross-play: which platform the lobby is limited to.
        platform: platform === 'mobile' ? 'mobile' : 'pc',
        maxPlayers: Number(f[3]) || null,
        lap: Number(f[5]) || 0,
        laps: Number(f[6]) || 0,
        state: f[7] || '?',
        // Only whether there is one: the password itself is never kept.
        private: Boolean(f[10]),
        players: Number(f[8]) || 0,
        region: f[12] || '?'
    };
}

// Asks one master server for its lobbies. Never rejects: an unreachable
// server just yields [] (and `ok: false`).
function queryServer(host) {
    return new Promise(resolve => {
        const socket = dgram.createSocket('udp4');
        const lobbies = new Map();
        let ok = false;

        const finish = () => {
            try { socket.close(); } catch { /* already closed */ }
            resolve({ host, ok, lobbies: [...lobbies.values()] });
        };

        socket.on('error', finish);
        socket.on('message', msg => {
            ok = true;
            const text = msg.toString('utf-8');
            const m = text.match(/^\*(.*)~\|1\|(\d+)\|$/s);
            if (!m) return; // "ack|2|8|" and anything unknown

            socket.send(Buffer.from(`ack\n2\n${m[2]}\n\0`, 'latin1'), PORT, host);
            const lobby = parseLobby(m[1]);
            if (lobby) {
                lobby.host = host; // master server that relays this lobby's traffic
                lobbies.set(`${lobby.name}|${lobby.port}`, lobby); // resends are duplicates
            }
        });

        socket.send(LIST_REQUEST, PORT, host);
        setTimeout(finish, RESPONSE_WAIT_MS);
    });
}

async function fetchLobbies() {
    const results = await Promise.all(MASTER_SERVERS.map(queryServer));
    return {
        lobbies: results.flatMap(r => r.lobbies),
        offline: results.filter(r => !r.ok).length
    };
}

// ---------------------------------------------------------------- message

function buildEmbed({ lobbies, offline }) {
    lobbies.sort((a, b) => b.players - a.players);

    // Same info as the in-game list: status with laps, cross-play, public/private.
    const status = l => (l.state === 'Racing' && l.laps ? `Racing ${l.lap}/${l.laps} laps` : l.state);
    const access = l => (l.crossplay ? 'Cross-play' : l.platform === 'mobile' ? 'Mobile only' : 'PC only');
    const lines = lobbies.map(l =>
        `**${escapeMarkdown(l.name)}**${l.private ? ' 🔒' : ''}\n` +
        `👥 ${l.players}/${l.maxPlayers ?? '?'} · ${status(l)} · ${escapeMarkdown(l.championship)} · ` +
        `🌍 ${l.region} ${access(l)} · ${l.private ? 'Private' : 'Public'}`
    );

    let description = lines.length ? lines.join('\n\n') : '*No online lobbies right now.*';
    if (description.length > 4000) description = description.slice(0, 3990) + '\n…';

    const players = lobbies.reduce((sum, l) => sum + l.players, 0);
    const footer = `${lobbies.length} lobbies · ${players} players · updates every ${UPDATE_EVERY_MS / 60000} min` +
        (offline ? ` · ⚠️ ${offline} server(s) not responding` : '');

    return new EmbedBuilder()
        .setColor('#2ecc71')
        .setTitle('🌐 Ultimate Racing 2D 2 — Online lobbies')
        .setDescription(description)
        .setFooter({ text: footer })
        .setTimestamp();
}

// Returns the message id now showing the list in that channel.
async function updateChannel(client, channelId, previousId, embed) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) {
        console.warn(`⚠️ [Lobbies] Could not fetch channel ${channelId} (is the bot in that server?).`);
        return previousId;
    }

    // Still the last message in the channel -> just edit it (edits don't mark
    // the channel unread). Otherwise re-post it at the bottom, silently, and
    // delete the old copy so only one exists.
    if (previousId && channel.lastMessageId === previousId) {
        const edited = await channel.messages.edit(previousId, { embeds: [embed] }).catch(() => null);
        if (edited) return previousId;
    }

    const sent = await channel.send({ embeds: [embed], flags: MessageFlags.SuppressNotifications });
    if (previousId) await channel.messages.delete(previousId).catch(() => { });
    return sent.id;
}

async function updateLobbyMessages(client) {
    const channelIds = lobbyChannelIds(loadConfig());
    if (!channelIds.length) return;

    // Query the game once, post the same list everywhere.
    const embed = buildEmbed(await fetchLobbies());
    const ids = readMessageIds(channelIds);

    for (const channelId of channelIds) {
        // One channel failing (permissions, outage...) doesn't block the others.
        ids[channelId] = await updateChannel(client, channelId, ids[channelId], embed)
            .catch(err => { console.error(`❌ [Lobbies] ${channelId}:`, err.message); return ids[channelId]; });
    }
    writeMessageIds(ids);
}

function startLobbyLoop(client) {
    const tick = () => updateLobbyMessages(client).catch(err => console.error('❌ [Lobbies]', err));
    tick();
    setInterval(tick, UPDATE_EVERY_MS);
    console.log('🌐 [Lobbies] Online lobby list started.');
}

module.exports = { startLobbyLoop, fetchLobbies };
