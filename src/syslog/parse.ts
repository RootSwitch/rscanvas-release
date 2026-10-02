// Syslog message parsing, ported from syslogcanvas/server/syslog.js.
//
// PORTED, NOT REWRITTEN, and deliberately so. The RFC part of this is easy;
// the Cisco part is where the work went, and it took real device output to get
// right. IOS, IOS-XE, NX-OS, CatOS and ASA are all called "syslog", none of
// them are RFC 3164, and none of them agree with each other. Rewriting this
// would be a regression with no upside.
//
// The rule that outranks everything here: NEVER DROP A DATAGRAM. Anything
// unparseable is stored whole with whatever fields did parse. That invariant is
// why the parent collector survives dialects that break stricter tools, and it
// is the only thing that makes a better parser applicable retroactively.
//
// Two deliberate changes from the parent, both about representation rather
// than behaviour:
//
//   1. Times are Date objects rather than epoch seconds. The parent stored
//      integer seconds because its SQLite schema did; `ts` here is a
//      timestamptz and the partition key, and it keeps MILLISECOND precision.
//      At 5,000 datagrams a second, second-resolution receive times would
//      discard ordering information that cannot be recovered later - which
//      handoff section 0b calls the one genuinely irreversible kind of
//      decision.
//   2. `proto` is set explicitly, because this worker owns two sockets and a
//      trap must be distinguishable from a syslog message that resembles one.
//
// The parser itself - every regex, every guard, the order they run in - is
// carried across unchanged. Where a comment explains why something is written
// the way it is, that comment came with it and should not be edited away.

export interface ParsedMessage {
    /** Receive time, ours, millisecond precision. Never the device's claim. */
    ts: Date;
    /** The device's own timestamp, second resolution, absent when not sent. */
    msgTs: Date | null;
    sourceIp: string | null;
    proto: string;
    facility: number | null;
    severity: number | null;
    host: string | null;
    app: string | null;
    /**
     * RFC 5424 PROCID / RFC 3164's tag[pid], kept as its OWN field. The first
     * version concatenated it back into app ('sshd[1234]'), which exploded
     * app's cardinality (45,140 distinct values on the demo corpus instead of
     * dozens) and broke exact app: - `app:sshd` matched the lines logged
     * without a procid and silently missed every sshd[1234]. Some rows, not
     * zero, so the miss read as a complete answer.
     */
    procid: string | null;
    msg: string;
    raw: string;
}

const MONTHS: Record<string, number> = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

// "Jul 18 12:00:05" (RFC 3164, no year) -> a Date.
//
// The year is inferred, because RFC 3164 does not carry one. Current year
// unless that lands far in the future, in which case last year.
//
// BOTH DIRECTIONS ARE CORRECTED, which is a change from the parent. It moved a
// stamp more than 2 days in the FUTURE back a year - the Dec 31 message read on
// Jan 1 - but had no mirror case. A device clock a few minutes FAST, sending
// "Jan 1 00:03" while the server is still at Dec 31 23:59, constructed Jan 1 of
// the CURRENT year: about 365 days in the past, with no rule firing. That
// device's msg_ts stayed a year wrong until midnight passed.
//
// It matters more here than it did upstream. The parent stored epoch seconds it
// never re-interpreted; these land in a timestamptz that filters and charts
// read. `ts` - the partition key and the collector's own receive time - is
// unaffected either way, so the damage was confined to display and msg_ts
// filtering, which is why this ranks where it does.
//
// UTC throughout. The parent used the local-time Date constructor, which is
// the same class of bug as finding 10 one layer up: two servers in different
// zones would derive different msg_ts from identical bytes.
const FUTURE_SLACK_MS = 2 * 86400 * 1000;

function parse3164Time(
    mon: number, day: number, h: number, m: number, s: number, now: Date,
): Date {
    const year = now.getUTCFullYear();
    const d = new Date(Date.UTC(year, mon, day, h, m, s));
    const delta = d.getTime() - now.getTime();

    // Too far ahead: a December stamp read in January. Last year.
    if (delta > FUTURE_SLACK_MS) {
        return new Date(Date.UTC(year - 1, mon, day, h, m, s));
    }
    // Too far behind: a January stamp read in December, from a clock running
    // slightly fast. Next year. Anything within half a year of now is taken as
    // this year, so an ordinary old message is not dragged forward.
    if (delta < -182 * 86400 * 1000) {
        return new Date(Date.UTC(year + 1, mon, day, h, m, s));
    }
    return d;
}

// RFC 5424 STRUCTURED-DATA: "-" or one-or-more [id k="v" ...] blocks where
// `\]` is an escaped bracket. Returns the index just past the SD element.
function skipStructuredData(s: string, i: number): number {
    if (s[i] === '-') return i + 1;
    while (s[i] === '[') {
        i++;
        let inQuotes = false;
        while (i < s.length) {
            const c = s[i];
            if (c === '\\') { i += 2; continue; }
            if (c === '"') inQuotes = !inQuotes;
            else if (c === ']' && !inQuotes) { i++; break; }
            i++;
        }
    }
    return i;
}

// The one thing every Cisco dialect shares. Anchoring on this rather than on
// the header is what makes the family tractable: the headers all differ, the
// tag never does.
const CISCO_MNEMONIC = /%([A-Z][A-Z0-9_]*)-(\d)-([A-Z0-9_]+)\s*:/;

// Everything Cisco puts BEFORE the mnemonic, in whatever order that model
// happens to use. Peeled off in order of how confidently each part can be
// recognised, so the leftovers are the hostname or nothing at all.
// Returns { host, msgTs } if the header is ENTIRELY accounted for, or null if
// anything unexplained is left over.
//
// That distinction is the whole guard. "%SYS-5-CONFIG_I:" is not proof of a
// Cisco device - it also appears inside ordinary prose, e.g. an operator note
// relayed through syslog. Position alone cannot separate the two. What can is
// that a real Cisco header consists only of parts we can name; once the
// sequence number and timestamp are removed, at most a hostname may remain.
// Leftover prose means this was a normal message that happened to quote a
// mnemonic, and it belongs to the RFC 3164 path.
function parseCiscoHeader(
    header: string, now: Date,
): { host?: string; msgTs?: Date } | null {
    const row: { host?: string; msgTs?: Date } = {};
    let h = header.trim();
    h = h.replace(/^\d+:\s*/, '');                          // IOS sequence number
    h = h.replace(/(^|\s)[*.](?=[A-Z][a-z]{2}\s)/g, '$1');  // * unsynced clock, . synced
    // Mmm dd [yyyy] hh:mm:ss[.frac] [TZ] - the optional YEAR is ASA's, and is
    // exactly what stops the RFC 3164 matcher from recognising an ASA line.
    // The trailing timezone must be UPPERCASE and sit immediately before a
    // colon or the end of the header. Written loosely it swallows hostnames:
    // in "14:30:00 asa-fw : %ASA-..." a lax [A-Za-z]{2,5} matches the "asa" of
    // "asa-fw" and the host is lost, leaving "-fw" behind. A real zone reads
    // "UTC:" or "CDT:" with no space; a hostname reads "asa-fw :" with one.
    const ts = /([A-Z][a-z]{2})\s+(\d{1,2})(?:\s+(\d{4}))?\s+(\d{1,2}):(\d{2}):(\d{2})(?:\.\d+)?(?:\s+[A-Z]{2,5}(?=:|\s*$))?/.exec(h);
    if (ts && MONTHS[ts[1] as string] !== undefined) {
        const mon = MONTHS[ts[1] as string] as number;
        if (ts[3]) {
            // UTC, like parse3164Time. ASA carries an explicit year so there is
            // no inference to do, but the ZONE still has to be pinned or two
            // servers derive different msg_ts from identical bytes.
            row.msgTs = new Date(Date.UTC(
                Number(ts[3]), mon, Number(ts[2]),
                Number(ts[4]), Number(ts[5]), Number(ts[6]),
            ));
        } else {
            row.msgTs = parse3164Time(
                mon, Number(ts[2]), Number(ts[4]), Number(ts[5]), Number(ts[6]), now,
            );
        }
        h = (h.slice(0, ts.index) + ' ' + h.slice(ts.index + ts[0].length));
    }
    // Whatever survives must be a hostname or nothing. ASA writes "asa-fw :"
    // with a space before the colon; IOS writes "host:".
    h = h.replace(/[\s:]+/g, ' ').trim();
    if (!h) return row;                                     // no hostname sent
    if (/^[A-Za-z0-9][\w.-]*$/.test(h)) { row.host = h; return row; }
    return null;                                            // prose: not a Cisco header
}

/**
 * A TIMESTAMP THE DATABASE CAN STORE, or none (2026-10-01, review F4).
 * Date.parse accepts year 0 (`0000-01-01T00:00:00Z`), the signed six-digit
 * years (`+010000-...`, `-000001-...`) and V8's legacy `Jan 1 99999`, and
 * toISOString writes them back out in forms PostgreSQL refuses - "date/time
 * field value out of range", "time zone displacement out of range", measured
 * on the lab box. One such line made the COPY of its whole 2,000-row batch
 * fail, the batch went back to the head of the queue, and nothing was stored
 * until the queue's ceiling shed the poison row together with good ones.
 * Years 1 to 9999 are what both ends agree on; outside them the message keeps
 * its text (raw holds the header) and has no message time, as a line with an
 * unreadable timestamp always did. A device whose clock is merely wrong is
 * inside the range and unaffected.
 */
export function storableTs(d: Date): boolean {
    const y = d.getUTCFullYear();
    return Number.isFinite(d.getTime()) && y >= 1 && y <= 9999;
}

/** One datagram -> one row. Never throws, never returns null. */
export function parse(
    line: string, sourceIp: string | null, nowMs?: number, proto = 'syslog',
): ParsedMessage {
    const row = parseLine(line, sourceIp, nowMs, proto);
    if (row.msgTs !== null && !storableTs(row.msgTs)) row.msgTs = null;
    return row;
}

function parseLine(
    line: string, sourceIp: string | null, nowMs: number | undefined, proto: string,
): ParsedMessage {
    const now = nowMs !== undefined ? new Date(nowMs) : new Date();
    const row: ParsedMessage = {
        ts: now,
        msgTs: null,
        sourceIp,
        proto,
        facility: null,
        severity: null,
        host: null,
        app: null,
        procid: null,
        msg: line,
        raw: line,
    };

    let rest = line;

    // <PRI>
    const pri = /^<(\d{1,3})>/.exec(rest);
    if (pri && parseInt(pri[1] as string, 10) <= 191) {
        const n = parseInt(pri[1] as string, 10);
        row.facility = n >> 3;
        row.severity = n & 7;
        rest = rest.slice((pri[0] as string).length);
    }

    // RFC 5424: VERSION SP TIMESTAMP SP HOSTNAME SP APP-NAME SP PROCID SP MSGID SP SD [SP MSG]
    if (rest.startsWith('1 ')) {
        const fields = rest.slice(2).split(' ');
        if (fields.length >= 5) {
            const tsStr = fields[0] as string;
            const host = fields[1] as string;
            const app = fields[2] as string;
            const procid = fields[3] as string;
            const msgid = fields[4] as string;
            const t = Date.parse(tsStr);
            if (!Number.isNaN(t)) row.msgTs = new Date(t);
            if (host !== '-') row.host = host;
            // SEPARATE columns, as the protocol already had them. The 5424
            // header hands these over pre-split; gluing them back together
            // was the defect the procid column exists to undo.
            if (app !== '-') row.app = app;
            if (procid !== '-') row.procid = procid;
            // Everything after the 5 header fields: SD, then the free-form MSG.
            const headerLen = tsStr.length + host.length + app.length + procid.length + msgid.length + 5;
            const tail = rest.slice(2 + headerLen);
            const sdEnd = skipStructuredData(tail, 0);
            let msg = tail.slice(sdEnd);
            if (msg.startsWith(' ')) msg = msg.slice(1);
            if (msg.charCodeAt(0) === 0xFEFF) msg = msg.slice(1); // UTF-8 BOM
            // rsyslog's RFC 5424 forwarding sends TWO spaces before a message
            // it first received as RFC 3164 (its msg property keeps the space
            // after the tag's colon), so every such line was stored with a
            // leading space - and a rule anchored ^text matched the same line
            // forwarded one way and not the other (2026-09-28, the real-agent
            // drill). Leading spaces carry nothing a reader or a rule needs.
            msg = msg.replace(/^ +/, '');
            // A well-formed header with no MSG is a legitimately EMPTY message -
            // the old `msg || tail || rest` resurrected the nil-SD marker ('-')
            // as the body. Only fall back to the raw line when the header itself
            // did not parse (tail empty because headerLen overran the string).
            row.msg = tail ? msg : rest;
            return row;
        }
        // Malformed 5424 header - fall through and store as-is.
        row.msg = rest;
        return row;
    }

    // --- Cisco, tried before RFC 3164 --------------------------------------
    // IOS, IOS-XE, NX-OS, CatOS and ASA are all "syslog", none of them are RFC
    // 3164, and none agree with each other. They do share one reliable anchor:
    // a %FACILITY-SEVERITY-MNEMONIC: tag. Everything before it is header;
    // everything from it on is the line an operator recognises.
    //
    //   IOS    <PRI>1234: host: *Jul 25 14:30:00.456: %SYS-5-CONFIG_I: msg
    //   IOS    <PRI>000123: *Jul 25 14:30:00.456 UTC: %LINK-3-UPDOWN: msg   (no host)
    //   CatOS  <PRI>Jul 25 14:30:00 %SYS-5-MOD_OK:Module 3 is online        (no host/seq)
    //   ASA    <PRI>Jul 25 2026 14:30:00 asa-fw : %ASA-6-302013: msg        (a YEAR)
    //
    // Left to the 3164 path these parse actively WRONG rather than merely
    // incompletely: CatOS's "%SYS-5-MOD_OK:Module" lands in the HOST column and
    // IOS's sequence number lands in APP, poisoning host:/app: filtering for
    // some of the most common gear there is. Nothing was ever lost - raw always
    // held the datagram - but the columns lied.
    const cisco = CISCO_MNEMONIC.exec(rest);
    if (cisco) {
        const head = parseCiscoHeader(rest.slice(0, cisco.index), now);
        if (head) {                          // null => leftover prose, not Cisco
            if (head.host) row.host = head.host;
            if (head.msgTs) row.msgTs = head.msgTs;
            row.app = cisco[1] as string;    // FACILITY: what operators filter on
            row.msg = rest.slice(cisco.index); // keep the %MNEMONIC: operators know
            return row;
        }
    }

    // RFC 3164: TIMESTAMP HOSTNAME TAG[pid]: MSG (each part optional in the wild)
    const t3164 = /^([A-Z][a-z]{2}) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) /.exec(rest);
    if (t3164 && MONTHS[t3164[1] as string] !== undefined) {
        row.msgTs = parse3164Time(
            MONTHS[t3164[1] as string] as number,
            Number(t3164[2]), Number(t3164[3]), Number(t3164[4]), Number(t3164[5]), now,
        );
        rest = rest.slice((t3164[0] as string).length);

        // Next token: a hostname, unless it reads as a tag ("sshd[42]:" /
        // "kernel:") - some devices skip the hostname entirely.
        const sp = rest.indexOf(' ');
        const token = sp === -1 ? rest : rest.slice(0, sp);
        const looksLikeTag = /^[\w./-]+(\[\d+\])?:$/.test(token);
        if (!looksLikeTag && token && sp !== -1) {
            row.host = token;
            rest = rest.slice(sp + 1);
        }
    }

    const tag = /^([\w./-]+)(?:\[(\d+)\])?:\s*/.exec(rest);
    if (tag) {
        row.app = tag[1] as string;
        if (tag[2] !== undefined) row.procid = tag[2];
        rest = rest.slice((tag[0] as string).length);
    }

    row.msg = rest;
    return row;
}
