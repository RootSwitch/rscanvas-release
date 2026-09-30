// Response helpers and request body reading.
//
// Separated from main.ts because slice 2 gives every route the same three
// concerns - is the body small enough, who is asking, and may they - and those
// belong somewhere a later slice can reuse rather than copy.

import type http from 'node:http';
import zlib from 'node:zlib';
import { authorize, type Action, type Principal, type Resource } from '../auth/authorize.ts';

/** Bodies are tiny here (a username and a password). Anything larger is a probe. */
const MAX_BODY_BYTES = 8 * 1024;

/**
 * COMPACT, NOT PRETTY, and encoded once (2026-08-31, from an independent
 * review's C2).
 *
 * This was `JSON.stringify(body, null, 2)` from slice 2, when every response
 * was a status object. It is now the shape of the roster and the alert list.
 * Measured on roster-shaped rows: **1.40x the bytes** at 1,550, 5,000 and
 * 10,000 rows alike, and the stringify is synchronous ON THE MAIN THREAD -
 * 19.7ms at 10,000 rows here, and section 9 measured the mini PC at 1.87x
 * this box. Roughly thirty percent of the bytes and a quarter of that CPU
 * were indentation.
 *
 * Section 14 was already watching the shadow of this without naming it: "the
 * roster payload grew 1.86x with the summary columns, and the soak's
 * over-limit heartbeat ticks roughly doubled on the box whose query load hits
 * that route continuously."
 *
 * Buffer.from ONCE rather than Buffer.byteLength(text) followed by
 * res.end(text): the old form walked the string to count it and then encoded
 * it again to send it. `jq` exists for anyone who wants it readable.
 */
/**
 * BODY CAPS, PER ROUTE (2026-08-31, independent review C3).
 *
 * `MAX_BODY_BYTES` was written in slice 2 with the comment "bodies are tiny
 * here (a username and a password)", and that was true of the one route that
 * existed. Twenty-six routes now read through `readJsonBody`, several of which
 * declare their own, much larger limits - and the byte cap, not the declared
 * limit, was what actually bit:
 *
 *   * `normalizeNames(..., 1000)` rejected at ~430 twenty-character names.
 *   * `normalizeProbeRequest(body, 500)` fit 500 IPv4 addresses with 4% to
 *     spare and did not fit 500 hostnames - which is what a pasted CMDB list
 *     looks like, and `SCAN_MAX_PREFIX = 22` sizes a scan at 1,022 hosts on
 *     the stated reasoning that "two batches is a reasonable amount of
 *     onboarding for one sitting". The sizing argument in one file was
 *     invalidated by a constant in another, and neither file knew.
 *   * `PUT /api/boards/:id/doc` - "the editor's save path, and the only way a
 *     document is written" - took 8 KB, about 68 shapes, while
 *     `POST /api/boards/:id/import` bounds the SAME column through the SAME
 *     op at 4 MB. The import could create a board the save path could never
 *     write back.
 *
 * THE RULE: the byte cap must never be the binding constraint on a route that
 * declares a semantic one. When it is, the operator gets a byte count instead
 * of the documented rule, and the two limits drift apart with nothing
 * comparing them.
 *
 * The corollary bit, and it is why this is not simply "raise the caps": a
 * route with NO semantic limit is one where the byte cap is load-bearing.
 * `/api/devices/transient` was exactly that - `body.names` was uncapped, so
 * 8 KB was its only bound - and it got `normalizeNames` rather than a bigger
 * body, which is also how it acquired the dedupe and the count the other
 * three bulk name routes already had.
 */
export const BODY_CAP_BULK = 256_000;
/** The board document, matching its import twin's 4 MB exactly. */
export const BODY_CAP_DOC = 4_000_000;

/**
 * Security headers for the HTML and static surfaces (2026-08-31, independent
 * review S2). `serveStatic` sent `content-type` and `cache-control` and
 * nothing else.
 *
 * THE POLICY IS TIGHT BECAUSE THE CLIENT WAS ALREADY CLEAN, which is the only
 * reason this was cheap. Measured across both pages: zero inline `<script>`
 * blocks (five external `src` tags), zero `on*` handlers, zero `style=`
 * attributes, and exactly ONE `<style>` block - moved to `public/wall.css` in
 * the same change. All client style manipulation is CSSOM (`el.style.x =`,
 * `setProperty`), which `style-src` does not govern; there is no
 * `setAttribute('style')` and no `cssText` anywhere in `public/`. So no
 * 'unsafe-inline' is needed in either directive, and adding one later should
 * be treated as the regression it would be.
 *
 * `referrer-policy: no-referrer` is the one worth arguing for on its own.
 * BOARD-EXPOSURE.md and `auth/tokens.ts` both name the referrer header as a
 * capability-URL leak vector, and the recorded mitigation is narrow scope plus
 * easy revocation - "not secrecy, which cannot be maintained for a string that
 * lives in a URL bar in a corridor". That posture is right and is not an
 * argument against closing one of the three named vectors for free. A wall
 * loaded from `?token=...` that ever gains an outbound link, a web font or an
 * error beacon leaks the token in `Referer`; this removes the vector
 * permanently rather than per-feature.
 *
 * `frame-ancestors 'none'` (with the older `x-frame-options` beside it) is
 * about clickjacking, because CSRF protection here rests entirely on
 * `SameSite=Lax` with no token and no Origin check. Lax does hold against
 * cross-site POST - no state-changing route is reachable by GET - but it is
 * one control, and a UI carrying `DELETE /api/users/:name` and bulk device
 * delete should not be frameable.
 *
 * HSTS IS CONDITIONAL ON TLS and must stay that way: sent over plain http it
 * pins a browser to https for a year against a deployment that may not serve
 * it, which turns a header into an outage.
 */
export function securityHeaders(tls: boolean): Record<string, string> {
    return {
        'content-security-policy': [
            "default-src 'none'",
            "script-src 'self'",
            "style-src 'self'",
            "img-src 'self' data:",
            "connect-src 'self'",
            "base-uri 'none'",
            "form-action 'self'",
            "frame-ancestors 'none'",
        ].join('; '),
        'referrer-policy': 'no-referrer',
        'x-frame-options': 'DENY',
        ...(tls ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}),
    };
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    writeJson(res, status, Buffer.from(JSON.stringify(body), 'utf8'), headers);
}

function writeJson(res: http.ServerResponse, status: number, buf: Buffer, headers: Record<string, string>): void {
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': buf.length,
        // Device-controlled strings reach these responses. Nothing here renders
        // HTML, but a browser sniffing a JSON body as HTML is a well-worn way
        // to turn a stored payload into a reflected one.
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
        ...headers,
    });
    res.end(buf);
}

/**
 * GZIP FOR THE BIG LISTS (2026-09-30). The alert list and the device roster
 * are about 1.4 MB each at 30,000 entities, refreshed every 10 s by a page
 * showing them, and they compress to 4-5%: measured on the lab box's own
 * answers, 1,378,855 B of alerts to 59,888 and 1,445,297 B of roster to
 * 76,897 at level 3, in under 3 ms. Level 6 saves another 10 KB for three
 * times the time; brotli another 15 KB for six times. Level 3 it is.
 *
 * ON THE THREAD POOL, NOT THE PAGE THREAD: zlib.gzip's callback form runs
 * the deflate in libuv's pool, so the main thread pays only the
 * serialisation it already paid. Below GZIP_MIN_BYTES an answer goes as it
 * is - a short list is not worth the trip.
 *
 * Opt-in per route, and only for answers that hold no secret. Compressing a
 * response that mixes a secret with text an attacker can influence is the
 * BREACH shape; these two carry device-reported strings and no token,
 * password or key, and a route that ever does must not use this.
 */
export const GZIP_MIN_BYTES = 16 * 1024;
const GZIP_LEVEL = 3;

/** Whether an Accept-Encoding header admits gzip (q=0 refuses it; * is not taken as a yes). */
export function acceptsGzip(header: string | string[] | undefined): boolean {
    const v = Array.isArray(header) ? header.join(',') : header ?? '';
    for (const part of v.split(',')) {
        const [coding, ...params] = part.split(';').map((s) => s.trim().toLowerCase());
        if (coding !== 'gzip' && coding !== 'x-gzip') continue;
        const q = params.find((p) => p.startsWith('q='));
        return q === undefined || Number(q.slice(2)) > 0;
    }
    return false;
}

export function sendJsonGzip(
    req: http.IncomingMessage, res: http.ServerResponse, status: number, body: unknown,
    headers: Record<string, string> = {},
): void {
    const buf = Buffer.from(JSON.stringify(body), 'utf8');
    const base = { vary: 'accept-encoding', ...headers };
    if (buf.length < GZIP_MIN_BYTES || !acceptsGzip(req.headers['accept-encoding'])) {
        writeJson(res, status, buf, base);
        return;
    }
    zlib.gzip(buf, { level: GZIP_LEVEL }, (err, gz) => {
        // The client can leave while the pool works; there is no one to answer.
        if (res.destroyed || res.headersSent) return;
        if (err) { writeJson(res, status, buf, base); return; }
        writeJson(res, status, gz, { ...base, 'content-encoding': 'gzip' });
    });
}

/**
 * Read and parse a JSON body, capped.
 *
 * The cap is not politeness. This runs on the main thread, and rule 1's "no
 * unbounded work on it" applies to a request body just as much as to a query:
 * without a limit, one client streaming an endless body occupies memory and a
 * socket for as long as it likes.
 */
export async function readJsonBody(
    req: http.IncomingMessage, limit: number = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        const buf = chunk as Buffer;
        size += buf.length;
        if (size > limit) {
            // Names the limit AND the way out. `body exceeds 8192 bytes` told
            // an operator who selected 600 devices and clicked Disable a raw
            // byte count, naming neither the route, the operation, nor what
            // to do instead.
            throw new Error(`body exceeds this route's ${limit}-byte limit`
                + ' - send fewer items per request');
        }
        chunks.push(buf);
    }
    if (size === 0) return {};
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('body must be a JSON object');
    }
    // PostgreSQL cannot store NUL in text at all, so a NUL in any string
    // reached the database and came back a 500 (2026-09-28, the surface
    // sweep). Refused here, once, for every route - there is no legitimate
    // use for it in anything this API takes.
    if (containsNul(parsed)) throw new Error('a string in the body contains a NUL character');
    return parsed as Record<string, unknown>;
}

// Built, not typed: an escape sequence for it has twice landed in this repo
// as the raw byte it names.
const NUL = String.fromCharCode(0);

/** Whether any string in a parsed JSON value, or a query parameter, holds NUL. */
export function containsNul(v: unknown): boolean {
    if (typeof v === 'string') return v.includes(NUL);
    if (Array.isArray(v)) return v.some(containsNul);
    if (v !== null && typeof v === 'object') return Object.entries(v).some(([k, x]) => k.includes(NUL) || containsNul(x));
    return false;
}

/**
 * The body, or null after answering 400 with the reason. For the routes that
 * used to write `readJsonBody(req).catch(() => ({}))`: that turned a
 * truncated or malformed request into an EMPTY one and acted on it - the
 * surface sweep's invalid JSON turned a glance-grid board into a drawn one
 * and erased the group it was generated from (2026-09-28). A request whose
 * body cannot be read is refused, never reinterpreted.
 */
export async function readBodyOr400(
    req: http.IncomingMessage, res: http.ServerResponse, limit: number = MAX_BODY_BYTES,
): Promise<Record<string, unknown> | null> {
    try {
        return await readJsonBody(req, limit);
    } catch (err) {
        sendJson(res, 400, { ok: false, detail: `request body refused: ${(err as Error).message}` });
        return null;
    }
}

export function str(body: Record<string, unknown>, key: string): string {
    const v = body[key];
    return typeof v === 'string' ? v : '';
}

/**
 * The client address, honouring X-Forwarded-For only when explicitly trusted.
 *
 * Rate limiting and audit both key on this, so taking the header on faith would
 * let anyone forge their way out of a lockout by varying it, and would fill the
 * audit trail with addresses the attacker chose.
 */
export function clientIp(req: http.IncomingMessage): string {
    if (process.env.TRUST_PROXY === '1') {
        const xff = req.headers['x-forwarded-for'];
        const first = Array.isArray(xff) ? xff[0] : xff;
        if (first) {
            const ip = first.split(',')[0]?.trim();
            if (ip) return ip;
        }
    }
    return req.socket.remoteAddress ?? 'unknown';
}

/** Postgres inet rejects a bare IPv6 scope or "unknown"; store null instead. */
export function inetOrNull(ip: string): string | null {
    if (!ip || ip === 'unknown') return null;
    // Node reports IPv4-mapped IPv6 for dual-stack listeners.
    const unmapped = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
    return unmapped.includes('%') ? null : unmapped;
}

/**
 * The single gate every protected route passes through.
 *
 * Returns true when the request may proceed and has already been answered when
 * it may not, so a handler that forgets to check the return value fails closed
 * with a double-send rather than open.
 */
export function enforce(
    res: http.ServerResponse, principal: Principal, action: Action, resource?: Resource,
): boolean {
    const decision = authorize(principal, action, resource);
    if (decision.allowed) return true;

    // 401 when nobody is signed in, 403 when someone is but may not. The
    // distinction is what tells a UI whether to show a login form or an error.
    const status = principal.kind === 'anonymous' ? 401 : 403;
    sendJson(res, status, {
        ok: false,
        reason: status === 401 ? 'unauthenticated' : 'forbidden',
        action,
        detail: decision.reason,
    });
    return false;
}
