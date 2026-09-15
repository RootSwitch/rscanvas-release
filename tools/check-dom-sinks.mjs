#!/usr/bin/env node
// Refuse HTML-injection sinks in the web client.
//
// app.js opens with the rule: "textContent everywhere, never innerHTML with
// data in it" - the SNMPCanvas XSS lesson, where device-controlled strings
// (sysName, ifAlias, syslog bodies) reach the screen and must stay TEXT the
// whole way. This file is what turns that comment into a property: a sink
// added in month six, by someone who never read the comment, fails the build
// instead of shipping.
//
// U0's role in the XSS story (UI-PLAN): this structural guard plus the
// escape discipline it enforces IS the rendered-page harness's foundation.
// U1 adds the hostile round trip - MOCK_EVIL strings through the real fleet
// and collector, asserted on the rendered DOM - on top of a client this
// check has already proven sink-free.
//
// Sinks refused: innerHTML, outerHTML, insertAdjacentHTML, document.write,
// and DOMParser.parseFromString. To allow one deliberately (a future
// markdown-rendering panel, say): DOM-SINK-OK: <reason> on the line or the
// comment block above, reason required - same contract as WRITE-IN-LOOP-OK.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SINK = /\.\s*(innerHTML|outerHTML)\s*=|\.\s*(insertAdjacentHTML|write|writeln|parseFromString)\s*\(/;
// ATTRIBUTE SINKS (2026-08-31, independent review P2). The original rule
// covered only markup sinks - innerHTML and friends. It did not look at
// `.href =`, `.src =`, setAttribute with a dangerous name, style.cssText,
// eval or new Function.
//
// A sweep of all seven client files found NOTHING device-controlled reaching
// any of them: every href is a literal, a server-side path, an
// encodeURIComponent template, or a URL object. So the invariant held by
// DISCIPLINE. This file's own header says why that is not enough - "a sink
// added in month six, by someone who never read the comment, fails the build
// instead of shipping" - and a `javascript:` URL reaching a.href from an
// ifAlias is the same class of defect as an innerHTML.
//
// SAFE FORMS PASS WITHOUT A MARKER, which is what keeps this from crying
// wolf: a literal or template beginning `/`, `#`, `./` or `${location.origin}`
// cannot carry a scheme, so it is not a navigation an attacker chose. Anything
// built from a variable takes the same DOM-SINK-OK marker the markup sinks
// already use, with a reason - four sites needed one, and writing them was
// the sweep.
const ATTR_SINK = new RegExp(
    String.raw`\.\s*(href|src)\s*=(?!=)`
    + String.raw`|\.\s*(cssText)\s*=`
    + String.raw`|\bsetAttribute\s*\(\s*(?!['"](?:d|x|y|x1|x2|y1|y2|width|height|viewBox|fill|stroke|class|id|type|role|aria-[a-z-]+|transform|points|r|cx|cy|rx|ry|stroke-width|stroke-linecap|stroke-linejoin|fill-rule|clip-rule|stroke-miterlimit|colspan|rowspan|placeholder|value|title|tabindex|data-[a-z-]+)['"]\s*,)`
    + String.raw`|\b(eval)\s*\(|new\s+(Function)\s*\(`,
);

/** A right-hand side that cannot carry a scheme, so it needs no marker. */
const SAFE_RHS = new RegExp(
    String.raw`=\s*(['"` + '`' + String.raw`])(?:#|\/|\.\/)`
    + String.raw`|=\s*` + '`' + String.raw`\$\{location\.origin\}`,
);

const OK = /DOM-SINK-OK:\s*\S/;

function allowedAt(lines, i) {
    if (OK.test(lines[i])) return true;
    for (let j = i - 1; j >= 0; j--) {
        const prev = lines[j].trim();
        if (!(prev.startsWith('//') || prev.startsWith('*') || prev.startsWith('/*'))) return false;
        if (OK.test(lines[j])) return true;
    }
    return false;
}

function scan(src, rel) {
    const lines = src.split(/\r?\n/);
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
        const bare = lines[i].replace(/\/\/.*$/, '');
        const m = SINK.exec(bare);
        if (m && !allowedAt(lines, i)) {
            hits.push({ rel, line: i + 1, sink: m[1] ?? m[2] });
        }
        const a = ATTR_SINK.exec(bare);
        if (a && !SAFE_RHS.test(bare) && !allowedAt(lines, i)) {
            hits.push({ rel, line: i + 1, sink: a.slice(1).find((g) => g !== undefined) ?? 'setAttribute' });
        }
    }
    return hits;
}

function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.(js|mjs|html)$/.test(name)) out.push(p);
    }
    return out;
}

function selfTest() {
    let pass = 0, fail = 0;
    const cases = [
        ['flags innerHTML assignment', 'el.innerHTML = rows.join("");\n', 1],
        ['flags outerHTML assignment', 'el.outerHTML = x;\n', 1],
        ['flags insertAdjacentHTML', 'el.insertAdjacentHTML("beforeend", s);\n', 1],
        ['flags document.write', 'document.write(s);\n', 1],
        ['does NOT flag textContent', 'el.textContent = hostileString;\n', 0],
        ['does NOT flag createElement/append', 'const td = document.createElement("td");\ntd.append(x);\n', 0],
        ['does NOT flag the word innerHTML in a comment', '// never use innerHTML with data\nel.textContent = x;\n', 0],
        ['honours a reasoned marker', '// DOM-SINK-OK: static template, no data interpolated\nel.innerHTML = TEMPLATE;\n', 0],
        ['REFUSES a bare marker', '// DOM-SINK-OK:\nel.innerHTML = TEMPLATE;\n', 1],
        ['reads innerHTML on the RIGHT side as a read, not a sink', 'const s = el.innerHTML;\n', 0],
        // ---- attribute sinks (review P2) --------------------------------
        // THE DEFECT THIS EXISTS FOR: a javascript: URL from a device string
        // reaching an anchor. Same class as an innerHTML, and invisible to
        // the markup rules above.
        ['flags a href built from a variable', 'a.href = deviceUrl;\n', 1],
        ['flags a src built from a variable', 'img.src = row.ifAlias;\n', 1],
        ['flags style.cssText', 'el.style.cssText = s;\n', 1],
        ['flags eval', 'const v = eval(expr);\n', 1],
        ['flags new Function', 'const f = new Function(body);\n', 1],
        ['flags setAttribute with a NAME from a variable', 'el.setAttribute(k, v);\n', 1],
        ['flags setAttribute("onclick", ...)', "el.setAttribute('onclick', h);\n", 1],
        ['flags setAttribute("href", ...)', "a.setAttribute('href', u);\n", 1],
        // The safe forms pass WITHOUT a marker, which is what stops this
        // crying wolf. A literal that begins with / or # cannot carry a
        // scheme, so it is not a navigation anyone chose but us.
        ['a root-relative literal href is fine', "a.href = '/wall.html';\n", 0],
        ['a hash literal href is fine', "link.href = '#';\n", 0],
        ['an encodeURIComponent template on a / path is fine',
            'a.href = `/#device=${encodeURIComponent(d)}`;\n', 0],
        ['a same-origin template is fine', 'a.href = `${location.origin}/wall.html`;\n', 0],
        ['a geometry setAttribute is fine without a marker',
            "el.setAttribute('x1', fx);\n", 0],
        ['a data- attribute is fine', "el.setAttribute('data-name', n);\n", 0],
        ['comparison is not assignment', 'if (a.href === want) return;\n', 0],
        ['a reasoned marker covers a variable href',
            '// DOM-SINK-OK: URL object, same origin\nlocation.href = url.toString();\n', 0],
    ];
    for (const [name, src, want] of cases) {
        const got = scan(src, 'fixture.js').length;
        if (got === want) { pass++; console.log(`  ok   ${name}`); }
        else { fail++; console.log(`  FAIL ${name} - expected ${want}, got ${got}`); }
    }
    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    return fail === 0;
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) process.exit(selfTest() ? 0 : 1);

const root = args[args.indexOf('--check') + 1] ?? 'public';
const found = [];
for (const f of walk(root)) found.push(...scan(readFileSync(f, 'utf8'), f.replace(/\\/g, '/')));

if (found.length > 0) {
    console.error('\nREFUSING: an HTML-injection sink in the web client.\n');
    console.error('Device-controlled strings (hostnames, ifAlias, syslog bodies) reach these');
    console.error('pages. They stay TEXT the whole way: textContent, createElement, append.');
    console.error('If a sink is genuinely safe, add DOM-SINK-OK: <reason> beside it.\n');
    for (const h of found) console.error(`  ${h.rel}:${h.line}  ${h.sink}`);
    process.exit(1);
}
console.log('ok - no HTML-injection sinks in the web client');
