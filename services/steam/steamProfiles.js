/*
 * Steam display names. First through the bot's own Steam session (one
 * request for all the ids, no rate limit); if that fails, the public profile
 * page (steamcommunity.com XML), one id at a time, since that site answers
 * 429 to bursts. Names are cached for a while; failures aren't, so the next
 * /record tries again.
 */

const { withSteam } = require('./steamLeaderboards');

const CACHE_MS = 6 * 60 * 60 * 1000;
const cache = new Map(); // steamId -> { name, at }

const cached = id => {
    const hit = cache.get(id);
    return hit && Date.now() - hit.at < CACHE_MS ? hit.name : null;
};

async function fromSession(ids) {
    const res = await withSteam(user => Promise.race([
        user.getPersonas(ids),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Steam did not answer in time')), 10000))
    ]));
    const out = {};
    for (const [id, p] of Object.entries(res?.personas || {})) if (p?.player_name) out[id] = p.player_name;
    return out;
}

async function fromProfile(steamId) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const res = await fetch(`https://steamcommunity.com/profiles/${steamId}/?xml=1`);
            if (res.ok) {
                const m = (await res.text()).match(/<steamID><!\[CDATA\[(.*?)\]\]><\/steamID>/s);
                return m ? m[1].trim() || null : null;
            }
        } catch { /* network error: retry */ }
        await new Promise(r => setTimeout(r, 1500));
    }
    return null;
}

/** Names of several Steam ids, in the same order (null when unknown). */
async function fetchPersonaNames(steamIds) {
    const names = new Map(steamIds.map(id => [id, cached(id)]));
    let missing = steamIds.filter(id => !names.get(id));

    if (missing.length) {
        try {
            const got = await fromSession(missing);
            for (const [id, name] of Object.entries(got)) names.set(id, name);
        } catch (err) {
            console.warn('⚠️ [Profiles] Steam session names failed:', err.message);
        }
        missing = missing.filter(id => !names.get(id));
    }
    for (const id of missing) names.set(id, await fromProfile(id));

    for (const [id, name] of names) if (name) cache.set(id, { name, at: Date.now() });
    return steamIds.map(id => names.get(id) || null);
}

const fetchPersonaName = async steamId => (await fetchPersonaNames([steamId]))[0];

const profileUrl = steamId => `https://steamcommunity.com/profiles/${steamId}`;

module.exports = { fetchPersonaName, fetchPersonaNames, profileUrl };
