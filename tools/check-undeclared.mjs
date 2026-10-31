#!/usr/bin/env node
// Refuse a name the web client uses and never declares.
//
// AN UNDECLARED NAME IN A PAGE SCRIPT IS OFTEN NOT AN ERROR, and that is the
// whole reason this check exists. A browser makes every element with an id a
// global of that name, so a script that says `q` where it meant a local
// called q does not throw: it reads the Logs tab's search box, an
// HTMLInputElement, and carries on. Something plausible appears.
//
// WHAT IT COST. The device list's empty message was `nothing matches
// "${q}"`, with q the filter text. On 2026-09-28 the filter became
// parseDeviceFilter(...) and the local q went with it; the template stayed.
// From then until 2026-10-31 a fresh install's empty device list read
// `nothing matches "[object HTMLInputElement]"`, and so did every filter
// that matched nothing - found by walking a fresh install, not by a test,
// because every lab and production fleet had devices and every filter tried
// matched one.
//
// HOW. TypeScript, already the type check's, reads public/*.js as checked
// JavaScript with the DOM's declarations, and only its "cannot find name"
// diagnostics are kept (2304, 2552, 2663): everything else it would say about
// untyped page code is noise here, and a missing name is never noise. Named
// element access is not in the DOM's declarations, which is exactly why the
// element-id globals are caught.

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const CODES = new Set([2304, 2552, 2663]);
const OPTIONS = {
    allowJs: true, checkJs: true, noEmit: true, strict: false, skipLibCheck: true,
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'], types: [],
};

/** files: [{ name, text }] - analysed in memory, so the self-test needs no disk. */
export function analyse(files) {
    const byName = new Map(files.map((f) => [path.resolve(f.name), f.text]));
    const host = ts.createCompilerHost(OPTIONS);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (name, lang, ...rest) => {
        const text = byName.get(path.resolve(name));
        return text !== undefined ? ts.createSourceFile(name, text, lang) : getSourceFile(name, lang, ...rest);
    };
    const fileExists = host.fileExists.bind(host);
    host.fileExists = (name) => byName.has(path.resolve(name)) || fileExists(name);
    const readFile = host.readFile.bind(host);
    host.readFile = (name) => byName.get(path.resolve(name)) ?? readFile(name);
    const program = ts.createProgram([...byName.keys()], OPTIONS, host);
    const missing = new Map();
    for (const d of ts.getPreEmitDiagnostics(program)) {
        if (!CODES.has(d.code) || d.file === undefined) continue;
        const { line } = d.file.getLineAndCharacterOfPosition(d.start ?? 0);
        const m = { rel: path.relative(process.cwd(), d.file.fileName).replace(/\\/g, '/'), line: line + 1,
            message: ts.flattenDiagnosticMessageText(d.messageText, ' ') };
        missing.set(`${m.rel}:${m.line} ${m.message}`, m);
    }
    return [...missing.values()];
}

function selfTest() {
    let ok = true;
    const check = (label, files, want) => {
        const got = analyse(files).map((m) => /'([^']+)'/.exec(m.message)?.[1]).sort().join(',');
        if (got === want) console.log(`  ok   ${label}`);
        else { ok = false; console.log(`  FAIL ${label}: got [${got}] want [${want}]`); }
    };
    check('a declared local passes',
        [{ name: 'st/a.js', text: 'export function f(el) { const q = el.value; return `nothing matches "${q}"`; }' }], '');
    check('browser globals pass',
        [{ name: 'st/a.js', text: 'export const w = innerWidth + document.title.length; localStorage.getItem("x");' }], '');
    check('an import from a sibling passes',
        [{ name: 'st/a.js', text: "import { g } from './b.js'; export const v = g();" },
            { name: 'st/b.js', text: 'export function g() { return 1; }' }], '');
    check('the real defect: a dropped local that an element id would answer',
        [{ name: 'st/a.js', text: "export function f() { const filter = document.getElementById('device-filter'); return filter && `nothing matches \"${q}\"`; }" }],
        'q');
    check('a misspelt function is caught',
        [{ name: 'st/a.js', text: 'function renderRoster() {} export function f() { renderRostr(); }' }], 'renderRostr');
    return ok;
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) process.exit(selfTest() ? 0 : 1);

const root = args[args.indexOf('--check') + 1] ?? 'public';
const files = fs.readdirSync(root).filter((f) => f.endsWith('.js'))
    .map((f) => ({ name: path.join(root, f), text: fs.readFileSync(path.join(root, f), 'utf8') }));
const missing = analyse(files);
if (missing.length > 0) {
    console.error('\nREFUSING: the web client uses a name it never declares.\n');
    console.error('In a page this need not throw: every element with an id is a global of');
    console.error('that name, so a lost local reads an element instead, and the page says');
    console.error('"[object HTMLInputElement]" where it meant what was typed.\n');
    for (const m of missing) console.error(`  ${m.rel}:${m.line}  ${m.message}`);
    process.exit(1);
}
console.log(`ok - every name in ${files.length} client scripts is declared`);
