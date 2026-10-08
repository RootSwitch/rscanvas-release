// Every non-interface entity query says which SOURCE of entity it means.
//
// The class this guards (slice 57, 2026-10-05, found while planning service
// checks): until then every entity was read from an SNMP agent, so the
// store told sensors from interfaces with `kind <> 'if'` - and that
// predicate silently meant "a sensor an SNMP agent serves". The first
// entity RSCanvas measures itself (a service check, a path test) would have
// met five such queries and been taken for an SNMP sensor by every one: the
// sensor poller walking its definition as an OID, the backfill counting it
// as inventory, the threshold scan judging it by the device's poll interval.
// DIGEST section 6's lesson, one table over from reach_check: a predicate
// written before the values it would meet fails quiet when they arrive.
//
// The rule: a SQL template literal that selects entities by "not an
// interface" must also name the source it means - `source = 'snmp'`,
// `source = 'probe'`, or `source IN ('snmp', 'probe')` when it truly means
// both, which is then a decision someone wrote down rather than a default
// nobody noticed. When the kind is qualified (`e.kind`) the source must
// carry the same qualifier, so a join cannot satisfy the rule with another
// table's column.
//
// Not a SQL parser, deliberately: TypeScript is tokenised just far enough
// to find template literals while skipping comments, strings and regular
// expressions, and SQL comments inside a literal are removed before
// matching, so prose about the rule - including this file's - never trips
// it.
//
//   node tools/check-entity-source.mjs --self-test
//   node tools/check-entity-source.mjs --check src

import fs from 'node:fs';
import path from 'node:path';

function walkDir(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walkDir(p, out);
        else if (/\.ts$/.test(e.name)) out.push(p);
    }
    return out;
}

/** Characters after which a `/` starts a regular expression, not a division. */
const REGEX_AFTER = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

/**
 * The template literals in a TypeScript source, each with the line it starts
 * on and its text with every `${...}` replaced by a space (an interpolation
 * is code, not SQL). `ok` is false when the scan ended inside a literal,
 * comment or string - the tokeniser lost its place, and a blind checker
 * must say so rather than pass.
 */
export function templateLiterals(src) {
    const out = [];
    let line = 1;
    const n = src.length;

    // Reads one template literal starting AFTER its opening backtick, and
    // returns the index after its closing one (or -1 if unterminated).
    function readTemplate(start, startLine) {
        let j = start;
        let text = '';
        while (j < n) {
            const c = src[j];
            if (c === '\\') { text += src.slice(j, j + 2); if (src[j + 1] === '\n') line++; j += 2; continue; }
            if (c === '`') { out.push({ line: startLine, text }); return j + 1; }
            if (c === '$' && src[j + 1] === '{') {
                const end = skipCode(j + 2, '}');
                if (end === -1) return -1;
                // A space for the code, and its line breaks kept, so a
                // finding after a multi-line interpolation names its line.
                text += ' ' + src.slice(j, end).replace(/[^\n]/g, '');
                j = end;
                continue;
            }
            if (c === '\n') line++;
            text += c;
            j++;
        }
        return -1;
    }

    // Skips code until `close` at depth zero (used for `${...}`), returning
    // the index after it; or, with close === null, scans to the end.
    function skipCode(start, close) {
        let j = start;
        let depth = 0;
        let last = '';
        while (j < n) {
            const c = src[j];
            const d = src[j + 1];
            if (c === '\n') { line++; j++; continue; }
            if (c === ' ' || c === '\t' || c === '\r') { j++; continue; }
            if (c === '/' && d === '/') { while (j < n && src[j] !== '\n') j++; continue; }
            if (c === '/' && d === '*') {
                const e = src.indexOf('*/', j + 2);
                if (e === -1) return -1;
                for (let k = j; k < e; k++) if (src[k] === '\n') line++;
                j = e + 2;
                continue;
            }
            if (c === '\'' || c === '"') {
                let k = j + 1;
                while (k < n && src[k] !== c) {
                    if (src[k] === '\\') k++;
                    else if (src[k] === '\n') return -1;
                    k++;
                }
                if (k >= n) return -1;
                j = k + 1;
                last = c;
                continue;
            }
            if (c === '`') {
                const e = readTemplate(j + 1, line);
                if (e === -1) return -1;
                j = e;
                last = '`';
                continue;
            }
            if (c === '/' && (REGEX_AFTER.has(last) || /\b(?:return|typeof|case|of|in)$/.test(src.slice(Math.max(0, j - 8), j).trimEnd()))) {
                let k = j + 1;
                let inClass = false;
                while (k < n) {
                    const r = src[k];
                    if (r === '\\') { k += 2; continue; }
                    if (r === '\n') return -1;
                    if (r === '[') inClass = true;
                    else if (r === ']') inClass = false;
                    else if (r === '/' && !inClass) break;
                    k++;
                }
                if (k >= n) return -1;
                j = k + 1;
                while (j < n && /[a-z]/.test(src[j])) j++;
                last = '/';
                continue;
            }
            if (close !== null) {
                if (c === '{') depth++;
                else if (c === '}') {
                    if (depth === 0) return j + 1;
                    depth--;
                }
            }
            last = c;
            j++;
        }
        return close === null ? n : -1;
    }

    const end = skipCode(0, null);
    return { ok: end !== -1, literals: out };
}

/** SQL comments removed; line breaks kept so offsets still count lines. */
export function stripSqlComments(sql) {
    return sql
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/--[^\n]*/g, (m) => ' '.repeat(m.length));
}

/** "Not an interface", in each spelling SQL allows for it. Group 1 or 2 is
 *  the qualifier when there is one. */
const NOT_IF = [
    /\b(?:([A-Za-z_]\w*)\.)?kind\s*(?:<>|!=|\bIS\s+DISTINCT\s+FROM\b)\s*'if'/gi,
    /'if'\s*(?:<>|!=)\s*(?:([A-Za-z_]\w*)\.)?kind\b/gi,
    /\b(?:([A-Za-z_]\w*)\.)?kind\s+NOT\s+IN\s*\([^)]*'if'[^)]*\)/gi,
    /\bNOT\s*\(\s*(?:([A-Za-z_]\w*)\.)?kind\s*=\s*'if'\s*\)/gi,
];

function hasSource(sql, qualifier) {
    const q = qualifier ? `\\b${qualifier}\\.` : '(?<![\\w.])';
    return new RegExp(`${q}source\\s*(?:=|<>|!=|\\bIN\\b|\\bIS\\b)`, 'i').test(sql);
}

/** Findings for one file's text: [{ line, predicate }]. */
export function scanSource(src) {
    const { ok, literals } = templateLiterals(src);
    if (!ok) return { ok: false, findings: [] };
    const findings = [];
    let predicates = 0;
    for (const lit of literals) {
        const sql = stripSqlComments(lit.text);
        for (const re of NOT_IF) {
            for (const m of sql.matchAll(re)) {
                predicates++;
                const qualifier = m[1] ?? m[2] ?? null;
                if (!hasSource(sql, qualifier)) {
                    findings.push({
                        line: lit.line + sql.slice(0, m.index).split('\n').length - 1,
                        predicate: m[0].replace(/\s+/g, ' '),
                    });
                }
            }
        }
    }
    return { ok: true, findings, predicates };
}

function selfTest() {
    let pass = 0, fail = 0;
    const ok = (l) => { pass++; console.log(`  ok   ${l}`); };
    const bad = (l, d) => { fail++; console.log(`  FAIL ${l}`, d ?? ''); };
    const refuses = (label, src, count = 1) => {
        const r = scanSource(src);
        if (r.ok && r.findings.length === count) ok(label);
        else bad(label, JSON.stringify(r));
    };
    const passes = (label, src) => refuses(label, src, 0);

    refuses('a bare `kind <> \'if\'` is REFUSED',
        "q(`SELECT id FROM entities WHERE device_id = $1 AND kind <> 'if'`)");
    passes('the same query naming its source passes',
        "q(`SELECT id FROM entities WHERE device_id = $1 AND kind <> 'if' AND source = 'snmp'`)");
    passes('`source IN (\'snmp\', \'probe\')` - both, written down - passes',
        "q(`SELECT id FROM entities WHERE kind <> 'if' AND source IN ('snmp', 'probe')`)");
    passes('a qualified kind with the SAME qualifier on source passes',
        "q(`SELECT 1 FROM entities e JOIN devices d ON d.id = e.device_id\n WHERE e.kind <> 'if' AND e.source = 'snmp'`)");
    refuses('a qualified kind is not satisfied by ANOTHER table\'s source',
        "q(`SELECT 1 FROM entities e JOIN feeds f ON f.id = e.id WHERE e.kind <> 'if' AND f.source = 'snmp'`)");
    refuses('a qualified kind is not satisfied by a bare source either',
        "q(`SELECT 1 FROM entities e WHERE e.kind <> 'if' AND source = 'snmp'`)");
    refuses('`!=` is the same predicate', "q(`SELECT 1 FROM entities WHERE kind != 'if'`)");
    refuses('`\'if\' <> kind` is the same predicate', "q(`SELECT 1 FROM entities WHERE 'if' <> kind`)");
    refuses('`kind NOT IN (...\'if\'...)` is the same predicate',
        "q(`SELECT 1 FROM entities WHERE kind NOT IN ('if', 'fan')`)");
    refuses('`NOT (kind = \'if\')` is the same predicate', "q(`SELECT 1 FROM entities WHERE NOT (kind = 'if')`)");
    refuses('`kind IS DISTINCT FROM \'if\'` is the same predicate',
        "q(`SELECT 1 FROM entities WHERE kind IS DISTINCT FROM 'if'`)");
    passes('an INTERFACE query is not this rule\'s business', "q(`SELECT 1 FROM entities WHERE kind = 'if'`)");
    passes('the predicate inside a SQL comment does not trip it',
        "q(`SELECT 1 FROM entities -- used to say kind <> 'if' here\n WHERE kind = 'if'`)");
    refuses('a source predicate inside a SQL comment does not satisfy it',
        "q(`SELECT 1 FROM entities WHERE kind <> 'if' /* AND source = 'snmp' */`)");
    passes('prose in TypeScript comments never trips it',
        "// the store says `kind <> 'if'` for sensors\n/** and `kind <> 'if'` again */\nconst x = 1;");
    passes('a backtick inside a quoted string does not open a literal',
        "const s = 'a ` b'; const t = \"kind <> 'if' ` here\"; q(`SELECT 1 FROM entities WHERE kind = 'if'`)");
    refuses('a backtick inside a REGEX does not derail the scan',
        "const re = /`[^`]*`/g; q(`SELECT 1 FROM entities WHERE kind <> 'if'`)");
    passes('division is not taken for a regex', "const r = a / b; const s = c / d; q(`SELECT ${a / 2} FROM x`)");
    refuses('a nested template inside ${...} is skipped and the rest still read',
        "q(`SELECT ${cols.map((c) => `e.${c}`).join(', ')} FROM entities e WHERE e.kind <> 'if'`)");
    passes('identifiers that merely contain the words do not count',
        "q(`SELECT 1 FROM t WHERE reach_kind <> 'if' AND resource = 'snmp'`)");
    refuses('`resource =` does not stand in for `source =`',
        "q(`SELECT 1 FROM entities WHERE kind <> 'if' AND resource = 'snmp'`)");

    const two = "a(`SELECT 1 FROM entities WHERE kind <> 'if' AND source = 'snmp'`);\n\n"
        + "b(`SELECT 1\n  FROM entities\n WHERE kind <> 'if'`);";
    const r2 = scanSource(two);
    if (r2.ok && r2.findings.length === 1 && r2.findings[0].line === 5) ok('the finding names the right LINE of the right statement');
    else bad('line attribution', JSON.stringify(r2));

    const blind = scanSource("q(`SELECT 1 FROM entities WHERE kind <> 'if'");
    if (!blind.ok) ok('an unterminated literal is reported as BLIND, not passed');
    else bad('an unterminated literal passed', JSON.stringify(blind));

    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    return fail === 0 ? 0 : 1;
}

function check(dir) {
    const files = walkDir(dir);
    let predicates = 0;
    let bad = 0;
    for (const f of files) {
        const r = scanSource(fs.readFileSync(f, 'utf8'));
        if (!r.ok) {
            console.error(`  ${f}: the scan lost its place (an unterminated literal, string or comment) - the checker is blind here, which is a failure`);
            bad++;
            continue;
        }
        predicates += r.predicates;
        for (const x of r.findings) {
            console.error(`  ${f}:${x.line}: \`${x.predicate}\` with no source predicate in the same statement`);
            bad++;
        }
    }
    if (bad > 0) {
        console.error(`\nREFUSING: ${bad} entity quer${bad === 1 ? 'y' : 'ies'} select "not an interface" without saying which source.\n`);
        console.error('Entities are SNMP sensors (source = \'snmp\') or things RSCanvas measures itself');
        console.error('(source = \'probe\'). A query that means sensors must say AND source = \'snmp\'; one');
        console.error('that truly means both says source IN (\'snmp\', \'probe\'). See sql/slice57.sql.');
        return 1;
    }
    console.log(`ok - every non-interface entity query names its source (${predicates} predicate(s) in ${files.length} files)`);
    return 0;
}

const arg = process.argv[2];
if (arg === '--self-test') process.exit(selfTest());
else if (arg === '--check') process.exit(check(process.argv[3] ?? 'src'));
else {
    console.error('usage: check-entity-source.mjs --self-test | --check <srcdir>');
    process.exit(2);
}
