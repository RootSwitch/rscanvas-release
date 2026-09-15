// COPY text format encoding.
//
// This lives in the store because it is a wire-format concern, and because the
// values passing through it are hostile by definition: a syslog message body is
// typed by a device, not an operator. ARCHITECTURE.md section 4 treats those
// strings as hostile input all the way to HTML, JSON and CSV; the COPY stream
// is one more place they can do damage, and a different one from escaping for
// display. An unescaped tab shifts every later column of that row; an
// unescaped newline ends the row early and turns one datagram into two
// half-rows, or aborts the whole batch. Either way the never-drop invariant is
// broken by a device that sent a legal datagram.
//
// Ported from spike/src/fixture.ts, which had it right.

const NUL = String.fromCharCode(0);

export function copyEscape(v: string | number | null): string {
    if (v === null) return '\\N';
    if (typeof v === 'number') return String(v);
    // Backslash FIRST, or the escapes introduced below get escaped again.
    return v
        .replace(/\\/g, '\\\\')
        .replace(/\t/g, '\\t')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r');
}

export function copyLine(values: (string | number | null)[]): string {
    return values.map(copyEscape).join('\t') + '\n';
}

/**
 * Postgres text columns cannot hold a NUL byte at all - not escaped, not
 * encoded. A datagram containing one is legal on the wire and would abort the
 * entire COPY batch, taking every other message in the flush with it. Stripping
 * is the only option that keeps the never-drop invariant, so it is done here
 * and counted by the caller rather than being silently absorbed.
 */
export function stripNul(s: string): { text: string; stripped: number } {
    if (!s.includes(NUL)) return { text: s, stripped: 0 };
    let stripped = 0;
    for (const ch of s) if (ch === NUL) stripped++;
    return { text: s.split(NUL).join(''), stripped };
}
