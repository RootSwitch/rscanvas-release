// CIDR expansion for the subnet scan, and the bound on it.
//
// Pure, so tools/test-cidr.ts holds it. The bound is the point: a scan is a
// sweep of every address in the range, and "every address in a /8" is sixteen
// million fping targets. /22 (1,022 hosts) is the ceiling, because the add
// form downstream caps a probe batch at 500 and two batches is a reasonable
// amount of onboarding for one sitting - past that, an operator is importing
// a CMDB, not scanning a subnet, and should hand us a list.

export type CidrResult = { ok: true; hosts: string[] } | { ok: false; detail: string };

export const SCAN_MAX_PREFIX = 22;

export function expandCidr(input: string): CidrResult {
    const m = /^\s*(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?\s*$/.exec(input);
    if (m === null) return { ok: false, detail: `"${input.trim()}" is not an IPv4 address or CIDR (e.g. 192.0.2.0/24)` };
    const o = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number];
    if (o.some((n) => n > 255)) return { ok: false, detail: `"${input.trim()}" has an octet over 255` };
    const prefix = m[5] === undefined ? 32 : Number(m[5]);
    if (prefix > 32) return { ok: false, detail: `/${prefix} is not a valid prefix length` };
    if (prefix < SCAN_MAX_PREFIX) {
        return {
            ok: false,
            detail: `/${prefix} is ${2 ** (32 - prefix)} addresses - the scan is capped at /${SCAN_MAX_PREFIX} `
                + `(${2 ** (32 - SCAN_MAX_PREFIX) - 2} hosts). Scan it in pieces, or paste a host list into the add form.`,
        };
    }
    const base = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const net = (base & mask) >>> 0;
    const size = 2 ** (32 - prefix);
    const hosts: string[] = [];
    // /31 and /32 have no network/broadcast to skip; everything wider does.
    const first = prefix >= 31 ? 0 : 1;
    const last = prefix >= 31 ? size - 1 : size - 2;
    for (let i = first; i <= last; i++) {
        const a = (net + i) >>> 0;
        hosts.push(`${a >>> 24}.${(a >>> 16) & 255}.${(a >>> 8) & 255}.${a & 255}`);
    }
    return { ok: true, hosts };
}
