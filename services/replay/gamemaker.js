const Bunzip = require('seek-bzip');
const { createCanvas, ImageData, loadImage } = require('@napi-rs/canvas');

/*
 * Reads sprites out of the game's GameMaker data file (game.unx / data.win),
 * for the car classes built into the game ("formulaa", "gtclassa", ...),
 * whose liveries aren't separate files. Each class has sprites
 * "<class>_medium_1" ... "<class>_medium_10".
 *
 * File: "FORM" + chunks (4-byte name, u32 size). Used here:
 *   SPRT  sprite list -> name, size, frames (pointers into TPAG)
 *   TPAG  frame -> rectangle on a texture page
 *   TXTR  texture pages: PNG, "fioq" (QOI, GameMaker's early-spec variant)
 *         or "2zoq" (that QOI compressed with bzip2)
 *   STRG  strings (a string pointer points at the text, its length is just before)
 */

function chunksOf(b) {
    if (b.toString('latin1', 0, 4) !== 'FORM') throw new Error('Not a GameMaker data file');
    const chunks = {};
    for (let o = 8; o + 8 <= b.length;) {
        const name = b.toString('latin1', o, o + 4), size = b.readUInt32LE(o + 4);
        chunks[name] = { start: o + 8, end: o + 8 + size };
        o += 8 + size;
    }
    return chunks;
}

const str = (b, p) => b.toString('utf8', p, p + b.readUInt32LE(p - 4));

// GameMaker's QOI (an early draft of the format). The differences are signed
// (two's complement) numbers: e.g. a 2-bit difference of 3 means -1.
const signed = bits => v => (v << (32 - bits)) >> (32 - bits);
const s2 = signed(2), s4 = signed(4), s5 = signed(5);

function decodeQoi(data, width, height) {
    const out = Buffer.alloc(width * height * 4);
    const index = new Uint8Array(64 * 4);
    let r = 0, g = 0, bl = 0, a = 255, run = 0, p = 0;
    for (let px = 0; px < out.length; px += 4) {
        if (run > 0) run--;
        else if (p < data.length) {
            const b1 = data[p++];
            if ((b1 & 0xc0) === 0x00) {                    // 00xxxxxx index
                const i = (b1 & 0x3f) * 4;
                r = index[i]; g = index[i + 1]; bl = index[i + 2]; a = index[i + 3];
            } else if ((b1 & 0xe0) === 0x40) {             // 010xxxxx run
                run = b1 & 0x1f;
            } else if ((b1 & 0xe0) === 0x60) {             // 011xxxxx xxxxxxxx long run
                run = (((b1 & 0x1f) << 8) | data[p++]) + 32;
            } else if ((b1 & 0xc0) === 0x80) {             // 10rrggbb
                r += s2((b1 >> 4) & 3); g += s2((b1 >> 2) & 3); bl += s2(b1 & 3);
            } else if ((b1 & 0xe0) === 0xc0) {             // 110rrrrr ggggbbbb
                const b2 = data[p++];
                r += s5(b1 & 0x1f); g += s4(b2 >> 4); bl += s4(b2 & 0x0f);
            } else if ((b1 & 0xf0) === 0xe0) {             // 1110rrrr rgggggbb bbbaaaaa
                const m = (b1 << 16) | (data[p++] << 8) | data[p++];
                r += s5((m >> 15) & 31); g += s5((m >> 10) & 31); bl += s5((m >> 5) & 31); a += s5(m & 31);
            } else {                                       // 1111rgba + the flagged channels
                if (b1 & 8) r = data[p++];
                if (b1 & 4) g = data[p++];
                if (b1 & 2) bl = data[p++];
                if (b1 & 1) a = data[p++];
            }
            r &= 255; g &= 255; bl &= 255; a &= 255;
            const i = ((r ^ g ^ bl ^ a) & 63) * 4;
            index[i] = r; index[i + 1] = g; index[i + 2] = bl; index[i + 3] = a;
        }
        out[px] = r; out[px + 1] = g; out[px + 2] = bl; out[px + 3] = a;
    }
    return out;
}

// A texture page as a canvas (or image).
async function decodeTexture(buf) {
    const magic = buf.toString('latin1', 0, 4);
    let w, h, rgba;
    if (magic === 'PNG') {
        let p = 8; // PNG length: walk its chunks up to IEND
        while (buf.toString('latin1', p + 4, p + 8) !== 'IEND') p += 12 + buf.readUInt32BE(p);
        return loadImage(buf.subarray(0, p + 12));
    }
    if (magic === 'fioq') {
        w = buf.readUInt16LE(4); h = buf.readUInt16LE(6);
        rgba = decodeQoi(buf.subarray(12, 12 + buf.readUInt32LE(8)), w, h);
    } else if (magic === '2zoq') {
        w = buf.readUInt16LE(4); h = buf.readUInt16LE(6);
        const bz = buf.toString('latin1', 8, 11) === 'BZh' ? 8 : 12; // newer versions add the decompressed size
        const qoi = Bunzip.decode(buf.subarray(bz));
        rgba = decodeQoi(qoi.subarray(12, 12 + qoi.readUInt32LE(8)), qoi.readUInt16LE(4), qoi.readUInt16LE(6));
    } else {
        throw new Error(`Unsupported texture format ${JSON.stringify(magic)}`);
    }
    const c = createCanvas(w, h);
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length), w, h), 0, 0);
    return c;
}

/**
 * PNGs of the first frame of the named sprites (missing names are skipped).
 * @returns {Promise<Map<string, Buffer>>}
 */
async function extractSprites(b, names) {
    const chunks = chunksOf(b);
    const want = new Set(names);
    const sp = chunks.SPRT, count = b.readUInt32LE(sp.start);
    const inTpag = v => v >= chunks.TPAG.start && v < chunks.TPAG.end;

    const frames = new Map(); // name -> TPAG item
    for (let i = 0; i < count && frames.size < want.size; i++) {
        const p = b.readUInt32LE(sp.start + 4 + i * 4);
        const name = str(b, b.readUInt32LE(p));
        if (!want.has(name)) continue;
        // The frame list: a small count followed by that many pointers into TPAG.
        for (let o = p + 12; o < p + 200; o += 4) {
            const c = b.readUInt32LE(o);
            if (c >= 1 && c <= 64 && Array.from({ length: c }, (_, k) => b.readUInt32LE(o + 4 + k * 4)).every(inTpag)) {
                frames.set(name, b.readUInt32LE(o + 4));
                break;
            }
        }
    }

    const tx = chunks.TXTR;
    const pages = new Map(); // page index -> canvas (decoded once)
    const page = async i => {
        if (pages.has(i)) return pages.get(i);
        const entry = b.readUInt32LE(tx.start + 4 + i * 4);
        let at = null;
        for (let k = 0; k < 8 && at == null; k++) {
            const v = b.readUInt32LE(entry + k * 4);
            if (v > tx.start && v < tx.end && ['\x89PNG', 'fioq', '2zoq'].includes(b.toString('latin1', v, v + 4))) at = v;
        }
        if (at == null) throw new Error(`Texture page ${i} not found`);
        const canvas = await decodeTexture(b.subarray(at));
        pages.set(i, canvas);
        return canvas;
    };

    const out = new Map();
    for (const [name, t] of frames) {
        const u = k => b.readUInt16LE(t + k * 2);
        const [sx, sy, sw, sh, tx0, ty0, tw, th, bw, bh, pageIndex] = Array.from({ length: 11 }, (_, k) => u(k));
        const c = createCanvas(bw, bh);
        c.getContext('2d').drawImage(await page(pageIndex), sx, sy, sw, sh, tx0, ty0, tw, th);
        out.set(name, await c.encode('png'));
    }
    return out;
}

module.exports = { extractSprites };
