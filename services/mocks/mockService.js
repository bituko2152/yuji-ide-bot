const fs = require('fs');
const path = require('path');
const { EmbedBuilder } = require('discord.js');
const { createLobbyHost } = require('./lobbyHost');
const { roundThisWeek } = require('./leagueSchedule');

/*
 * Daily practice races ("Mocks"), hosted by Yuji himself as a spectator.
 * notice_minutes before the start he creates the lobby (PC only) and
 * announces it; at the start time he runs qualifying + race, as many times as
 * the day has races, and closes the lobby. Results: /results listen as usual.
 *
 * config.json:
 *   "mocks": {
 *     "channel": "<channel id>", "role": "<role pinged>",
 *     "time": "19:00", "notice_minutes": 10,          (UTC)
 *     "lobby_name": "Yuji Mocks", "car_class": "3805310984",
 *     "schedule_channels": { "UL": "<channel>", ... },
 *     "days": { "monday": { "format": "UL length", "league": "UL", "races": 2 },
 *               "tuesday": { "format": "Sprint", "league": "UL", "laps": 8, "races": 4 }, ... }   (no entry: no mock)
 *   }
 * Track and laps come from the league's calendar (its schedule channel): the
 * round raced this Sunday, with its rain chance (calendar emoji) for the
 * races; "rain": false keeps a day dry (AL, sprints), or every day if set in "mocks". A day can override "laps" (sprints) and
 * "car_class" (Workshop id; "car_class_name" = name shown in the lobby list)
 * and "quali_laps" (default 3, also settable for every day in "mocks").
 * data/mocks.json: { date } of the last mock run (so a restart doesn't run it twice).
 */

const storeFile = path.join(__dirname, '../../data/mocks.json');
const configPath = path.join(__dirname, '../../config.json');
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WAIT_FOR_DRIVERS_MS = 10 * 60 * 1000; // nobody in the lobby at the start: wait this long
const AFTER_QUALI_MS = 30 * 1000;           // qualifying -> first race
const BETWEEN_RACES_MS = 3 * 60 * 1000;     // break in the lobby between races
const CLOSE_AFTER_MS = 2 * 60 * 1000;

const loadConfig = () => JSON.parse(fs.readFileSync(configPath, 'utf-8')).mocks;
const readStore = () => { try { return JSON.parse(fs.readFileSync(storeFile, 'utf-8')); } catch { return {}; } };
const writeStore = data => { fs.mkdirSync(path.dirname(storeFile), { recursive: true }); fs.writeFileSync(storeFile, JSON.stringify(data, null, 2)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

let active = null; // the lobby host while a mock is running

function startOf(now, time) {
    const [h, m] = String(time || '19:00').split(':').map(Number);
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m || 0)).getTime();
}

function embed(cfg, day, startAt, status, color = '#3498db') {
    const t = Math.floor(startAt / 1000);
    return new EmbedBuilder()
        .setColor(color)
        .setTitle(`🏎️ Mock today · ${day.format}`)
        .setDescription(
            `Lobby **${cfg.lobby_name || 'Yuji Mocks'}** (PC only), hosted by Yuji. Track: **${day.trackName}**.\n` +
            `Starts at <t:${t}:t> (<t:${t}:R>): **${day.races}** × qualifying + race of **${day.laps}** laps` +
            (day.rain ? ` (rain ${day.rain}%).\n\n` : ' (dry).\n\n') +
            status);
}

async function runMock(client, cfg, day, startAt) {
    const channel = await client.channels.fetch(cfg.channel).catch(() => null);
    if (!channel) return console.error('❌ [Mocks] Channel not found.');

    // This week's league round: track, and laps unless the day sets them (sprints).
    const round = await roundThisWeek(client, cfg.schedule_channels?.[day.league]);
    if (!round) return console.log(`🏎️ [Mocks] No ${day.league} round this week (break?): no mock today.`);
    // Races take the week's rain chance unless the day is dry ("rain": false: AL, sprints).
    day = { ...day, laps: day.laps || round.laps, track: round.track, trackName: round.name || round.track,
        rain: day.rain === false || cfg.rain === false ? 0 : round.rain };
    const host = createLobbyHost({ name: cfg.lobby_name || 'Yuji Mocks', carClass: day.car_class || cfg.car_class || 'formulaa', className: day.car_class_name || cfg.car_class_name, track: day.track, laps: day.laps, qualiLaps: day.quali_laps || cfg.quali_laps || 3 });
    active = host;
    try {
        await host.ready;
    } catch (err) {
        console.error('❌ [Mocks]', err.message);
        active = null;
        host.close();
        return;
    }
    console.log(`🏎️ [Mocks] Lobby open (${day.format}, ${day.races}×${day.laps} laps).`);
    const message = await channel.send({
        content: cfg.role ? `<@&${cfg.role}>` : undefined,
        embeds: [embed(cfg, day, startAt, '🟢 The lobby is open: join from the game.')],
        allowedMentions: { roles: cfg.role ? [cfg.role] : [] }
    }).catch(err => console.error('❌ [Mocks]', err.message));
    const status = (text, color) => message?.edit({ embeds: [embed(cfg, day, startAt, text, color)] }).catch(() => {});

    try {
        await sleep(Math.max(0, startAt - Date.now()));
        // Nobody racing yet: wait a bit for people to arrive.
        const deadline = Date.now() + WAIT_FOR_DRIVERS_MS;
        while (!host.racers().length && Date.now() < deadline) await sleep(15000);
        if (!host.racers().length) {
            await status('❌ Nobody joined, no mock today.', '#2b2d31');
            return;
        }

        // Every race has its own qualifying: quali, 30 s, race; 3 minutes before the next one.
        for (let i = 1; i <= day.races; i++) {
            if (i > 1) {
                host.say(`Next: qualifying for race ${i} of ${day.races} in 3 minutes.`);
                await sleep(BETWEEN_RACES_MS);
            }
            if (!host.racers().length) break;
            await status(`🏁 Qualifying for race ${i} of ${day.races} in progress.`);
            host.say(`Qualifying for race ${i} of ${day.races} starts now. Good luck!`);
            await host.qualifying();

            host.say(`Race ${i} of ${day.races} (${day.laps} laps) starts in 30 seconds.`);
            await sleep(AFTER_QUALI_MS);
            if (!host.racers().length) break;
            await status(`🏁 Race ${i} of ${day.races} in progress.`);
            await host.race(day.laps, day.rain);
        }

        host.say('That was the last race. Thanks for racing, see you tomorrow!');
        await status('✅ Finished. Thanks for racing!', '#2b2d31');
        await sleep(CLOSE_AFTER_MS);
    } catch (err) {
        console.error('❌ [Mocks]', err);
        await status(`⚠️ Something went wrong: ${err.message}`, '#e74c3c');
    } finally {
        host.close();
        active = null;
        console.log('🏎️ [Mocks] Lobby closed.');
    }
}

async function tick(client) {
    const cfg = loadConfig();
    if (!cfg?.channel || active) return;
    const now = new Date();
    const day = cfg.days?.[DAYS[now.getUTCDay()]];
    if (!day?.league) return; // no league for that day: no mock
    const startAt = startOf(now, cfg.time);
    const openAt = startAt - (cfg.notice_minutes ?? 10) * 60 * 1000;
    const date = now.toISOString().slice(0, 10);
    if (Date.now() < openAt || Date.now() >= startAt || readStore().date === date) return;
    writeStore({ date });
    runMock(client, cfg, day, startAt).catch(err => console.error('❌ [Mocks]', err));
}

function startMockLoop(client) {
    const run = () => tick(client).catch(err => console.error('❌ [Mocks]', err.message));
    run();
    setInterval(run, 30 * 1000);
}

/** On shutdown: close the lobby so it doesn't stay listed. */
function stopMocks() {
    active?.close();
}

module.exports = { startMockLoop, stopMocks };
