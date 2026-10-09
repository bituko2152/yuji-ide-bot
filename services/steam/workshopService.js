const fs = require('fs');
const path = require('path');
const { EmbedBuilder, escapeMarkdown } = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { fetchPersonaName } = require('./steamProfiles');

/*
 * Announces new Ultimate Racing 2D 2 Workshop TRACKS (only items tagged
 * "Track": no car classes or anything else) in canal_workshop_tracks_id.
 *
 * No Steam API key needed:
 *  - the public Workshop browse page (filtered by the "Track" tag, newest
 *    first) gives the item ids;
 *  - ISteamRemoteStorage/GetPublishedFileDetails (keyless) gives title,
 *    preview image, tags, file size, dates...
 *
 * Skipped (never announced):
 *  - titles containing any BLOCKED_WORDS as a whole word, any case
 *    ("AI" matches "AI Track" or "[ai]", not "Main");
 *  - likely copies of an existing track: exact same track file size, same
 *    normalized title by the same author (findOriginal), or practically the
 *    same preview image as a track of the same author / a recent upload
 *    (findSamePreview: re-uploads under another name).
 *
 * First run: walks every Workshop page to learn all existing tracks (used to
 * detect copies) and announces nothing, so the channel isn't flooded.
 *
 * data/workshopTracks.json:
 *   { seen: [ids, newest first], known: [ { id, key, size, creator, hash?, msg? (announcement message id) } ] }
 */

const APP_ID = 1285230;
const BROWSE_URL = `https://steamcommunity.com/workshop/browse/?appid=${APP_ID}` +
    '&browsesort=mostrecent&actualsort=mostrecent&section=readytouseitems&requiredtags%5B%5D=Track&numperpage=30&p=';
const DETAILS_URL = 'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/';
const CHECK_EVERY_MS = 10 * 60 * 1000;
const REMEMBER_IDS = 200;      // enough to never re-announce anything on the first page
const MAX_PAGES = 200;         // safety cap for the first-run full scan
const PAGE_DELAY_MS = 1000;    // be gentle with Steam during the full scan
const DETAILS_BATCH = 100;

const BLOCKED_WORDS = ['AI', 'UL', 'Fixed', 'FE', 'VL'];
const BLOCKED_RE = new RegExp(`\\b(${BLOCKED_WORDS.join('|')})\\b`, 'i');

// Words that don't make a track different when comparing titles for copies.
// "v2", "remake"... are NOT here on purpose: those count as a new track.
const NOISE_RE = /\b(copy|copied|edit|edited|updated?|final|\d+(\.\d+)+)\b/g;

const storeFile = path.join(__dirname, '../../data/workshopTracks.json');

function loadConfig() {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '../../config.json'), 'utf-8'));
}

function readStore() {
    try { return JSON.parse(fs.readFileSync(storeFile, 'utf-8')); }
    catch { return null; }
}

function writeStore(store) {
    fs.writeFileSync(storeFile, JSON.stringify(store));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- Steam

async function fetchTrackIdsPage(page) {
    const res = await fetch(BROWSE_URL + page);
    if (!res.ok) throw new Error(`Workshop browse page returned ${res.status}`);
    const html = await res.text();
    return [...new Set([...html.matchAll(/filedetails\/\?id=(\d+)/g)].map(m => m[1]))];
}

async function fetchDetails(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += DETAILS_BATCH) {
        const batch = ids.slice(i, i + DETAILS_BATCH);
        const body = new URLSearchParams({ itemcount: String(batch.length) });
        batch.forEach((id, k) => body.append(`publishedfileids[${k}]`, id));

        const res = await fetch(DETAILS_URL, { method: 'POST', body });
        if (!res.ok) throw new Error(`GetPublishedFileDetails returned ${res.status}`);
        const json = await res.json();
        out.push(...(json.response?.publishedfiledetails || []));
    }
    return out;
}

// ---------------------------------------------------------------- filters

const isTrack = item => (item.tags || []).some(t => t.tag === 'Track');
const isPublic = item => item.result === 1 && item.visibility === 0 && !item.banned;
const hasBlockedWord = item => BLOCKED_RE.test(item.title || '');

// "Monza [FIXED] (copy)" -> "monza"   ("Monza v2" -> "monzav2", a different track)
function titleKey(title) {
    return (title || '')
        .toLowerCase()
        .replace(/[[(].*?[\])]/g, ' ')
        .replace(BLOCKED_RE, ' ')
        .replace(NOISE_RE, ' ')
        .replace(/[^a-z0-9]+/g, '');
}

const knownEntry = item => ({
    id: item.publishedfileid,
    key: titleKey(item.title),
    size: item.file_size,
    creator: item.creator
});

// Returns the known track this one looks copied from, or null:
//  - byte-identical track file (same size), whoever uploaded it, or
//  - same normalized title re-uploaded by the SAME author ("Monza (copy)").
// Same title by a different author is NOT a copy: real circuits (Imola,
// Spa...) are legitimately recreated by many people.
// (Re-uploads under a different title are caught by findSamePreview.)
function findOriginal(item, known) {
    const key = titleKey(item.title);
    return known.find(k => k.id !== item.publishedfileid && (
        (item.file_size && k.size === item.file_size) ||
        (key && k.key === key && k.creator === item.creator)
    )) || null;
}

// ---------------------------------------------------------------- preview images

// Difference hash of the preview image: 256 bits, nearly identical for the
// same picture even after small edits or recompression. Real duplicates
// measured 0 bits apart, different tracks 110+.
const HASH_W = 17, HASH_H = 16;
const SAME_PREVIEW_MAX_BITS = 20;
const SURE_PREVIEW_MAX_BITS = 5;  // strict: only this close is safe enough to edit an announcement
const RECENT_KNOWN = 30;        // besides same-author tracks, compare with the latest ones
const MAX_NEW_HASHES = 10;      // per check: hashing images is memory-heavy on small hosts

async function previewHash(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`preview returned ${res.status}`);
    const img = await loadImage(Buffer.from(await res.arrayBuffer()));
    const canvas = createCanvas(HASH_W, HASH_H);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, HASH_W, HASH_H);
    const px = ctx.getImageData(0, 0, HASH_W, HASH_H).data;
    const gray = (x, y) => { const i = (y * HASH_W + x) * 4; return px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114; };
    let bits = '';
    for (let y = 0; y < HASH_H; y++) for (let x = 0; x < HASH_W - 1; x++) bits += gray(x, y) < gray(x + 1, y) ? '1' : '0';
    return bits;
}

const hashDistance = (a, b) => [...a].reduce((n, c, i) => n + (c !== b[i]), 0);

// The known track (same author, or among the latest uploads) whose preview
// image is practically the same as this one's: the same track re-uploaded
// under another name ("New track" -> "De Weiden"). Missing hashes of those
// candidates are computed now and kept in the store.
async function findSamePreview(item, known) {
    if (!item.preview_url) return null;
    const hash = await previewHash(item.preview_url).catch(() => null);
    if (!hash) return null;
    item._hash = hash;

    const candidates = known.filter((k, i) => k.id !== item.publishedfileid &&
        (k.creator === item.creator || i >= known.length - RECENT_KNOWN));

    // Newest first, and only a few per check; the rest get hashed on later checks.
    const missing = candidates.filter(k => !k.hash).slice(-MAX_NEW_HASHES);
    if (missing.length) {
        const details = await fetchDetails(missing.map(k => k.id)).catch(() => []);
        for (const d of details) {
            const k = missing.find(m => m.id === d.publishedfileid);
            if (k && d.preview_url) k.hash = await previewHash(d.preview_url).catch(() => null);
        }
    }

    let best = null;
    for (const k of candidates) {
        if (!k.hash) continue;
        const distance = hashDistance(k.hash, hash);
        if (distance <= SAME_PREVIEW_MAX_BITS && (!best || distance < best.distance)) best = { entry: k, distance };
    }
    return best; // { entry, distance } or null
}

// Is `item` certainly the same track as the known `entry`, re-uploaded by
// its own author? Only then may the old announcement be edited.
function isSureReupload(item, entry, previewDistance) {
    if (entry.creator !== item.creator) return false;
    const sameTitle = titleKey(item.title) && titleKey(item.title) === entry.key;
    return sameTitle || (previewDistance != null && previewDistance <= SURE_PREVIEW_MAX_BITS);
}

// ---------------------------------------------------------------- message

function buildEmbed(item, authorName = null) {
    const tags = (item.tags || []).map(t => t.tag).filter(t => t !== 'Track');
    let description = (item.description || '').trim();
    if (description.length > 300) description = description.slice(0, 297) + '…';

    const embed = new EmbedBuilder()
        .setColor('#1b2838')
        .setTitle(`🏁 New track: ${item.title}`)
        .setURL(`https://steamcommunity.com/sharedfiles/filedetails/?id=${item.publishedfileid}`)
        .setTimestamp(item.time_created * 1000)
        .setFooter({ text: 'Steam Workshop · Ultimate Racing 2D 2' });

    if (description) embed.setDescription(description);
    if (item.preview_url) embed.setImage(item.preview_url);
    if (tags.length) embed.addFields({ name: 'Tags', value: tags.join(', '), inline: true });
    embed.addFields({
        name: 'Author',
        value: `[${authorName ? escapeMarkdown(authorName).replace(/[[\]]/g, '\\$&') : 'Steam profile'}](https://steamcommunity.com/profiles/${item.creator})`,
        inline: true
    });
    return embed;
}

// ---------------------------------------------------------------- loop

async function firstRunScan() {
    const ids = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
        const pageIds = await fetchTrackIdsPage(page);
        if (!pageIds.length) break;
        ids.push(...pageIds);
        await sleep(PAGE_DELAY_MS);
    }
    const unique = [...new Set(ids)];
    const known = (await fetchDetails(unique)).filter(i => i.result === 1 && isTrack(i)).map(knownEntry);
    writeStore({ seen: unique.slice(0, REMEMBER_IDS), known });
    console.log(`🏁 [Workshop] First run: learned ${known.length} existing tracks, nothing announced.`);
}

async function checkWorkshop(client) {
    const channelId = loadConfig().canal_workshop_tracks_id;
    if (!channelId || channelId === '???') return;

    const store = readStore();
    if (!store?.known) return firstRunScan();

    const ids = await fetchTrackIdsPage(1);
    const newIds = ids.filter(id => !store.seen.includes(id));
    if (!newIds.length) return;

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) {
        console.warn('⚠️ [Workshop] Could not fetch canal_workshop_tracks_id.');
        return;
    }

    // Oldest first so the channel reads in upload order.
    const items = (await fetchDetails(newIds))
        .filter(i => isPublic(i) && isTrack(i))
        .sort((a, b) => a.time_created - b.time_created);

    for (const item of items) {
        const entry = { ...knownEntry(item) };

        if (hasBlockedWord(item)) {
            console.log(`🏁 [Workshop] Skipped (blocked word): ${item.title}`);
        } else {
            let original = findOriginal(item, store.known);
            let distance = null;
            if (!original) {
                const same = await findSamePreview(item, store.known);
                if (same) ({ entry: original, distance } = same);
            }

            if (!original) {
                const sent = await channel.send({ embeds: [buildEmbed(item, await fetchPersonaName(item.creator))] });
                entry.msg = sent.id; // remembered so a later re-upload can update it
                console.log(`🏁 [Workshop] Announced track: ${item.title}`);
            } else if (original.msg && isSureReupload(item, original, distance)) {
                // Same author re-uploaded the same track (e.g. "New track" -> "De Weiden"):
                // update the existing announcement to the new item instead of posting again.
                const edited = await channel.messages.edit(original.msg, {
                    embeds: [buildEmbed(item, await fetchPersonaName(item.creator))]
                }).catch(() => null);
                if (edited) {
                    entry.msg = original.msg;
                    delete original.msg;
                    console.log(`🏁 [Workshop] Updated announcement of ${original.id} -> ${item.publishedfileid}: ${item.title}`);
                } else {
                    console.log(`🏁 [Workshop] Skipped (re-upload of ${original.id}, old announcement not editable): ${item.title}`);
                }
            } else {
                console.log(`🏁 [Workshop] Skipped (looks like a copy of ${original.id}): ${item.title}`);
            }
        }

        if (item._hash) entry.hash = item._hash;
        store.known.push(entry);
    }

    // Non-public items stay out of "seen", so they're announced once made public.
    const handled = new Set(items.map(i => i.publishedfileid));
    const stillPrivate = new Set(newIds.filter(id => !handled.has(id)));
    store.seen = [...newIds.filter(id => !stillPrivate.has(id)), ...store.seen].slice(0, REMEMBER_IDS);
    writeStore(store);
}

function startWorkshopLoop(client) {
    let running = false; // the first-run scan can take a couple of minutes
    const tick = async () => {
        if (running) return;
        running = true;
        try { await checkWorkshop(client); }
        catch (err) { console.error('❌ [Workshop]', err.message); }
        finally { running = false; }
    };
    tick();
    setInterval(tick, CHECK_EVERY_MS);
    console.log('🏁 [Workshop] Track announcements started.');
}

module.exports = { startWorkshopLoop, fetchTrackIdsPage, fetchDetails, buildEmbed, titleKey, hasBlockedWord, findOriginal, findSamePreview, knownEntry };
