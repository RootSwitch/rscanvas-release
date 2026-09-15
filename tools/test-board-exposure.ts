// The board exposure gate, asserted against SERVED BYTES.
//
//   node tools/test-board-exposure.ts     (needs a running app + database)
//
// BOARD-EXPOSURE.md lists five testable consequences and names the one that
// will actually catch a regression: a test that checks the projection
// FUNCTION omits addresses passes forever while a route quietly returns the
// document instead. So everything here goes through HTTP and asserts on the
// response body as a string - if a credential ref, an address or an
// annotation appears anywhere in those bytes, this fails, no matter which
// layer put it there.
//
// This is the same shape as tools/test-render-hostile.ts, which had to be
// retargeted once because it looked at a field no payload could reach. A test
// looking in the wrong place fails safe-looking, which is the worst way to
// fail - so the fixture below plants MARKER STRINGS and the assertions hunt
// for those markers rather than for a field name.

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:18080';
const USER = process.env.ADMIN_USER ?? 'admin';
const PASS = process.env.ADMIN_PASSWORD ?? 'rscanvas-demo-2026';

let pass = 0;
let fail = 0;
const ok = (m: string): void => { pass++; console.log(`  ok   ${m}`); };
const bad = (m: string, extra?: unknown): void => {
    fail++;
    console.log(`  FAIL ${m}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}`);
};

let cookie = '';
async function req(
    path: string, init: RequestInit = {},
): Promise<{ status: number; text: string; body: Record<string, unknown> }> {
    const res = await fetch(`${BASE}${path}`, {
        ...init,
        headers: { ...(init.headers ?? {}), ...(cookie === '' ? {} : { cookie }) },
    });
    const set = res.headers.get('set-cookie');
    if (set !== null) cookie = set.split(';')[0] as string;
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* not json */ }
    return { status: res.status, text, body };
}

// The markers. Deliberately weird so a substring hit cannot be a coincidence,
// and one per data class the document carries.
const M_ADDR = '10.253.77.201';
const M_CRED = 'MARKER-CREDENTIAL-REF-8842';
const M_NOTE = 'MARKER-PRIVATE-ANNOTATION-8842';
// NO M_HIDDEN. An earlier fixture planted a marker on a shape at
// (99999, 99999) labelled "the class of thing a picture does not show"
// and then never asserted on it - so the suite's count implied coverage of
// an off-drawn-area class it did not test. That is the same defect this
// file's own header warns about, twice over: a fixture whose assertions do
// not reach what it plants fails safe-looking.
//
// It is deleted rather than asserted because THE CLASS DOES NOT EXIST FOR
// THIS RENDERER: wall.js scales to the bounding box of every shape, so
// there is no off-screen. BOARD-EXPOSURE.md's wording was corrected to
// match rather than the test being bent to fit it.
const M_LABEL = 'MARKER-DRAWN-LABEL-8842';
// THE BIND VALUE MUST DIFFER FROM THE LABEL. When they were the same string,
// this test could not see that the projection was serving `bind` - a device
// name the board does not draw. A fixture whose fields coincide cannot
// distinguish which one leaked, which is the same blind spot that once had
// the hostile test looking at a field no payload could reach.
const M_BIND = 'MARKER-BOUND-DEVICE-NAME-8842';

console.log(`board exposure gate against ${BASE}`);

const login = await req('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
});
if (login.status !== 200) {
    console.log(`  FAIL cannot sign in as ${USER} (${login.status})`);
    process.exit(1);
}

// --- fixture -----------------------------------------------------------------
const boardName = `exposure-test-${Date.now()}`;
const made = await req('/api/boards', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: boardName, collection: 'wall' }),
});
const boardId = made.body.id as string | undefined;
if (boardId === undefined) {
    console.log(`  FAIL could not create a board (${made.status}) ${made.text.slice(0, 200)}`);
    process.exit(1);
}

// The document carries every class of thing a board holds and a picture does
// not. Written over HTTP, NOT through a direct store import. The first version of
// this test imported the store and wrote the document itself - and failed with
// "relation boards does not exist", because the app reads DATABASE_URL from
// its systemd unit while a test shell has none. Two instruments pointed at two
// different databases, which is a whole class of confusion removed by making
// the test black-box: everything here now goes through the same HTTP surface a
// real client uses, which is also what the exposure gate is actually about.
const doc = {
    shapes: [
        {
            id: 's1', x: 10, y: 20, w: 100, h: 40, kind: 'device',
            label: M_LABEL, bind: M_BIND, address: M_ADDR,
            credentialRef: M_CRED, note: M_NOTE,
        },
    ],
    privateNotes: M_NOTE,
};
const wrote = await req(`/api/boards/${boardId}/doc`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(doc),
});
if (wrote.status !== 200) {
    console.log(`  FAIL could not write the fixture document (${wrote.status}) ${wrote.text.slice(0, 200)}`);
    process.exit(1);
}

const minted = await req(`/api/boards/${boardId}/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'exposure-test display' }),
});
const secret = minted.body.secret as string | undefined;
if (secret === undefined) {
    console.log(`  FAIL no token minted (${minted.status}) ${minted.text.slice(0, 200)}`);
    process.exit(1);
}
ok('a token is returned exactly once, at mint time');

// --- consequence 2: the served bytes ------------------------------------------
const asDisplay = async (path: string): Promise<{ status: number; text: string; body: Record<string, unknown> }> => {
    const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${secret}` } });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* not json */ }
    return { status: res.status, text, body };
};

const rendered = await asDisplay('/api/display/board');
if (rendered.status === 200) ok('a valid token renders its board');
else bad('a valid token could not render its board', { status: rendered.status, text: rendered.text.slice(0, 200) });

// THE ASSERTION THAT MATTERS. Against the raw response text, so it holds no
// matter which layer would have leaked it.
for (const [marker, what] of [
    [M_ADDR, 'an IP address'],
    [M_CRED, 'a credential ref'],
    [M_NOTE, 'a private annotation'],
    [M_BIND, 'the bound device name (not drawn on the board)'],
] as Array<[string, string]>) {
    if (rendered.text.includes(marker)) {
        bad(`${what} REACHED A DISPLAY in the served bytes`, { marker });
    } else {
        ok(`${what} never reaches a display (searched the whole response body)`);
    }
}

// The drawn label MUST be present - otherwise this test would pass on a route
// that returns nothing at all, which is the vacuous shape this project keeps
// finding. The positive control is what makes the negatives mean something.
if (rendered.text.includes(M_LABEL)) ok('the drawn label IS served - the negatives above are not vacuous');
else bad('the drawn label was missing, so this test proves nothing about what is withheld');

// --- consequence 3: addresses are off by default, on when declared -------------
const turnedOn = await req(`/api/boards/${boardId}/addresses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ show: true }),
});
if (turnedOn.status === 200) {
    const withAddr = await asDisplay('/api/display/board');
    if (withAddr.text.includes(M_ADDR)) {
        ok('a board that DECLARES show_addresses serves them - the default was a choice, not an inability');
    } else {
        bad('show_addresses had no effect, so the default proves nothing');
    }
    // and the other classes stay withheld even then
    if (!withAddr.text.includes(M_CRED) && !withAddr.text.includes(M_NOTE)) {
        ok('declaring addresses does NOT open the document - creds and notes stay withheld');
    } else {
        bad('show_addresses leaked more than addresses');
    }
    await req(`/api/boards/${boardId}/addresses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ show: false }),
    });
} else {
    bad('could not toggle show_addresses', { status: turnedOn.status });
}

// --- slice 26: grid fields exist only when declared ----------------------------
//
// Same discipline as the address cases: a negative (undeclared identity never
// served), its positive control (declared, it appears - so the negative was a
// choice, not an inability), and the write-path refusal for junk keys. The
// probe value is the BOUND DEVICE'S REAL IP, which the grid's `address` field
// would serve - a marker the fixture cannot plant, so these cases only run
// where a real device exists to bind.
const devsForGrid = await req('/api/devices');
const dev0 = (devsForGrid.body.devices as Array<{ name: string; host: string }> | undefined)?.[0];
if (dev0 === undefined) {
    console.log('  note grid-field cases skipped - no devices on this instance to bind');
} else {
    const doc2 = {
        ...doc,
        shapes: [...doc.shapes, {
            id: 's2', x: 20, y: 80, w: 100, h: 40, kind: 'device',
            label: 'GRID-POSITIVE-CONTROL', bind: dev0.name,
        }],
    };
    await req(`/api/boards/${boardId}/doc`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc2),
    });
    const setGrid = (bodyJson: unknown): Promise<{ status: number; text: string; body: Record<string, unknown> }> =>
        req(`/api/boards/${boardId}/grid`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bodyJson),
        });

    const valueOnly = await setGrid({ cols: 4, fields: ['cpu'] });
    if (valueOnly.status === 200) ok('a grid declaration with a value field is accepted');
    else bad('could not declare the grid', { status: valueOnly.status, text: valueOnly.text.slice(0, 150) });
    const gridded = await asDisplay('/api/display/board');
    const gridMeta = (gridded.body as { grid?: { cols?: number; fields?: unknown[] } }).grid;
    if (gridMeta?.cols === 4) ok('the grid declaration rides the display payload');
    else bad('grid declaration missing from the display payload', gridded.body);
    if (!gridded.text.includes(dev0.host)) {
        ok('an UNDECLARED identity field (the bound device IP) never reaches the display');
    } else {
        bad('the bound device IP reached a display with only `cpu` declared');
    }

    await setGrid({ cols: 4, fields: ['cpu', 'address'] });
    const withIp = await asDisplay('/api/display/board');
    if (withIp.text.includes(dev0.host)) {
        ok('declaring `address` serves the IP - the negative above was a choice, not an inability');
    } else {
        bad('`address` declared but the IP was not served, so the negative proves nothing');
    }

    const junk = await setGrid({ cols: 4, fields: ['cpu', 'favourite_color'] });
    if (junk.status === 400) ok('an unknown field key is refused at the write path, not stored-and-ignored');
    else bad('a junk field key was accepted', { status: junk.status });

    await setGrid({ cols: null, fields: [] });
}

// --- consequence 1: nothing enumerable ----------------------------------------
//
// A NOTE ON WHAT "REFUSED" MEANS HERE, because the first run of this test
// asserted the wrong thing. These come back 401 rather than 403, and that is
// not sloppiness - it is that `principalForToken` is called in exactly ONE
// route. Everywhere else a Bearer token is simply not a credential, so the
// caller is anonymous and never becomes a display principal at all. The
// display kind exists only inside the route that constructs it, which is a
// stronger property than every route remembering to refuse displays.
for (const path of ['/api/boards', '/api/alerts', '/api/devices', '/api/health']) {
    const r = await asDisplay(path);
    if (r.status === 401 || r.status === 403) {
        ok(`a display token is refused on ${path} (${r.status})`);
    } else {
        bad(`a display token reached ${path}`, { status: r.status, text: r.text.slice(0, 120) });
    }
}

// /api/me is the exception that proves it: it answers 200 to anyone, because
// the login page asks it whether to show a form. The property that matters is
// therefore not "it refuses" but "A DISPLAY TOKEN NEVER BECOMES A HUMAN
// SESSION" - asserted on the bytes, since that is where a leak would show.
const meAsDisplay = await asDisplay('/api/me');
if (meAsDisplay.body.authenticated === false
    && !meAsDisplay.text.includes('board') && !meAsDisplay.text.includes('exposure-test')) {
    ok('a display token is not a human session - /api/me reports unauthenticated and names nothing');
} else {
    bad('a display token was treated as a session by /api/me', { text: meAsDisplay.text.slice(0, 200) });
}

// --- consequence 5: revocation ------------------------------------------------
const tokenId = minted.body.id as string;
const revoked = await req(`/api/tokens/${tokenId}`, { method: 'DELETE' });
if (revoked.status === 200) ok('revocation is accepted');
else bad('revocation failed', { status: revoked.status });

const afterRevoke = await asDisplay('/api/display/board');
if (afterRevoke.status === 403) ok('a REVOKED token stops rendering immediately, not within a minute');
else bad('a revoked token still rendered', { status: afterRevoke.status });

const again = await req(`/api/tokens/${tokenId}`, { method: 'DELETE' });
if (again.status === 200 && (again.body.already === true)) {
    ok('revoking twice is a success reporting `already`, not a 404 that invites a retry');
} else {
    bad('a second revoke did not report already', { status: again.status, body: again.body });
}

// A garbage token must be refused the same way a revoked one is.
const garbage = await fetch(`${BASE}/api/display/board`, {
    headers: { authorization: `Bearer ${'z'.repeat(43)}` },
});
if (garbage.status === 403) ok('an unknown token is refused identically to a revoked one - no oracle');
else bad('an unknown token was treated differently from a revoked one', { status: garbage.status });

// CLEAN UP THE FIXTURE. Every run used to leave an exposure-test-<stamp>
// board on the lab, so the board list accumulated one per run - harmless
// singly, and exactly the litter that makes a real board list unreadable
// after a month. Deleting the board cascades its tokens, so this also
// revokes the display minted above.
const gone = await req(`/api/boards/${boardId}`, { method: 'DELETE' });
if (gone.status === 200) ok('the fixture board is deleted, and its token cascades with it');
else bad('could not clean up the fixture board', { status: gone.status });

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
