// Parse every browser script AS A MODULE, which `node --check` does not do.
//
//   node tools/check-module-syntax.mjs --check public
//   node tools/check-module-syntax.mjs --self-test
//
// WHY. On 2026-08-22 a second `function fmtDuration` landed in public/app.js.
// `node --check public/app.js` passed - it parses a .js file as a sloppy-mode
// script, where a duplicate declaration is legal - and the browser, loading
// the same file as an ES module, threw "Identifier has already been declared"
// at load and rendered nothing. A gate that parses in the wrong mode is a
// gate that passes the exact class of bug it exists to catch. This copies each
// file to a temporary .mjs and asks node to check THAT, so the parse mode is
// the browser's.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function checkModule(src) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rscanvas-modcheck-'));
    const f = path.join(dir, 'x.mjs');
    fs.writeFileSync(f, src);
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    fs.rmSync(dir, { recursive: true, force: true });
    return r.status === 0 ? null : (r.stderr || 'parse failed').split('\n').find((l) => /Error/.test(l)) || 'parse failed';
}

const mode = process.argv[2];
if (mode === '--self-test') {
    let pass = 0, fail = 0;
    const ok = (l, c) => { c ? (pass++, console.log(`  ok   ${l}`)) : (fail++, console.log(`  FAIL ${l}`)); };
    ok('a duplicate declaration FAILS as a module', checkModule('function a() {}\nfunction a() {}\n') !== null);
    ok('and the same text PASSES node --check as a script - the gap this exists for',
        (() => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rscanvas-modcheck-')); const f = path.join(d, 'x.js');
            fs.writeFileSync(f, 'function a() {}\nfunction a() {}\n');
            const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' }); fs.rmSync(d, { recursive: true, force: true }); return r.status === 0; })());
    ok('a clean module passes', checkModule('import fs from "node:fs";\nexport const x = 1;\n') === null);
    ok('a plain syntax error fails', checkModule('const = ;\n') !== null);
    console.log(`${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}
if (mode === '--check') {
    const dir = process.argv[3] || 'public';
    let bad = 0;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
        const err = checkModule(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (err) { bad++; console.log(`  FAIL ${dir}/${f}: ${err}`); }
    }
    console.log(bad === 0 ? `ok - every script in ${dir}/ parses as an ES module` : `${bad} script(s) do not parse as modules`);
    process.exit(bad === 0 ? 0 : 1);
}
console.log('usage: --check <dir> | --self-test'); process.exit(2);
