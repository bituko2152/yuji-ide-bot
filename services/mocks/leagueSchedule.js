/*
 * Reads a league's calendar from its schedule channel (the newest message
 * with rounds), e.g.
 *   > 3. 🇳🇱 ⛈️ [Assen](https://steamcommunity.com/sharedfiles/filedetails/?id=3663935043) (ManBearGoat) - Dutch Grand Prix: 18th of October (52 Laps)
 *   > 5. 🇧🇪 🌧️ [Belgium](https://www.youtube.com/...) (Base Game "Belgium") - Belgian Grand Prix: 1st of November (64 Laps)
 * and returns the round raced on a given Sunday: track (Workshop id, or the
 * base-game track key) and laps.
 */

// Weather emoji in the calendar -> rain chance (%).
const RAIN = [['⛈', 50], ['🌧', 25], ['🌦', 10], ['☀', 0]];

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function parseRounds(text, year) {
    const rounds = [];
    for (const line of text.split('\n')) {
        const laps = line.match(/\(([\d\s&,]+)\s*Laps?\)/i);
        const date = line.match(/(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([A-Za-z]+)/);
        if (!laps || !date) continue;
        const month = MONTHS.findIndex(m => m.startsWith(date[2].toLowerCase().slice(0, 3)));
        if (month < 0) continue;
        const name = line.match(/\[([^\]]+)\]/)?.[1]?.trim() || null;
        const workshop = line.match(/filedetails\/\?id=(\d+)/)?.[1] || null;
        const base = line.match(/Base Game "([^"]+)"/i)?.[1] || null;
        const track = workshop || (base ? base.toLowerCase().replace(/\s+/g, '_') : null);
        if (!track) continue;
        // "(10 & 26 Laps)" = sprint & feature: the longer one.
        const lapCount = Math.max(...laps[1].split(/[&,\s]+/).filter(Boolean).map(Number));
        const rain = RAIN.find(([e]) => line.includes(e))?.[1] ?? 0;
        rounds.push({ name, track, laps: lapCount, rain, date: new Date(Date.UTC(year, month, Number(date[1]))) });
    }
    // A calendar crossing new year (December -> January): later months belong to the next year.
    for (let i = 1; i < rounds.length; i++) {
        if (rounds[i].date < rounds[i - 1].date) rounds[i].date.setUTCFullYear(rounds[i].date.getUTCFullYear() + 1);
    }
    return rounds;
}

// The Sunday that ends the week (Monday-Sunday) of a date.
function sundayOf(d) {
    const s = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    s.setUTCDate(s.getUTCDate() + (7 - s.getUTCDay()) % 7);
    return s;
}

/**
 * The league round raced this week (on the Sunday of `now`'s week), or null
 * (break week, no calendar).
 */
async function roundThisWeek(client, channelId, now = new Date()) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return null;
    const messages = await channel.messages.fetch({ limit: 10 }).catch(() => null);
    if (!messages) return null;
    const sunday = sundayOf(now).getTime();
    // The two newest calendars (part of the next season is sometimes posted
    // before the current one ends), newest first.
    const calendars = [...messages.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp)
        .map(m => parseRounds(m.content || '', new Date(m.createdTimestamp).getUTCFullYear()))
        .filter(r => r.length >= 1).slice(0, 2);
    for (const rounds of calendars) {
        const round = rounds.find(r => r.date.getTime() === sunday);
        if (round) return round;
    }
    return null;
}

module.exports = { roundThisWeek, parseRounds, sundayOf };
