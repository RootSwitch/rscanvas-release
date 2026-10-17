// The Dashboard's answers, one per window per rollup hour - the cache main.ts
// kept inline until 2026-10-09, moved here so its rules can be asserted
// offline (tools/test-answer-cache.ts) rather than by watching a live
// Dashboard.
//
// THE RULES. An answer is good for its window until the rollup frontier
// moves, so it is keyed by the frontier hour. Concurrent asks for the same
// window and hour share ONE computation. A refusal is not kept - the next ask
// tries again. And forget() drops every answer when the fleet changes under
// them (devices deleted): a computation already running when forget() is
// called read the fleet BEFORE the change, so it is neither joined by a later
// ask nor allowed to fill the cache when it lands. Without that, a delete in
// the middle of a warm-up put the deleted device straight back for the hour.

export type Answer<B> = { ok: true; body: B } | { ok: false; reason: string };

export interface AnswerCache<B> {
    /** Cached, or being computed (joined), or computed now. */
    answer(hours: number, hiMs: number): Promise<Answer<B>>;
    /** Is this window's answer for this hour already held? */
    has(hours: number, hiMs: number): boolean;
    /** Drop every answer, and refuse the ones still being computed. */
    forget(): void;
}

export function answerCache<B>(compute: (hours: number, hiMs: number) => Promise<Answer<B>>): AnswerCache<B> {
    const held = new Map<number, { hi: number; body: B }>();
    const running = new Map<string, Promise<Answer<B>>>();
    let generation = 0;
    return {
        answer(hours, hiMs) {
            const h = held.get(hours);
            if (h !== undefined && h.hi === hiMs) return Promise.resolve({ ok: true, body: h.body });
            const gen = generation;
            const key = `${hours}@${hiMs}#${gen}`;
            const joined = running.get(key);
            if (joined !== undefined) return joined;
            const p = compute(hours, hiMs)
                .then((r) => {
                    if (r.ok && gen === generation) held.set(hours, { hi: hiMs, body: r.body });
                    return r;
                })
                .catch((err: unknown): Answer<B> => ({ ok: false, reason: (err as Error).message }))
                .finally(() => running.delete(key));
            running.set(key, p);
            return p;
        },
        has(hours, hiMs) {
            return held.get(hours)?.hi === hiMs;
        },
        forget() {
            generation++;
            held.clear();
        },
    };
}
