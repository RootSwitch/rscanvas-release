// One at a time, in arrival order: each call waits for the one before it to
// settle, whether that one succeeded or threw. For work that must not
// overlap within a process - the two retention jobs (workers/jobs.ts) - when
// overlapping would not fail but quietly lose.

export function serial(): <T>(fn: () => Promise<T>) => Promise<T> {
    let tail: Promise<unknown> = Promise.resolve();
    return <T>(fn: () => Promise<T>): Promise<T> => {
        const run = tail.then(fn, fn);
        tail = run.catch(() => undefined);
        return run;
    };
}
