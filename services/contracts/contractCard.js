const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const { select } = require('../core/supabase');

/*
 * The "contract confirmed" banner: driver, new team, seat and the team's car.
 * Every picture and piece of data comes from Supabase. Anything missing is left
 * out (no number, no logo...).
 */

const W = 1220, H = 306, NOTCH = 44;
const FONT_DIR = path.join(__dirname, '../../assets/fonts');
const FONT = 'ContractFont, sans-serif';
let fontsLoaded = false;

function loadFonts() {
    if (fontsLoaded) return;
    fontsLoaded = true;
    for (const f of fs.readdirSync(FONT_DIR)) {
        if (/\.(ttf|otf)$/i.test(f)) GlobalFonts.registerFromPath(path.join(FONT_DIR, f), 'ContractFont');
    }
}

// An image from a URL, or null: a missing picture must never stop the announcement.
async function image(url) {
    if (!url) return null;
    try {
        const res = await fetch(url);
        return res.ok ? await loadImage(Buffer.from(await res.arrayBuffer())) : null;
    } catch {
        return null;
    }
}

const seasonLabel = s => String(s).replace(/\s+/g, '');

function shade(hex, f) {
    const n = parseInt(hex.replace('#', ''), 16);
    const c = [n >> 16, (n >> 8) & 255, n & 255].map(v => Math.round(f < 1 ? v * f : v + (255 - v) * (f - 1)));
    return `rgb(${c.join(',')})`;
}

function brightness(hex) {
    const n = parseInt(hex.replace('#', ''), 16);
    return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

function banner(ctx) {
    ctx.beginPath();
    ctx.roundRect(0, 0, W, H, 10);
    ctx.closePath();
    ctx.save();
    ctx.clip();
}

// Biggest font size (up to max) at which the text fits the width.
function fit(ctx, text, width, max, min = 30) {
    let size = max;
    do {
        ctx.font = `${size}px ${FONT}`;
        if (ctx.measureText(text).width <= width) break;
        size -= 2;
    } while (size > min);
    return size;
}

function circleImage(ctx, img, x, y, r) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(img, x - r, y - r, r * 2, r * 2);
    ctx.restore();
}

function contain(ctx, img, x, y, w, h) {
    const k = Math.min(w / img.width, h / img.height);
    ctx.drawImage(img, x + (w - img.width * k) / 2, y + (h - img.height * k) / 2, img.width * k, img.height * k);
}

/**
 * card: { name, avatarUrl, flagUrl, number, seat, league, season, leagueLogoUrl, teamName, logoUrl, carUrl, color }
 * Returns a PNG buffer.
 */
async function renderContractCard(card) {
    loadFonts();
    const color = card.color || '#2b2d31';
    const light = brightness(color) > 0.62; // white or pale teams: dark background, so white text still reads
    const base = light ? '#1b1c20' : color;
    const [leagueLogo, teamLogo, car, avatar, flag] = await Promise.all([
        image(card.leagueLogoUrl),
        image(card.logoUrl),
        image(card.carUrl),
        image(card.avatarUrl),
        image(card.flagUrl)
    ]);

    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    banner(ctx);

    const bg = ctx.createLinearGradient(0, 0, W, 0);
    bg.addColorStop(0, shade(base, 0.32));
    bg.addColorStop(0.55, shade(base, 0.62));
    bg.addColorStop(1, shade(base, 0.95));
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Chevrons along the bottom and a dot grid behind the car.
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 12;
    for (let row = 0; row < 2; row++) {
        ctx.beginPath();
        for (let x = -40, i = 0; x < W + 40; x += 44, i++) ctx[i ? 'lineTo' : 'moveTo'](x, H - 52 + row * 34 + (i % 2 ? -18 : 0));
        ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    for (let y = 24; y < 180; y += 12) for (let x = 560; x < 1180; x += 12) ctx.fillRect(x, y, 2, 2);

    // Header: league logo, "UL · S26 · CONTRACT CONFIRMED".
    let hx = 48;
    if (leagueLogo) {
        contain(ctx, leagueLogo, 48, 22, 66, 42);
        hx = 130;
    }
    ctx.textBaseline = 'middle';
    ctx.font = `19px ${FONT}`;
    ctx.fillStyle = '#ffffff';
    const head = `${card.league}  ·  ${seasonLabel(card.season)}  ·  `;
    ctx.fillText(head, hx, 43);
    ctx.fillStyle = shade(light ? '#d0d0d0' : color, 1.55);
    ctx.fillText('CONTRACT CONFIRMED', hx + ctx.measureText(head).width, 43);

    // The car, on the right half.
    if (car) {
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.55)';
        ctx.shadowBlur = 26;
        ctx.shadowOffsetY = 10;
        // The game's pixel art, kept sharp.
        ctx.imageSmoothingEnabled = false;
        contain(ctx, car, 730, 46, 430, 214);
        ctx.imageSmoothingEnabled = true;
        ctx.restore();
    }

    // Driver's name.
    ctx.fillStyle = '#ffffff';
    const name = card.name.toUpperCase();
    fit(ctx, name, flag ? 530 : 600, 92);
    ctx.fillText(name, 46, 134);
    // The flag is the driver's nationality, so it goes by their name.
    if (flag) contain(ctx, flag, 46 + ctx.measureText(name).width + 16, 134 - 21, 60, 40);

    // Bottom line: avatar, number, team, flag, seat.
    const line = 232;
    let x = 48;
    if (avatar) {
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.beginPath();
        ctx.arc(x + 30, line, 32, 0, Math.PI * 2);
        ctx.fill();
        circleImage(ctx, avatar, x + 30, line, 29);
        x += 74;
    }
    if (card.number != null) {
        ctx.font = `32px ${FONT}`;
        ctx.fillStyle = shade(light ? '#d0d0d0' : color, 1.55);
        ctx.fillText(String(card.number), x, line);
        x += ctx.measureText(String(card.number)).width + 16;
    }
    const seat = card.seat ? card.seat.toUpperCase() : null;
    ctx.font = `17px ${FONT}`;
    const seatW = seat ? ctx.measureText(seat).width + 24 : 0;
    const team = card.teamName.toUpperCase();
    if (teamLogo) {
        contain(ctx, teamLogo, x, line - 21, 42, 42);
        x += 52;
    }
    fit(ctx, team, 640 - x - seatW - 20, 30, 16);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(team, x, line);
    x += ctx.measureText(team).width + 16;
    if (seat) {
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 2;
        ctx.strokeRect(x, line - 15, seatW, 30);
        ctx.font = `17px ${FONT}`;
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.fillText(seat, x + seatW / 2, line + 1);
        ctx.textAlign = 'left';
    }

    ctx.restore();
    // The cut corner, bottom right.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.moveTo(W, H - NOTCH);
    ctx.lineTo(W, H);
    ctx.lineTo(W - NOTCH, H);
    ctx.closePath();
    ctx.fill();

    return canvas.encode('png');
}

const media = path => `${process.env.SUPABASE_URL.replace(/\/+$/, '')}/storage/v1/object/public/media/${path}`;

/**
 * What the card and its message need, from Supabase: { card, teamName, fromName }.
 * teamShort / fromShort are the short names in config team_roles ("KMP").
 */
async function contractData({ discordId, league, teamShort, fromShort, seat, fallbackName, avatarUrl }) {
    const [lg] = await select('leagues', 'id,logo_url', { code: `eq.${league}` });
    const seasons = await select('seasons', 'id,number,division', { league_id: `eq.${lg.id}`, order: 'number.desc,division.desc.nullslast', limit: 1 });
    const season = seasons[0];

    // A short name can belong to two teams over the years: the one in this season's lineup, if any.
    const lineup = new Set((await select('lineups', 'team_id', { season_id: `eq.${season.id}` })).map(l => l.team_id));
    const teamFor = async short => {
        const rows = await select('teams', 'id,name,logo_url,color', { short_name: `eq.${short}` });
        return rows.find(t => lineup.has(t.id)) || rows.find(t => t.logo_url) || rows[0] || null;
    };
    const team = await teamFor(teamShort);
    const from = fromShort ? await teamFor(fromShort) : null;

    // This season's main livery, or the team's latest one.
    let carUrl = null;
    if (team) {
        const cars = await select('liveries', 'season_id,image_url', { team_id: `eq.${team.id}`, is_special: 'eq.false', order: 'season_id.desc' });
        carUrl = (cars.find(c => c.season_id === season.id) || cars[0])?.image_url || null;
    }

    const [driver] = await select('drivers', 'id,name,country_code,racing_number', { discord_id: `eq.${discordId}` });
    let number = driver?.racing_number ?? null;
    // The number 1 belongs to the reigning UL champion: last finished season's winner.
    if (driver) {
        const [ul] = await select('seasons', 'number', { league_id: `eq.${(await select('leagues', 'id', { code: 'eq.UL' }))[0].id}`, order: 'number.desc', limit: 1 });
        const [champ] = await select('v_driver_standings', 'driver_id', { league: 'eq.UL', number: `eq.${ul.number - 1}`, standing: 'eq.1' });
        if (champ?.driver_id === driver.id) number = 1;
    }

    const seasonName = `S${season.number}${season.division || ''}`;
    return {
        teamName: team?.name || teamShort,
        fromName: from?.name || fromShort || null,
        card: {
            name: driver?.name || fallbackName, avatarUrl, number, seat, league, season: seasonName,
            flagUrl: driver?.country_code ? media(`flags/${driver.country_code.toLowerCase()}.png`) : null,
            leagueLogoUrl: lg.logo_url,
            teamName: team?.name || teamShort, logoUrl: team?.logo_url || null, carUrl, color: team?.color || null
        }
    };
}

module.exports = { renderContractCard, contractData };
