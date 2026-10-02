// A batch refused on its CONTENT, written around the rows that cannot be
// stored (2026-10-01, review F4). Pure apart from the copy it is handed, so
// tools/test-copy-isolate.ts decides it offline.
//
// The ingest flush requeued a thrown COPY whole, at the head of the queue -
// right for a database that is down, and a wedge for a batch the database will
// never accept: one row PostgreSQL refused (a message timestamp in year 0) and
// nothing at all was stored until the queue's ceiling shed the bad row along
// with good ones. A data exception is about a row; everything else a COPY can
// throw is about the database, and only the second should wait.

/**
 * A PostgreSQL data exception (SQLSTATE class 22): the CONTENT of a row was
 * refused - a timestamp out of range, a malformed value. A lost connection
 * (08), an administrator shutdown (57), a missing partition (23514) or a full
 * disk (53) is about the database, and the batch waits for it as before.
 */
export function isDataError(err: unknown): boolean {
    const code = (err as { code?: unknown } | null)?.code;
    return typeof code === 'string' && code.startsWith('22');
}

/**
 * Write `rows` in halves until what the database refuses is single rows, and
 * drop only those. One bad row in 2,000 costs about 22 copies, once. A refusal
 * that is NOT about content - a structured lane refusal, or any other thrown
 * error - stops the search and hands back every row not yet written, in order,
 * for the queue. Never throws.
 */
export async function copyIsolating<T>(
    rows: readonly T[],
    copy: (part: T[]) => Promise<{ ok: boolean; rowCount: number }>,
): Promise<{ written: number; dropped: T[]; requeue: T[] }> {
    const parts: T[][] = [[...rows]];
    let written = 0;
    const dropped: T[] = [];
    while (parts.length > 0) {
        const part = parts.shift() as T[];
        try {
            const res = await copy(part);
            if (!res.ok) return { written, dropped, requeue: [part, ...parts].flat() };
            written += res.rowCount;
        } catch (err) {
            if (!isDataError(err)) return { written, dropped, requeue: [part, ...parts].flat() };
            if (part.length === 1) { dropped.push(part[0] as T); continue; }
            const mid = Math.ceil(part.length / 2);
            parts.unshift(part.slice(0, mid), part.slice(mid));
        }
    }
    return { written, dropped, requeue: [] };
}
