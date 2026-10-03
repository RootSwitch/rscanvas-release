// The search grammar: one query string -> typed clauses. Pure - no store, no
// SQL, no clock. The engine-facing half (clauses -> WHERE) lives in the
// store's buildWhere, which is the same split the parent never had: filter.js
// went straight to SQL text, which is why its port could silently drop the
// LIKE escaping and why this module exists as the shape filter.js should have
// had.
//
// Ported from syslogcanvas/server/filter.js (pinned @ 9b83911) with the
// decided divergences, each declared in the differential harness:
//
//   host:x / app:x    EXACT here, substring in the parent. The substring form
//                     gets its own operator: host~x / app~x. Which one the
//                     user asked for is explicit rather than guessed, and the
//                     admission rules keep resting on the exact form.
//   ip:10.0.0.0/24    real inet containment, not the parent's text-prefix
//                     match that made "10.0.0." also match 110.0.0.7. The
//                     parent's trailing-dot habit is KEPT because it is
//                     unambiguous: no valid address ends in a dot, so
//                     ip:10.0.0. reads as 10.0.0.0/24 and ip:10.0. as
//                     10.0.0.0/16 - the muscle memory keeps working and gets
//                     the containment semantics it always meant.
//   after:/before:    INTERSECT the mandatory window - tighten, never widen -
//                     so typed dates cannot route around the window ceiling.
//                     (Applied in buildWhere; here they are just clauses.)
//
// Kept from the parent verbatim: tokenizing with quoted phrases, `-`
// negation on any token, severity/facility by name or number with <= >= < >,
// proto, and the FORGIVENESS rule - an unknown key or unparseable value falls
// through to free text, because a token like "12:30:05" is search text that
// happens to contain a colon, not a filter that failed.

import net from 'node:net';

/** Syslog severity names, verbatim from the parent. */
export const SEVERITIES: Record<string, number> = {
    emerg: 0, panic: 0, alert: 1, crit: 2, critical: 2, err: 3, error: 3,
    warning: 4, warn: 4, notice: 5, info: 6, informational: 6, debug: 7,
};

/** Syslog facility names, verbatim from the parent. */
export const FACILITIES: Record<string, number> = {
    kern: 0, user: 1, mail: 2, daemon: 3, auth: 4, syslog: 5, lpr: 6, news: 7,
    uucp: 8, cron: 9, authpriv: 10, ftp: 11, ntp: 12, audit: 13, alert: 14,
    clock: 15, local0: 16, local1: 17, local2: 18, local3: 19, local4: 20,
    local5: 21, local6: 22, local7: 23,
};

export type Cmp = '=' | '<=' | '>=' | '<' | '>';

export type Clause =
    | { kind: 'text'; value: string; negate: boolean }
    | { kind: 'host'; op: 'exact' | 'substring'; value: string; negate: boolean }
    | { kind: 'app'; op: 'exact' | 'substring'; value: string; negate: boolean }
    // Exact only, no ~ form: a procid is an opaque identifier ('1234'), and a
    // substring of one means nothing. Exists because procid is its OWN column
    // rather than flattened into app - see sql/slice7.sql for the defect that
    // flattening caused.
    | { kind: 'procid'; value: string; negate: boolean }
    | { kind: 'ip'; cidr: string; negate: boolean }
    | { kind: 'severity'; op: Cmp; value: number; negate: boolean }
    | { kind: 'facility'; op: Cmp; value: number; negate: boolean }
    | { kind: 'proto'; value: 'syslog' | 'trap'; negate: boolean }
    | { kind: 'after'; ts: Date; negate: boolean }
    | { kind: 'before'; ts: Date; negate: boolean };

/**
 * Split on whitespace, honouring double quotes ("link down" is one token) and
 * a leading - on either form (-err, -"link down"). The parent's regex,
 * unchanged.
 */
export function tokenize(q: string): string[] {
    const tokens: string[] = [];
    const re = /(-?)"([^"]*)"|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(q)) !== null) {
        if (m[2] !== undefined) tokens.push((m[1] ?? '') + m[2]);
        else tokens.push(m[3] as string);
    }
    return tokens.filter((t) => t !== '' && t !== '-');
}

/**
 * "2026-07-01", "2026-07-01T14:30", "2026-07-01 14:30:00" -> a LOCAL-time
 * Date, or null when unparseable. Local because the parent was local and an
 * operator typing a date means the wall clock they are looking at.
 *
 * THE COMPONENTS ARE CHECKED TO ROUND-TRIP, which the parent did not do, and
 * this test caught the difference on its first run. `new Date(2026, 98, 98)`
 * does not fail - it ROLLS OVER - so the parent turns `after:2026-99-99` into
 * 2034-06-07 and filters out every row an operator was looking for. Verified
 * against the pinned copy: buildWhere('after:2026-99-99') binds epoch
 * 2033269200. A typo'd month reads as "there is no data", which is the
 * wrong-answer failure mode this project keeps finding, inherited rather than
 * introduced.
 *
 * A rejected date falls through to free text like any unparseable value (the
 * forgiveness rule), so it returns nothing and the zero-result guidance is
 * what has to explain it - the same responsibility as the host~ hint.
 */
export function parseWhen(s: string): Date | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
    if (!m) return null;
    const [y, mo, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const [hh, mi, ss] = [Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)];
    if (mo < 1 || mo > 12 || day < 1 || day > 31 || hh > 23 || mi > 59 || ss > 59) return null;
    const d = new Date(y, mo - 1, day, hh, mi, ss);
    if (Number.isNaN(d.getTime())) return null;
    // The day still has to round-trip: 2026-02-30 passes every range check
    // above and rolls into March.
    if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== day) return null;
    return d;
}

/**
 * sev:<=3 / sev:err / fac:local0 -> { op, value }, or null when unparseable.
 *
 * IN RANGE OR NOT A LEVEL (2026-10-03, review L16): any digit string was
 * accepted, so sev:<=99999 reached a smallint column and came back as a 500.
 * A number past the scale - severities 0-7, facilities 0-23 - is not a level,
 * so it is search text like any other token the grammar cannot digest.
 */
function parseLeveled(value: string, names: Record<string, number>, max: number): { op: Cmp; value: number } | null {
    const m = /^(<=|>=|<|>)?(.+)$/.exec(value);
    if (!m) return null;
    const op = (m[1] ?? '=') as Cmp;
    const word = (m[2] as string).toLowerCase();
    const n = names[word] !== undefined
        ? names[word]
        : (/^\d{1,3}$/.test(word) ? parseInt(word, 10) : null);
    return n === null || n === undefined || n > max ? null : { op, value: n };
}

/**
 * ip: values that PARSE become containment; everything else falls through to
 * free text. Accepted forms:
 *
 *   10.0.0.9           one address        -> 10.0.0.9/32
 *   10.0.0.0/24        explicit CIDR      -> as given
 *   10.0.0.            the parent's trailing-dot prefix habit. UNAMBIGUOUS:
 *   10.0.              no valid address ends in a dot, so the octet count is
 *   10.                the mask - /24, /16, /8. Without this the old habit
 *                      would fall through to free text and return zero rows
 *                      silently, the same wrong-answer failure the host:
 *                      decision needed guidance to cover.
 *   2001:db8::1        a full IPv6 address -> /128
 *
 * IPv6 prefixes must be written as explicit CIDR - there is no dotted habit
 * to preserve there.
 */
export function parseIpValue(value: string): string | null {
    const slash = value.indexOf('/');
    if (slash > 0) {
        const addr = value.slice(0, slash);
        // DIGITS ONLY (review L16): Number() also takes "0x18", "1e1", " 24"
        // and "" - the last as 0 - and the string went to ::inet verbatim,
        // so 10.0.0.0/0x18 passed here and failed there as a 500.
        const rawBits = value.slice(slash + 1);
        const bits = /^\d{1,3}$/.test(rawBits) ? Number(rawBits) : NaN;
        const fam = net.isIP(addr);
        if (fam === 4 && Number.isInteger(bits) && bits >= 0 && bits <= 32) return value;
        if (fam === 6 && Number.isInteger(bits) && bits >= 0 && bits <= 128) return value;
        return null;
    }
    const fam = net.isIP(value);
    if (fam === 4) return `${value}/32`;
    if (fam === 6) return `${value}/128`;

    // The trailing-dot prefix: 1 to 3 octets, each 0-255, ending in a dot.
    const m = /^(\d{1,3})\.(?:(\d{1,3})\.)?(?:(\d{1,3})\.)?$/.exec(value);
    if (m) {
        const octets = [m[1], m[2], m[3]].filter((o): o is string => o !== undefined);
        if (octets.every((o) => Number(o) <= 255)) {
            const mask = octets.length * 8;
            const padded = [...octets, '0', '0', '0'].slice(0, 4).join('.');
            return `${padded}/${mask}`;
        }
    }
    return null;
}

/**
 * One token -> a clause. Never throws and never returns an error: a value the
 * grammar cannot digest is search text, exactly as the parent treated it.
 */
export function tokenToClause(token: string): Clause {
    let negate = false;
    if (token.startsWith('-')) {
        negate = true;
        token = token.slice(1);
    }

    // Two operator characters: `:` for exact-or-typed, `~` for substring. The
    // earliest one wins so "host~a:b" reads as a substring of "a:b".
    const colon = token.indexOf(':');
    const tilde = token.indexOf('~');
    const sepIdx = tilde > 0 && (colon < 0 || tilde < colon) ? tilde : colon;
    const sep = sepIdx > 0 ? token[sepIdx] : null;
    const key = sepIdx > 0 ? token.slice(0, sepIdx).toLowerCase() : null;
    const value = sepIdx > 0 ? token.slice(sepIdx + 1) : '';

    if (key !== null && value !== '') {
        if (sep === '~') {
            if (key === 'host') return { kind: 'host', op: 'substring', value, negate };
            if (key === 'app') return { kind: 'app', op: 'substring', value, negate };
            // An unknown ~key is search text, same forgiveness as unknown :keys.
        } else {
            if (key === 'host') return { kind: 'host', op: 'exact', value, negate };
            if (key === 'app') return { kind: 'app', op: 'exact', value, negate };
            if (key === 'procid' || key === 'pid') return { kind: 'procid', value, negate };
            if (key === 'ip') {
                const cidr = parseIpValue(value);
                if (cidr !== null) return { kind: 'ip', cidr, negate };
                // Unparseable: falls through to free text below.
            }
            if (key === 'sev' || key === 'severity') {
                const lv = parseLeveled(value, SEVERITIES, 7);
                if (lv) return { kind: 'severity', op: lv.op, value: lv.value, negate };
            }
            if (key === 'fac' || key === 'facility') {
                const lv = parseLeveled(value, FACILITIES, 23);
                if (lv) return { kind: 'facility', op: lv.op, value: lv.value, negate };
            }
            if (key === 'proto') {
                const v = value.toLowerCase();
                if (v === 'syslog' || v === 'trap') return { kind: 'proto', value: v, negate };
            }
            if (key === 'after' || key === 'since') {
                const ts = parseWhen(value);
                if (ts !== null) return { kind: 'after', ts, negate };
            }
            if (key === 'before' || key === 'until') {
                const ts = parseWhen(value);
                if (ts !== null) return { kind: 'before', ts, negate };
            }
        }
    }

    return { kind: 'text', value: token, negate };
}

/** Whole query string -> clauses, ANDed by the consumer. */
export function parseQuery(q: string): Clause[] {
    return tokenize(q).map(tokenToClause);
}
