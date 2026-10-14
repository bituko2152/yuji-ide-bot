const fs = require('fs');
const path = require('path');
const { EmbedBuilder } = require('discord.js');

/*
 * Announces new developer posts (patch notes, updates...) from Steam, for
 * each game listed in config.json "noticias_steam", each in its own channel
 * (which can be in any server the bot is in):
 *
 *   "noticias_steam": [
 *     { "appid": 1285230, "nombre": "Ultimate Racing 2D 2", "canal_id": "..." },
 *     { "appid": 3230780, "nombre": "Ultimate Rally 2D",   "canal_id": "..." }
 *   ]
 *
 * Uses ISteamNews/GetNewsForApp (keyless), limited to the
 * "steam_community_announcements" feed, i.e. only what the developer posts
 * on that game's Steam page (no third-party press articles).
 *
 * Store sales are announced too (they aren't news posts): see checkSale.
 * Nothing here ever pings anyone.
 *
 * First run of each game: remembers its current posts and announces nothing.
 * data/steamNews.json: { "<appid>": { seen: [gids, newest first], discount: <last %>, saleMsg?: <message id> } }
 */

const CHECK_EVERY_MS = 10 * 60 * 1000;
const REMEMBER = 50;
const CLAN_IMAGE_BASE = 'https://clan.akamai.steamstatic.com/images/';

const storeFile = path.join(__dirname, '../../data/steamNews.json');

function loadConfig() {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '../../config.json'), 'utf-8'));
}

function readStore() {
    try {
        const store = JSON.parse(fs.readFileSync(storeFile, 'utf-8'));
        // Old single-game format ({ seen: [...] }) belonged to Ultimate Racing 2D 2.
        return Array.isArray(store.seen) ? { 1285230: { seen: store.seen } } : store;
    } catch {
        return {};
    }
}

function writeStore(store) {
    fs.writeFileSync(storeFile, JSON.stringify(store));
}

// ---------------------------------------------------------------- Steam

async function fetchNews(appId) {
    const res = await fetch(`https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${appId}` +
        '&count=10&maxlength=0&feeds=steam_community_announcements');
    if (!res.ok) throw new Error(`GetNewsForApp(${appId}) returned ${res.status}`);
    const json = await res.json();
    return json.appnews?.newsitems || [];
}

// Store header image of the game, used when a post has no image of its own.
const headerCache = {};
async function headerImage(appId) {
    if (headerCache[appId] !== undefined) return headerCache[appId];
    try {
        const res = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appId}&filters=basic`);
        headerCache[appId] = (await res.json())[appId]?.data?.header_image || null;
    } catch {
        return null; // try again next time
    }
    return headerCache[appId];
}

// ---------------------------------------------------------------- BBCode -> Discord

const clanImage = src => src.replace('{STEAM_CLAN_IMAGE}/', CLAN_IMAGE_BASE);

function firstImage(bbcode) {
    const m = bbcode.match(/\[img[^\]]*\]\s*(.*?)\s*\[\/img\]/i) || bbcode.match(/\[img\s+src="([^"]+)"/i);
    return m ? clanImage(m[1]) : null;
}

function bbcodeToMarkdown(bbcode) {
    return bbcode
        .replace(/\r/g, '')
        .replace(/\[img[^\]]*\].*?\[\/img\]|\[img[^\]]*\/?\]/gis, '')
        .replace(/\[previewyoutube=([\w-]+)[^\]]*\].*?\[\/previewyoutube\]/gis, 'https://youtu.be/$1\n')
        .replace(/\[video[^\]]*\].*?\[\/video\]/gis, '')
        .replace(/\[h[1-3]\](.*?)\[\/h[1-3]\]/gis, '\n**$1**\n')
        .replace(/\[b\](.*?)\[\/b\]/gis, '**$1**')
        .replace(/\[i\](.*?)\[\/i\]/gis, '*$1*')
        .replace(/\[u\](.*?)\[\/u\]/gis, '__$1__')
        .replace(/\[strike\](.*?)\[\/strike\]/gis, '~~$1~~')
        .replace(/\[url=["']?([^\]"']+)["']?\](.*?)\[\/url\]/gis, '[$2]($1)')
        .replace(/\[url\](.*?)\[\/url\]/gis, '$1')
        .replace(/\[\*\]\s*(\[p\])?\s*/gi, '\n• ')
        .replace(/\s*(\[\/p\])?\s*\[\/\*\]/gi, '')
        .replace(/\[\/?(p|list|olist|\*|quote|code|noparse|spoiler|table|tr|td|th)[^\]]*\]/gi, '\n')
        .replace(/\[\/?[a-z0-9]+[^\]]*\]/gi, '')           // any tag left
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ---------------------------------------------------------------- message

function buildEmbed(game, item, fallbackImage) {
    let description = bbcodeToMarkdown(item.contents || '');
    if (description.length > 1500) description = description.slice(0, 1497) + '…';

    const embed = new EmbedBuilder()
        .setColor('#66c0f4')
        .setAuthor({ name: `${game.nombre} · Steam news` })
        .setTitle(`📰 ${item.title}`)
        .setURL(`https://store.steampowered.com/news/app/${game.appid}/view/${item.gid}`)
        .setFooter({ text: item.author ? `Posted by ${item.author}` : 'Steam' })
        .setTimestamp(item.date * 1000);

    const image = firstImage(item.contents || '') || fallbackImage;
    if (image) embed.setImage(image);
    if (description) embed.setDescription(description);
    return embed;
}

// ---------------------------------------------------------------- sales

// price_overview of the store page, or null (free / unreleased / error).
async function fetchPrice(appId, cc) {
    const res = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appId}&cc=${cc}&filters=price_overview`);
    if (!res.ok) throw new Error(`appdetails(${appId}) returned ${res.status}`);
    const json = await res.json();
    return json[appId]?.data?.price_overview || null;
}

function buildSaleEmbed(game, usd, eur, image) {
    const price = p => `~~${p.initial_formatted}~~ **${p.final_formatted}**`;
    const embed = new EmbedBuilder()
        .setColor('#4c6b22')
        .setAuthor({ name: `${game.nombre} · Steam sale` })
        .setTitle(`💸 ${game.nombre} is ${usd.discount_percent}% off!`)
        .setURL(`https://store.steampowered.com/app/${game.appid}/`)
        .setDescription([usd, eur].filter(Boolean).map(price).join(' · '))
        .setTimestamp();
    if (image) embed.setImage(image);
    return embed;
}

// Steam sales aren't news posts, so the store price is checked too.
// A discount is announced when it starts; if its % changes the message is
// updated, and when it ends the message is deleted (known.saleMsg tracks it).
async function checkSale(client, game, store) {
    if (!game.canal_id || game.canal_id === '???') return;

    const usd = await fetchPrice(game.appid, 'us');
    // No price at all (unreleased, or Steam answered without data): don't treat
    // it as "the sale ended", or a hiccup would delete the message.
    if (!usd) return;

    const discount = usd.discount_percent || 0;
    const known = store[game.appid] ||= { seen: [] };
    const previous = known.discount || 0;
    known.discount = discount;
    if (discount === previous) return;

    const channel = await client.channels.fetch(game.canal_id).catch(() => null);
    if (!channel) return;

    // Sale over: remove its announcement.
    if (!discount) {
        if (known.saleMsg) {
            // Forgotten only once it's really gone (deleted now, or already
            // deleted by hand: 10008 Unknown Message); otherwise retried next check.
            const err = await channel.messages.delete(known.saleMsg).then(() => null, e => e);
            if (err && err.code !== 10008) {
                known.discount = previous;
                console.error(`❌ [News] ${game.nombre}: couldn't delete the sale announcement (${err.message}), retrying.`);
                return;
            }
            delete known.saleMsg;
            console.log(`💸 [News] ${game.nombre}: sale ended, announcement deleted`);
        }
        return;
    }

    const eur = await fetchPrice(game.appid, 'es').catch(() => null);
    const payload = {
        embeds: [buildSaleEmbed(game, usd, eur, await headerImage(game.appid))],
        allowedMentions: { parse: [] }
    };

    // Different % during the same sale: update the existing message.
    const edited = known.saleMsg && await channel.messages.edit(known.saleMsg, payload).catch(() => null);
    if (edited) {
        console.log(`💸 [News] ${game.nombre}: sale updated to ${discount}%`);
        return;
    }

    const sent = await channel.send(payload);
    known.saleMsg = sent.id;
    console.log(`💸 [News] ${game.nombre}: announced ${discount}% sale`);
}

// ---------------------------------------------------------------- loop

async function checkGame(client, game, store) {
    if (!game.canal_id || game.canal_id === '???') return;

    const news = await fetchNews(game.appid);
    const known = store[game.appid];

    if (!known) {
        // First run for this game (even with no posts yet, so its very first post IS announced).
        store[game.appid] = { seen: news.map(n => n.gid).slice(0, REMEMBER) };
        console.log(`📰 [News] ${game.nombre}: first run, remembered ${news.length} existing posts.`);
        return;
    }

    const fresh = news.filter(n => !known.seen.includes(n.gid)).sort((a, b) => a.date - b.date);
    if (!fresh.length) return;

    const channel = await client.channels.fetch(game.canal_id).catch(() => null);
    if (!channel) {
        console.warn(`⚠️ [News] ${game.nombre}: could not fetch channel ${game.canal_id} (is the bot in that server?).`);
        return;
    }

    const fallbackImage = await headerImage(game.appid);
    for (const item of fresh) {
        await channel.send({ embeds: [buildEmbed(game, item, fallbackImage)], allowedMentions: { parse: [] } });
        known.seen.unshift(item.gid);
        console.log(`📰 [News] ${game.nombre}: announced "${item.title}"`);
    }
    known.seen = known.seen.slice(0, REMEMBER);
}

async function checkNews(client) {
    const games = loadConfig().noticias_steam || [];
    const store = readStore();
    for (const game of games) {
        // One game failing (Steam hiccup, missing channel...) doesn't block the others.
        await checkGame(client, game, store).catch(err => console.error(`❌ [News] ${game.nombre}:`, err.message));
        await checkSale(client, game, store).catch(err => console.error(`❌ [News] ${game.nombre} (sale):`, err.message));
    }
    writeStore(store);
}

function startNewsLoop(client) {
    const tick = () => checkNews(client).catch(err => console.error('❌ [News]', err.message));
    tick();
    setInterval(tick, CHECK_EVERY_MS);
    console.log('📰 [News] Steam news announcements started.');
}

module.exports = { startNewsLoop, fetchNews, buildEmbed, bbcodeToMarkdown, headerImage };
