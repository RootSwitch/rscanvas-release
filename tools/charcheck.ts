// Family style rule: no em/en dashes or curly quotes in tracked files (use
// " - " and straight quotes). Scans everything git tracks; exits non-zero
// listing offenders. Runs as part of `npm test`.
//
// Ported from alertcanvas/tools/charcheck.js, with two deliberate changes.
//
// 1. The banned characters are built from code points rather than written as
//    literals. The parent wrote them literally, which means the checker was
//    itself an offending file on seven lines. It reported clean anyway, for a
//    reason worth recording: the parent's binary guard was a literal NUL byte
//    embedded in the source, so charcheck.js contained a NUL, so charcheck.js
//    skipped ITSELF as binary. The rule was never enforced on the enforcer,
//    and the exemption was an accident rather than a decision.
//
// 2. Consequently there is no NUL literal here either. A raw NUL in source is
//    invisible in every editor and turns the file binary to git and grep.
//
// The general shape of that bug is the one this project keeps meeting: a
// too-narrow measurement looks exactly like a passing subject.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// em dash, en dash, curly double open/close, curly single open/close.
const BANNED: Record<number, string> = {
    0x2014: 'em dash',
    0x2013: 'en dash',
    0x201c: 'curly double quote',
    0x201d: 'curly double quote',
    0x2018: 'curly single quote',
    0x2019: 'curly single quote',
};

const NUL = String.fromCharCode(0);

// THE ONE PLACE A TRACKED FILE MAY BE BINARY (2026-09-24): the raster
// favicons tools/make-favicons.mjs writes into public/. Every PNG carries NUL
// bytes in its first chunk header, so without this entry the NUL rule below
// fails them - correctly, by its own terms.
//
// Declared by extension AND proven by signature, because the NUL rule's whole
// point is that a skip must never happen by accident: a text file that merely
// ends in .png, or a .ico that is not one, still has to pass everything else
// here. The magic bytes are the file format's own first words, so a file that
// has them is the binary it claims to be.
const BINARY_SIGNATURES: Record<string, number[]> = {
    '.png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    '.ico': [0x00, 0x00, 0x01, 0x00],
};
let binaries = 0;

function isDeclaredBinary(rel: string): boolean {
    const sig = BINARY_SIGNATURES[path.extname(rel).toLowerCase()];
    if (sig === undefined) return false;
    let head: Buffer;
    try {
        head = fs.readFileSync(path.join(ROOT, rel)).subarray(0, sig.length);
    } catch {
        return false;
    }
    return head.length === sig.length && sig.every((b, i) => head[i] === b);
}

let files: string[];
try {
    files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
        .split('\n').filter(Boolean);
} catch {
    console.error('charcheck: not a git checkout - nothing to scan');
    process.exit(0);
}

let bad = 0;
let scanned = 0;

for (const rel of files) {
    if (isDeclaredBinary(rel)) { binaries++; continue; }
    let text: string;
    try {
        text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    } catch {
        continue; // deleted, or unreadable: not this tool's problem
    }
    if (text.includes(NUL)) {
        // A FAILURE, NOT A SKIP - and it was a skip until 2026-08-17.
        //
        // Printing to stderr and continuing left the exit code at 0, so
        // "charcheck rc=0" reported clean while src/main.ts was not being
        // checked AT ALL. It carried two NUL bytes for two days - a typo that
        // meant to be a space - and nothing failed: not this tool, not the
        // gates, not review. Worse than the missed NUL is that the file
        // silently stopped being scanned for everything else this exists to
        // find.
        //
        // The parent's SILENT skip hid a bug. A loud skip that still exits 0
        // hides it from the only thing CI reads. And a NUL is a defect in its
        // own right: git calls the file binary, grep refuses it, and diffs
        // stop being readable.
        console.error(`${rel}: contains a NUL byte - git treats this file as `
            + 'binary and grep refuses it. Almost always a typo for a space.');
        bad++;
        continue;
    }
    scanned++;

    const lines = text.split('\n');
    for (let n = 0; n < lines.length; n++) {
        const line = lines[n] as string;
        for (let i = 0; i < line.length; i++) {
            const cp = line.codePointAt(i) as number;
            const name = BANNED[cp];
            if (name !== undefined) {
                const col = i + 1;
                const hex = cp.toString(16).toUpperCase().padStart(4, '0');
                console.error(`${rel}:${n + 1}:${col}: ${name} (U+${hex})`);
                bad++;
                break; // one report per line is enough to find it
            }
        }
    }
}

if (bad > 0) {
    console.error(`charcheck: ${bad} offending line${bad === 1 ? '' : 's'} - use " - " and straight quotes`);
    process.exit(1);
}
console.log(`ok - charcheck clean (${scanned} tracked text files, ${binaries} binary by signature)`);
