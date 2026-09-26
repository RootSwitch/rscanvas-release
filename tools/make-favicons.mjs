#!/usr/bin/env node
// Rasterize public/favicon.svg into the sizes browsers and bookmark managers
// actually ask for, and check that the committed rasters still match it.
//
//   node tools/make-favicons.mjs            render (needs Chrome or Edge)
//   node tools/make-favicons.mjs --check    verify only, no browser (npm test)
//
// Ported from rswiki/tools/make-favicons.js (2026-09-24), for the reason it
// was written there. An SVG favicon is enough for a modern tab and nothing
// else: bookmark bars, history entries, OS shortcuts and older browsers all
// want a raster, and a browser's very first move is an unprompted GET
// /favicon.ico that has nothing to do with any <link> tag.
//
// WHAT ASKED FOR IT. RS-PROJECT-CONVENTIONS section 10 ships favicon.svg
// alone "until something real asks" for more. Firefox asked: it showed the
// generic globe on the RSCanvas tab while /favicon.svg answered 200, because
// it had already recorded /favicon.ico's 404 as "this origin has no icon" in
// places.sqlite, and a hard reload does not clear that. A real .ico declared
// FIRST in the head is the fix rswiki found and the one ported here.
//
// Two files, not rswiki's three: the 32px PNG is rendered but not kept,
// because the .ico already carries it byte for byte and STATIC_FILES serves
// what something asks for, not what a script happened to write.
//
// THE DRIFT GUARD is the one addition. Three files now show the mark, and the
// two rasters are copies: change favicon.svg without re-running this and the
// tab, the bookmarks and the home screen keep the OLD mark with nothing
// failing anywhere. So each PNG carries the sha256 of the SVG it was drawn
// from, in a tEXt chunk (ancillary: every decoder skips it), and --check
// refuses when the stamp and the SVG disagree. It also refuses the one SVG
// defect a render cannot see; the comment at that check says which.
//
// Uses whatever Chrome or Edge is installed, headless. The outputs are
// committed so neither a deployment nor the bundle ever needs a browser;
// re-run this if the mark changes, and commit the results with it.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const SVG = path.join(PUBLIC, 'favicon.svg');
const ICO = path.join(PUBLIC, 'favicon.ico');
const TOUCH = path.join(PUBLIC, 'apple-touch-icon.png');
const STAMP_KEY = 'rscanvas-mark-sha256';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The chunks of a PNG, in order: [{ type, data, at, end }]. */
function chunks(png) {
    if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIG)) return null;
    const out = [];
    let o = 8;
    while (o + 12 <= png.length) {
        const len = png.readUInt32BE(o);
        const type = png.toString('latin1', o + 4, o + 8);
        out.push({ type, data: png.subarray(o + 8, o + 8 + len), at: o, end: o + 12 + len });
        o += 12 + len;
    }
    return out;
}

/** Width and height from IHDR, or null for something that is not a PNG. */
function pngSize(png) {
    const ihdr = chunks(png)?.[0];
    if (ihdr?.type !== 'IHDR') return null;
    return { w: ihdr.data.readUInt32BE(0), h: ihdr.data.readUInt32BE(4) };
}

/** The mark's hash a PNG says it was drawn from, or null if unstamped. */
function stampOf(png) {
    for (const c of chunks(png) ?? []) {
        if (c.type !== 'tEXt') continue;
        const nul = c.data.indexOf(0);
        if (nul !== -1 && c.data.toString('latin1', 0, nul) === STAMP_KEY) {
            return c.data.toString('latin1', nul + 1);
        }
    }
    return null;
}

/** The PNG with a tEXt stamp inserted just before IEND. */
function stamp(png, hash) {
    const iend = chunks(png)?.find((c) => c.type === 'IEND');
    if (iend === undefined) throw new Error('no IEND chunk - not a complete PNG');
    const body = Buffer.concat([Buffer.from('tEXt', 'latin1'),
        Buffer.from(`${STAMP_KEY}\0${hash}`, 'latin1')]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length - 4, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body), 0);
    return Buffer.concat([png.subarray(0, iend.at), len, body, crc, png.subarray(iend.at)]);
}

/** The single PNG inside a one-image .ico, or null. */
function icoPng(ico) {
    if (ico.length < 22 || ico.readUInt16LE(2) !== 1 || ico.readUInt16LE(4) !== 1) return null;
    const size = ico.readUInt32LE(6 + 8);
    const offset = ico.readUInt32LE(6 + 12);
    return ico.subarray(offset, offset + size);
}

// Line endings are normalized first. With core.autocrlf a Windows checkout
// holds the SVG as CRLF and a Linux one as LF: the same mark, two byte
// sequences, and a stamp keyed on raw bytes would refuse one of them.
const svgHash = () => createHash('sha256')
    .update(fs.readFileSync(SVG, 'utf8').replace(/\r\n/g, '\n')).digest('hex');

// --- --check: the drift guard, no browser needed -----------------------------

if (process.argv.includes('--check')) {
    const want = svgHash();
    const bad = [];
    // The failure rswiki shipped (its CHANGELOG, 2026-08): a comment in its
    // favicon.svg carried "--", which is illegal inside an XML comment, and a
    // standalone .svg is parsed as strict XML - so every browser refused the
    // file. This script never noticed, because it INLINES the mark into HTML,
    // where comment parsing is lenient, and drew perfect rasters from a file
    // no browser would open. Rendering proves nothing about the SVG itself.
    const comments = fs.readFileSync(SVG, 'utf8').matchAll(/<!--([\s\S]*?)-->/g);
    for (const [, text] of comments) {
        if (text.includes('--') || text.endsWith('-')) {
            bad.push('favicon.svg: a comment contains "--" or ends in "-", which strict XML '
                + 'refuses - the browser drops the whole file while the rasters still look right');
        }
    }
    const look = (label, png, size) => {
        if (png === null) { bad.push(`${label}: missing or not a PNG-in-ICO`); return; }
        const got = pngSize(png);
        if (got === null || got.w !== size || got.h !== size) {
            bad.push(`${label}: expected ${size}x${size}, got ${got === null ? 'not a PNG' : `${got.w}x${got.h}`}`);
        }
        const s = stampOf(png);
        if (s !== want) bad.push(`${label}: drawn from ${s === null ? 'an unstamped mark' : s.slice(0, 12)}, `
            + `favicon.svg is now ${want.slice(0, 12)}`);
    };
    const read = (f) => { try { return fs.readFileSync(f); } catch { return null; } };
    const ico = read(ICO);
    look('favicon.ico', ico === null ? null : icoPng(ico), 32);
    look('apple-touch-icon.png', read(TOUCH), 180);
    if (bad.length > 0) {
        console.error('REFUSING: the favicon set is not one a browser will show as committed.\n');
        for (const b of bad) console.error(`  ${b}`);
        console.error('\nFix the mark if it is named above, then re-run `node tools/make-favicons.mjs`'
            + ' and commit the results with it.');
        process.exit(1);
    }
    console.log(`ok - favicon.ico and apple-touch-icon.png are drawn from the current mark (${want.slice(0, 12)})`);
    process.exit(0);
}

// --- render -----------------------------------------------------------------

const CANDIDATES = [
    process.env.CHROME,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const browser = CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
if (!browser) {
    console.error('make-favicons: no Chrome or Edge found. Set CHROME=/path/to/browser');
    process.exit(1);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rscanvas-icon-'));
const svg = fs.readFileSync(SVG, 'utf8');
const hash = svgHash();

// The mark is inlined rather than referenced, so the page has no dependency to
// load and the screenshot cannot race it.
function page(size) {
    return '<!doctype html><meta charset="utf-8"><style>'
        + 'html,body{margin:0;padding:0;background:transparent}'
        + `svg{display:block;width:${size}px;height:${size}px}`
        + '</style>' + svg;
}

// A screenshot is only as trustworthy as its dimensions: a scaled display or
// a browser that enforces a minimum window size hands back a PNG of some OTHER
// size, and a favicon of the wrong size still looks like a file that worked.
// So the size is read back out of IHDR and a mismatch is a failure.
function render(size) {
    const html = path.join(profile, `icon-${size}.html`);
    const shot = path.join(profile, `icon-${size}.png`);
    fs.writeFileSync(html, page(size));
    execFileSync(browser, [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        `--user-data-dir=${profile}`,
        // Transparent, or every rounded corner comes out white.
        '--default-background-color=00000000',
        '--force-device-scale-factor=1',
        `--window-size=${size},${size}`,
        '--virtual-time-budget=2000',
        `--screenshot=${shot}`,
        'file://' + html.replace(/\\/g, '/'),
    ], { stdio: 'pipe' });
    const png = fs.readFileSync(shot);
    const got = pngSize(png);
    if (got === null || got.w !== size || got.h !== size) {
        throw new Error(`expected a ${size}x${size} PNG, got `
            + (got === null ? 'something that is not a PNG' : `${got.w}x${got.h}`));
    }
    return stamp(png, hash);
}

// A .ico is a 6 byte header, one 16 byte directory entry, then the image. Since
// Vista that image may be a PNG verbatim, so the 32px render is simply wrapped
// rather than re-encoded into the old BMP form.
function ico(png, size) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);          // reserved
    header.writeUInt16LE(1, 2);          // 1 = icon
    header.writeUInt16LE(1, 4);          // one image
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);   // 0 means 256
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);              // palette size
    entry.writeUInt8(0, 3);              // reserved
    entry.writeUInt16LE(1, 4);           // colour planes
    entry.writeUInt16LE(32, 6);          // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(header.length + entry.length, 12);
    return Buffer.concat([header, entry, png]);
}

try {
    console.log(`rendering ${hash.slice(0, 12)} with ${browser}`);
    fs.writeFileSync(ICO, ico(render(32), 32));
    console.log(`  favicon.ico           ${fs.statSync(ICO).size} bytes`);
    fs.writeFileSync(TOUCH, render(180));
    console.log(`  apple-touch-icon.png  ${fs.statSync(TOUCH).size} bytes`);
} finally {
    fs.rmSync(profile, { recursive: true, force: true });
}
console.log('done - commit both with the mark');
