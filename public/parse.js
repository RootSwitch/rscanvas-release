// Pure text parsing for the onboarding paste box. No DOM, no fetch, no state.
//
// EXTRACTED FOR THE SAME REASON AS dom.js: two consumers need the same code -
// the browser and tools/test-onboarding.ts - and a test that re-implemented
// this would assert that a COPY parses correctly, which is worth very little
// because the copy cannot rot in the same direction as the original.
//
// It lives apart from app.js because app.js touches `document` at import time
// and cannot be loaded outside a browser at all. Anything pure that wants a
// test has to come out; that is the whole rule.

/**
 * A pasted block of hosts, as an operator actually produces one.
 *
 * ONE HOST PER LINE is the base case. But the realistic input is a paste out
 * of a spreadsheet or a vendor export, so a delimited file with a header is
 * worth handling rather than telling somebody to go clean their file: take the
 * column whose header looks like an address, or the first field if there is no
 * header.
 *
 * Anything that does not look like an address or a hostname is dropped
 * SILENTLY HERE and reported by the probe, because a line that is obviously a
 * title row should not become a failed probe row - a review table where the
 * first entry is always the word "Hostname" trains people to skim it.
 *
 * The address test is deliberately LOOSE. The probe is the real test, and
 * rejecting something the network would have answered would be this page
 * overruling the device.
 */
export function parseHosts(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
    if (lines.length === 0) return [];
    const delim = (lines[0].match(/\t/g) || []).length > 0 ? '\t' : ',';
    const cells = (l) => l.split(delim).map((c) => c.trim().replace(/^"|"$/g, ''));

    let col = 0;
    const head = cells(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
    const looksLikeHeader = head.some((h) => /^(ip|ipaddress|address|host|hostname|mgmtip)$/.test(h));
    let body = lines;
    if (looksLikeHeader) {
        col = head.findIndex((h) => /^(ip|ipaddress|address|host|hostname|mgmtip)$/.test(h));
        body = lines.slice(1);
    }
    const out = [];
    for (const line of body) {
        const v = (cells(line)[col] ?? '').trim();
        if (v !== '' && /^[A-Za-z0-9._:-]+$/.test(v)) out.push(v);
    }
    // Deduped, because a paste assembled from two sources overlaps and probing
    // the same device twice is pure waste - it also produces two review rows
    // for one device, which reads as two devices.
    return [...new Set(out)];
}

/**
 * The device list's filter box, read (2026-09-28). A plain word matches a
 * device's name, address, location or application by substring - which is
 * what makes "PAM" find both PAM Prod and PAM Dev. `location:<name>` and
 * `application:<name>` match that group EXACTLY (ignoring case and the
 * spaces around it), and an empty name matches the devices with none set.
 *
 * The exact form exists for the Dashboard's health tables, which open the
 * device list on one group: as a substring, the location "Lab" matched every
 * device named lab-node-..., so a click on Lab's 15 down listed 78.
 *
 * `transient:` and `muted:` (2026-09-29) list the devices declared so, and
 * `transient:no` and `muted:no` the rest - the overview those declarations
 * lacked, since each showed only on its own row. They are words of their
 * own, anywhere in the box, and narrow whatever else it holds: "muted: PAM"
 * is the muted devices of both PAM applications, "transient:
 * location:Lab" the transient ones in Lab. They are taken out before the
 * rest is read, so a group name with spaces in it still reads whole.
 */
const FLAG = /(^|\s)(transient|muted):(yes|no)?(?=\s|$)/gi;

export function parseDeviceFilter(text) {
    const flags = {};
    const t = String(text ?? '').replace(FLAG, (_all, lead, name, value) => {
        flags[name.toLowerCase()] = (value ?? 'yes').toLowerCase() === 'yes';
        return lead;
    }).trim();
    const m = /^(location|application):(.*)$/i.exec(t);
    if (m) return { kind: 'group', axis: m[1].toLowerCase(), value: m[2].trim().toLowerCase(), flags };
    return { kind: 'text', q: t.toLowerCase(), flags };
}

/** Whether one device row passes a filter from parseDeviceFilter. */
export function deviceMatches(d, f) {
    const flags = f.flags ?? {};
    if (flags.transient !== undefined && (d.transient === true) !== flags.transient) return false;
    if (flags.muted !== undefined && (d.alerts_muted === true) !== flags.muted) return false;
    if (f.kind === 'group') return String(d[f.axis] ?? '').trim().toLowerCase() === f.value;
    const q = f.q;
    return q === ''
        || String(d.name ?? '').toLowerCase().includes(q)
        || String(d.host ?? '').toLowerCase().includes(q)
        || String(d.location ?? '').toLowerCase().includes(q)
        || String(d.application ?? '').toLowerCase().includes(q);
}
