// One log line per log call (2026-10-03, review L9).
//
// Device strings reach the log - ifName, sysName, an agent's error text, a v3
// user name - and a line break inside one ended our line and began another
// that read as anything its author liked: "... [collector] poll of sw1 ok\n
// 2026-10-03T... [auth] admin password changed". Only NUL was stripped. Every
// log helper now passes its arguments through here, so a control character
// arrives as a visible escape on the line it belongs to, never as a new line
// or a terminal escape sequence. Tabs stay: they cannot start a line.
//
// Objects are left to console.log, whose inspect already escapes the strings
// inside them. An Error's stack is flattened the same way, because its
// message is where an agent's text usually travels.
//
// No state here, so any thread may import it.

const CONTROL = /[\x00-\x08\x0a-\x1f\x7f\u0085\u2028\u2029]/g;

export function escapeControl(text: string): string {
    return text.replace(CONTROL, (c) =>
        c === '\n' ? '\\n' : c === '\r' ? '\\r' : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function safeLogArgs(args: unknown[]): unknown[] {
    return args.map((a) => typeof a === 'string' ? escapeControl(a)
        : a instanceof Error ? escapeControl(a.stack ?? `${a.name}: ${a.message}`)
            : a);
}
