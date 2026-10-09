/*
 * Steam display names from public profiles (steamcommunity.com XML page),
 * no API key needed. Cached in memory for a while, since leaderboards keep
 * showing the same people.
 */

const CACHE_MS = 6 * 60 * 60 * 1000;
const cache = new Map(); // steamId -> { name, at }

async function fetchPersonaName(steamId) {
    const hit = cache.get(steamId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.name;

    let name = null;
    try {
        const res = await fetch(`https://steamcommunity.com/profiles/${steamId}/?xml=1`);
        if (res.ok) {
            const m = (await res.text()).match(/<steamID><!\[CDATA\[(.*?)\]\]><\/steamID>/s);
            name = m ? m[1].trim() || null : null;
        }
    } catch {
        return null; // don't cache network errors
    }
    cache.set(steamId, { name, at: Date.now() });
    return name;
}

const profileUrl = steamId => `https://steamcommunity.com/profiles/${steamId}`;

module.exports = { fetchPersonaName, profileUrl };
