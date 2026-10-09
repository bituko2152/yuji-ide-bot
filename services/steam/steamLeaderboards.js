const SteamUser = require('steam-user');
const Schema = require('steam-user/protobufs/generated/_load.js');

/*
 * Read-only access to Ultimate Racing 2D 2's Steam leaderboards.
 *
 * Steam only serves most of them to a logged-in Steam client, so the bot
 * keeps its own Steam session (STEAM_REFRESH_TOKEN in .env, created with
 * scripts/steamLogin.js). It never sets "playing" and never creates or
 * writes leaderboards (create_if_not_found is always false).
 *
 * steam-user has no leaderboard helpers, so the raw client messages are sent:
 *   ClientLBSFindOrCreateLB (5416) -> 5417   name  -> id + entry count
 *   ClientLBSGetLBEntries   (5418) -> 5419   id    -> ranked entries
 *
 * Leaderboard names are "<class>_<track>", e.g. "formulaa_australia".
 */

const APP_ID = 1285230;
const EMSG_FIND = 5416;
const EMSG_GET_ENTRIES = 5418;
const REQUEST_TIMEOUT_MS = 15 * 1000;
const DATA_REQUEST_GLOBAL = 0;

let user = null;
let ready = null; // resolves once logged on

function connect() {
    if (ready) return ready;

    const refreshToken = process.env.STEAM_REFRESH_TOKEN;
    if (!refreshToken) return Promise.reject(new Error('STEAM_REFRESH_TOKEN is not set in .env'));

    user = new SteamUser({ autoRelogin: true });
    ready = new Promise((resolve, reject) => {
        user.once('loggedOn', () => {
            console.log('🎮 [Leaderboards] Steam session ready.');
            resolve();
        });
        user.once('error', err => {
            ready = null; // allow a later retry
            reject(new Error(`Steam login failed: ${err.message}`));
        });
    });
    user.on('error', err => console.error('❌ [Leaderboards] Steam:', err.message));

    user.logOn({ refreshToken });
    return ready;
}

function request(emsg, Proto, body, ResponseProto) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Steam did not answer in time')), REQUEST_TIMEOUT_MS);
        const payload = Buffer.from(Proto.encode(body).finish());
        // routing_appid tells Steam which game the request is for; without it
        // Steam answers InvalidParam. No need to set "playing" (which would
        // kick the account's own game session).
        user._send({ msg: emsg, proto: { routing_appid: APP_ID } }, payload, response => {
            clearTimeout(timer);
            const buf = Buffer.isBuffer(response) ? response : response.toBuffer();
            resolve(ResponseProto.decode(buf));
        });
    });
}

/** @returns {Promise<{id:number, entries:number}|null>} null if it doesn't exist */
async function findLeaderboard(name) {
    await connect();
    const res = await request(EMSG_FIND, Schema.CMsgClientLBSFindOrCreateLB, {
        app_id: APP_ID,
        leaderboard_name: name,
        create_if_not_found: false
    }, Schema.CMsgClientLBSFindOrCreateLBResponse);

    if (res.eresult !== 1 || !res.leaderboard_id) return null;
    return { id: res.leaderboard_id, entries: res.leaderboard_entry_count };
}

/** Ranked entries [start..end] (1-based, inclusive) of a leaderboard. */
async function getEntries(leaderboardId, start = 1, end = 10) {
    await connect();
    const res = await request(EMSG_GET_ENTRIES, Schema.CMsgClientLBSGetLBEntries, {
        app_id: APP_ID,
        leaderboard_id: leaderboardId,
        range_start: start,
        range_end: end,
        leaderboard_data_request: DATA_REQUEST_GLOBAL
    }, Schema.CMsgClientLBSGetLBEntriesResponse);

    if (res.eresult !== 1) throw new Error(`Steam returned eresult ${res.eresult}`);
    return (res.entries || []).map(e => ({
        steamId: e.steam_id_user.toString(),
        rank: e.global_rank,
        score: e.score
    }));
}

module.exports = { connect, findLeaderboard, getEntries };
