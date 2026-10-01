const fs = require('fs');
const path = require('path');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');

// Drop any .ttf/.otf in assets/fonts/ and it gets registered. Without a
// font, containers with no system fonts would render blank text.
const FONT_DIR = path.join(__dirname, '../assets/fonts');
const FONT = 'StartersFont, sans-serif';
let fontsLoaded = false;

function loadFonts() {
    if (fontsLoaded) return;
    fontsLoaded = true;
    try {
        for (const f of fs.readdirSync(FONT_DIR)) {
            if (/\.(ttf|otf)$/i.test(f)) GlobalFonts.registerFromPath(path.join(FONT_DIR, f), 'StartersFont');
        }
    } catch { /* no fonts folder: fall back to system fonts */ }
}

// ---------- Layout ----------
const PAD = 14;
const COL_W = 390;
const COL_GAP = 26;
const ROW_H = 32;
const ICON_W = 56;      // small dark cell on the left of each row (like the reference)
const NUM_W = 54;       // number cell for independents
const BLOCK_GAP = 22;
const TITLE_H = 34;
const IND_CHUNK = 6;    // independents are split into blocks of 6 rows

const C_BG = '#0b0b0c';
const C_CELL = '#2b2b2d';
const C_ICON = '#232325';
const C_IND_HEAD = '#5a2a10';

// ---------- Color helpers ----------
function hexToRgb(hex) {
    let h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(hex) {
    const [r, g, b] = hexToRgb(hex).map(v => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
    const la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Black or white text, whichever reads better on this background.
function textOn(bg) {
    return contrast(bg, '#000000') >= contrast(bg, '#ffffff') ? '#000000' : '#ffffff';
}

// Team name is drawn in the team color on a dark cell; if that color is
// too dark to read (e.g. #000001), fall back to white.
function headerColor(teamColor) {
    return contrast(teamColor, C_CELL) >= 3 ? teamColor : '#ffffff';
}

function fit(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
}

// Emojis in nicknames don't render well in canvas (they show as boxes).
function cleanName(name) {
    const cleaned = String(name).replace(/\p{Extended_Pictographic}|\uFE0F|\u200D/gu, '').trim();
    return cleaned || String(name);
}

// ---------- Drawing ----------
function drawBlock(ctx, x, y, block) {
    const nameW = COL_W - ICON_W - 2;

    // Header row
    ctx.fillStyle = C_ICON;
    ctx.fillRect(x, y + 1, ICON_W, ROW_H - 2);
    ctx.fillStyle = block.kind === 'ind' ? C_IND_HEAD : C_CELL;
    ctx.fillRect(x + ICON_W + 2, y + 1, nameW, ROW_H - 2);
    ctx.fillStyle = block.kind === 'ind' ? '#ffffff' : headerColor(block.color);
    ctx.font = `bold 15px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillText(fit(ctx, block.title, nameW - 16), x + ICON_W + 12, y + ROW_H / 2 + 1);

    // Driver rows
    block.rows.forEach((driver, i) => {
        const ry = y + (i + 1) * ROW_H;
        ctx.fillStyle = C_ICON;
        ctx.fillRect(x, ry + 1, ICON_W, ROW_H - 2);

        if (block.kind === 'ind') {
            const w = nameW - NUM_W - 2;
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(x + ICON_W + 2, ry + 1, w, ROW_H - 2);
            ctx.fillStyle = C_IND_HEAD;
            ctx.fillRect(x + ICON_W + 2 + w + 2, ry + 1, NUM_W, ROW_H - 2);

            ctx.fillStyle = '#000000';
            ctx.font = `bold 15px ${FONT}`;
            ctx.textAlign = 'left';
            if (driver) ctx.fillText(fit(ctx, cleanName(driver), w - 20), x + ICON_W + 12, ry + ROW_H / 2 + 1);

            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            ctx.fillText(String(block.numberStart + i), x + ICON_W + 2 + w + 2 + NUM_W / 2, ry + ROW_H / 2 + 1);
        } else {
            ctx.fillStyle = block.color;
            ctx.fillRect(x + ICON_W + 2, ry + 1, nameW, ROW_H - 2);
            if (driver) {
                ctx.fillStyle = textOn(block.color);
                ctx.font = `bold 15px ${FONT}`;
                ctx.textAlign = 'left';
                ctx.fillText(fit(ctx, cleanName(driver), nameW - 20), x + ICON_W + 12, ry + ROW_H / 2 + 1);
            }
        }
    });
}

/**
 * @param {object} p
 * @param {string} p.roundName          e.g. 'ULS26R1'
 * @param {Array}  p.teams              [{ roleId, nombre, color }] (config order)
 * @param {number} p.independentSlots   6 (UL/CL/JL) or 18 (AL)
 * @param {object} p.round              the stored round ({ teams, independents })
 * @returns {Buffer} PNG
 */
function renderBoard({ roundName, teams, independentSlots, round }) {
    loadFonts();

    const blocks = teams.map(t => ({
        kind: 'team',
        title: t.nombre,
        color: t.color || '#888888',
        rows: [0, 1].map(i => round.teams[t.roleId]?.[i]?.name ?? null)
    }));

    for (let start = 0; start < independentSlots; start += IND_CHUNK) {
        const count = Math.min(IND_CHUNK, independentSlots - start);
        blocks.push({
            kind: 'ind',
            title: 'Independent',
            numberStart: start + 1,
            rows: Array.from({ length: count }, (_, i) => round.independents[start + i]?.name ?? null)
        });
    }

    // 2 columns; each grid row is as tall as its tallest block.
    const gridRows = [];
    for (let i = 0; i < blocks.length; i += 2) {
        const pair = blocks.slice(i, i + 2);
        gridRows.push({ pair, h: Math.max(...pair.map(b => (1 + b.rows.length) * ROW_H)) });
    }

    const W = PAD * 2 + COL_W * 2 + COL_GAP;
    const bodyH = gridRows.reduce((s, r) => s + r.h, 0) + BLOCK_GAP * Math.max(0, gridRows.length - 1);
    const H = PAD + TITLE_H + 14 + bodyH + PAD;

    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'middle';

    ctx.fillStyle = C_BG;
    ctx.fillRect(0, 0, W, H);

    // Title bar
    ctx.fillStyle = C_CELL;
    ctx.fillRect(PAD, PAD, W - PAD * 2, TITLE_H);
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 17px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillText('STARTING DRIVERS', PAD + 12, PAD + TITLE_H / 2 + 1);
    ctx.textAlign = 'right';
    ctx.fillText(roundName, W - PAD - 12, PAD + TITLE_H / 2 + 1);

    // Blocks
    let y = PAD + TITLE_H + 14;
    for (const row of gridRows) {
        row.pair.forEach((block, col) => {
            drawBlock(ctx, PAD + col * (COL_W + COL_GAP), y, block);
        });
        y += row.h + BLOCK_GAP;
    }

    return canvas.toBuffer('image/png');
}

module.exports = { renderBoard };
