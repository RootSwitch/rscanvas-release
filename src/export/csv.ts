// CSV encoding, with the formula guard.
//
// Ported from syslogcanvas/server/api.js csvCell(). ARCHITECTURE.md section 4
// carries an explicit instruction about it:
//
//   "The CSV formula guard is apostrophe then quote-wrap, which is the correct
//    OWASP order. A prior review called this a bypass; it is not. Do not fix
//    it."
//
// The order is the part people get wrong, so it is worth stating why it is
// right. The apostrophe must go on the RAW value, before quoting. A spreadsheet
// parses the CSV first and evaluates the cell second, so what it tests for a
// leading `=` is the value AFTER quote removal. Wrapping first and prefixing
// after would put the apostrophe outside the quotes, where it is part of the
// CSV syntax rather than part of the cell, and the guard would do nothing.
//
// Prefix, then wrap. That is the whole rule.
//
// The character class includes TAB and CR as well as the obvious `= + - @`,
// because some spreadsheet parsers strip leading whitespace before the formula
// check.
//
// THE GUARD IS UNCONDITIONAL, AND PROVENANCE IS NOT THE TEST. It was written
// for syslog fields, which come straight off the wire and are fully
// attacker-controlled - and that origin story is a trap for the next reader.
// **"Operator-assigned" is a fact about WHO WROTE a value, not a claim about
// what the value contains.** An operator can type `=HYPERLINK(...)` into a
// device's location, or paste something they did not read from a ticket, and
// it lands in a roster export exactly like a hostile ifAlias would. The two
// axes are orthogonal: provenance decides who may WRITE a field, this decides
// how any field is treated on the way OUT.
//
// So every cell goes through csvCell, whatever the column and whoever typed
// it. There is deliberately no trusted-column list to get wrong. The same
// rule holds on the render side by construction: public/dom.js assigns
// through textContent only, and tools/check-dom-sinks.mjs refuses the
// alternatives - neither asks where the string came from.

/** One CSV cell: always quoted, embedded quotes doubled, formula-guarded. */
export function csvCell(v: unknown): string {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""').replace(/\r/g, '') + '"';
}

export function csvRow(values: unknown[]): string {
    return values.map(csvCell).join(',') + '\n';
}

/**
 * Column order for a syslog export.
 *
 * `raw` is included. It is the one field guaranteed to hold what the device
 * actually sent, whatever the parser made of it, and an export whose purpose is
 * a retroactive investigation should not quietly drop the only unprocessed
 * copy.
 */
export const EXPORT_COLUMNS = [
    'id', 'ts', 'msg_ts', 'source_ip', 'proto', 'facility', 'severity',
    'host', 'app', 'procid', 'msg', 'raw',
] as const;

export function csvHeader(): string {
    return csvRow([...EXPORT_COLUMNS]);
}

/** Format one database row in EXPORT_COLUMNS order. */
export function csvRowFromRecord(r: Record<string, unknown>): string {
    return csvRow(EXPORT_COLUMNS.map((c) => {
        const v = r[c];
        // Timestamps go out as ISO 8601 rather than as a locale rendering: an
        // export is read by a machine at least as often as by a person, and
        // "26/07/2026" is ambiguous in exactly the way ISO is not.
        return v instanceof Date ? v.toISOString() : v;
    }));
}

/**
 * Column order for the CrossCanvas inventory export.
 *
 * THESE NAMES ARE A CONTRACT WITH ANOTHER APPLICATION, not a preference.
 * CrossCanvas's inventory import maps headers through its own guess table, and
 * its comment says the column spec is kept stable precisely because external
 * producers build against it. Renaming anything here silently changes what
 * lands in a zone.
 *
 * `Location` is the grouping column and is filled by EITHER a device's
 * location or its application, chosen per export - CrossCanvas nests one
 * Location path into zones, so RSCanvas decides which axis fills it rather
 * than inventing a second column it would ignore.
 *
 * NO x AND y, AND THAT IS THE WHOLE POINT - corrected 2026-08-13 after the
 * claim was checked against CrossCanvas's code rather than its documentation.
 *
 * I had shipped coordinates, reasoning that rows carrying them skip the
 * auto-layout and therefore make regeneration non-destructive. They do skip
 * it - and the skip happens BEFORE the Location tree is built, so those rows
 * never get inserted into a zone at all. A generated board that shipped
 * coordinates imported as a zoneless pile, and the axis this export exists to
 * project would simply never have been drawn.
 *
 * Omitting them buys the good version for free: shelf-packed layout with the
 * group as a real wrapping zone, nested when the value carries `/`. "Make me
 * a board of HQ / Floor 3" produces a drawn HQ / Floor 3.
 *
 * AND THE MIXED CASE IS WHY THIS IS NOT AN OPTION. On a regeneration some
 * devices have positions and new ones do not, so the placed ones divert to
 * explicit while the new ones go through the zone path - a zone containing
 * only the new arrivals, with the established fleet floating outside it. That
 * is worse than either pure choice, so the choice is not offered. Regenerating
 * means "lay it out again"; an operator who wants their arrangement kept adds
 * the new device by hand in the editor and does not regenerate.
 *
 * The import-back leg still READS x/y - CrossCanvas's export always carries
 * them, and there placement is the entire point.
 *
 * Every header here auto-maps in CrossCanvas's mapper without a dialog:
 * label, hostname, ipaddress, stencil and location each hit one of its
 * header regex families, so the import is zero-touch.
 */
export const INVENTORY_COLUMNS = [
    'label', 'Hostname', 'IP-Address', 'stencil', 'Location',
] as const;

export function inventoryHeader(): string {
    return csvRow([...INVENTORY_COLUMNS]);
}

/**
 * Minimal RFC 4180 reader, for the round trip back from CrossCanvas.
 *
 * Quoted cells may hold commas, doubled quotes and newlines; CRLF and LF both
 * end a row; a leading BOM is dropped. Tab-separated input is accepted too,
 * because a range copied out of a spreadsheet lands on the clipboard as TSV
 * and somebody will paste one - decided by whether the first line holds a tab,
 * since a label can contain a comma but never a tab.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: interpret anything. A cell beginning with
 * "=" stays the literal string, and the leading apostrophe our own exporter
 * adds is NOT stripped. Round-tripping a formula-guarded value back through
 * here yields '=cmd rather than =cmd, which is ugly in a label and is the
 * correct trade - the alternative is code that removes a safety prefix, and
 * that code eventually runs on something that was not ours to unguard.
 */
export function parseCsv(text: string): string[][] {
    const src = text.replace(/^﻿/, '');
    const nl = src.indexOf('\n');
    const first = nl < 0 ? src : src.slice(0, nl);
    const delim = first.includes('\t') ? '\t' : ',';

    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < src.length; i++) {
        const ch = src[i] as string;
        if (quoted) {
            if (ch === '"') {
                if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
            } else cell += ch;
        } else if (ch === '"') {
            quoted = true;
        } else if (ch === delim) {
            row.push(cell); cell = '';
        } else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && src[i + 1] === '\n') i++;
            row.push(cell); cell = '';
            // A trailing newline must not manufacture an empty final row.
            if (row.length > 1 || row[0] !== '') rows.push(row);
            row = [];
        } else {
            cell += ch;
        }
    }
    if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
    return rows;
}

/**
 * Header lookup that survives the round trip.
 *
 * RSCanvas writes "Hostname" and "IP-Address"; CrossCanvas writes its base
 * columns lowercase (label, hostname, x) and its device-detail columns in
 * their panel casing. Matching case-insensitively with punctuation stripped
 * means one lookup handles both directions, instead of a translation table
 * that needs updating whenever either side adds a column.
 */
export function headerIndex(header: string[]): Map<string, number> {
    const idx = new Map<string, number>();
    header.forEach((h, i) => {
        const key = h.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!idx.has(key)) idx.set(key, i);
    });
    return idx;
}
