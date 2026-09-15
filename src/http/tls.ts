// TLS on the web port, terminated in the process.
//
// Two jobs. First, READ THE PAIR and refuse a half configuration: TLS_CERT
// without TLS_KEY (or the reverse, or a path that does not exist) is a FATAL
// at boot, never a silent fall-through to plaintext. The failure mode being
// avoided is an operator who set --tls, saw the service come up, and never
// noticed that the browser said http.
//
// Second, ONE PORT FOR BOTH. A TLS server answers a plaintext request with a
// handshake failure, which a browser renders as "This site can't provide a
// secure connection" - no hint that https:// would have worked. So the
// listener here is a raw TCP server that peeks the FIRST BYTE of each
// connection: 0x16 is a TLS ClientHello and goes to the https server,
// anything else goes to a tiny http server whose only job is a 301 to the
// same host and port over https. This is the httpolyglot pattern and it is
// safe because the peeked chunk is unshifted back onto the socket before the
// real server sees it. A stale bookmark still lands.
//
// Not here: certificate generation. That is the installer's job
// (rscanvas-setup.sh --tls) because it is a one-time act with a file system
// side effect, and this process must never write into /etc.

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export interface TlsPair { cert: Buffer; key: Buffer; }

export class TlsConfigError extends Error {}

/**
 * Read the pair named by the two paths, or null when neither is set. One set
 * without the other, or a path that cannot be read, throws - the caller is
 * expected to die on it, not catch it.
 */
export function loadTlsPair(certPath: string, keyPath: string): TlsPair | null {
    if (certPath === '' && keyPath === '') return null;
    if (certPath === '' || keyPath === '') {
        throw new TlsConfigError(
            `TLS_CERT and TLS_KEY must both be set or both be empty (got cert=${JSON.stringify(certPath)} key=${JSON.stringify(keyPath)}) - refusing to start half-configured`);
    }
    let cert: Buffer, key: Buffer;
    try { cert = fs.readFileSync(certPath); } catch (err) {
        throw new TlsConfigError(`TLS_CERT ${certPath}: ${(err as Error).message}`);
    }
    try { key = fs.readFileSync(keyPath); } catch (err) {
        throw new TlsConfigError(`TLS_KEY ${keyPath}: ${(err as Error).message}`);
    }
    return { cert, key };
}

/**
 * A server for the web port. Without a pair it is plain http. With one it is
 * https, fronted by the first-byte dispatcher described above, and the value
 * returned is the dispatcher - that is what listens, and what close() closes.
 * The https and redirect servers behind it never listen on their own.
 */
export function createWebServer(pair: TlsPair | null, handler: http.RequestListener): net.Server {
    if (pair === null) return http.createServer(handler);

    const secure = https.createServer({ cert: pair.cert, key: pair.key }, handler);
    const redirect = http.createServer((req, res) => {
        // The Host header already carries the port the client used, which is
        // this port, so the redirect is to the same place over https. No Host
        // (HTTP/1.0) means no way to know where to send them; say so in words.
        const host = req.headers.host;
        if (host === undefined) {
            res.writeHead(400, { 'content-type': 'text/plain' });
            res.end('this port serves https; retry with https:// and a Host header\n');
            return;
        }
        res.writeHead(301, { location: `https://${host}${req.url ?? '/'}`, 'content-type': 'text/plain' });
        res.end(`this port serves https - redirecting to https://${host}${req.url ?? '/'}\n`);
    });

    // PAUSED-MODE READ, NOT once('data'). A 'data' listener puts the socket in
    // flowing mode, and handing a flowing socket to the TLS server races the
    // wrapper's own drain of the buffered ClientHello on the next tick - the
    // first draft of this hung every https request. read(1) leaves the
    // stream's flowing state untouched: the http server's own data listener
    // starts the flow for the redirect branch, and the TLS wrapper reads the
    // unshifted byte from the buffer itself.
    const dispatch = (socket: net.Socket): void => {
        const first = socket.read(1) as Buffer | null;
        if (first === null) { socket.once('readable', () => dispatch(socket)); return; }
        socket.setTimeout(0);
        socket.unshift(first);
        (first[0] === 0x16 ? secure : redirect).emit('connection', socket);
    };
    const front = net.createServer((socket) => {
        // A client that connects and sends nothing holds a slot for ever;
        // give it 30s and then drop it.
        socket.setTimeout(30_000, () => socket.destroy());
        socket.on('error', () => { /* a reset before the first byte is the client's business */ });
        dispatch(socket);
    });

    // Closing the front stops new connections; the two servers behind it own
    // the sockets already dispatched, so close them too or a keep-alive
    // session keeps the process alive past shutdown.
    const close = front.close.bind(front);
    front.close = ((cb?: (err?: Error) => void) => {
        secure.close(); redirect.close();
        secure.closeAllConnections(); redirect.closeAllConnections();
        return close(cb);
    }) as typeof front.close;
    return front;
}
