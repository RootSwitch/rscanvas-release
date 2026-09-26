// The render primitives, in ONE place because two consumers need the same
// ones: the browser (app.js) and the hostile round-trip test.
//
// THE POINT OF EXTRACTING THEM. tools/test-render-hostile.ts asserts that
// device-controlled strings cannot become markup. A test that re-implemented
// these four functions would assert that a COPY is safe, which is worth very
// little - the copy cannot rot in the same direction as the original. Sharing
// the module means the thing under test is the thing that ships.
//
// Every constructor here builds nodes and assigns text through textContent.
// None of them accepts markup, by construction rather than by convention -
// there is no parameter that could carry it. tools/check-dom-sinks.mjs is the
// other half: this module makes the safe path easy, that check makes the
// unsafe path fail the build.

/**
 * A table cell. `text` is DATA and is never parsed: sysName, ifAlias and
 * syslog bodies all arrive here, and the SNMPCanvas lesson is that
 * device-controlled text stays text all the way to the screen.
 */
export function cell(text, cls) {
    const td = document.createElement('td');
    td.textContent = text ?? '';
    if (cls) td.className = cls;
    return td;
}

/**
 * A cell carrying a shaped badge. Suite rule 5: state gets a SHAPE as well as
 * a colour, so it survives a colour-blind operator and a photograph of a wall
 * display. The class name is caller-controlled (never data); the text is data.
 */
export function pill(text, cls) {
    const td = document.createElement('td');
    td.appendChild(badge(text, cls));
    return td;
}

/**
 * The badge alone, for a cell that carries more than one thing.
 *
 * pill() returns a whole <td>, and appending one INSIDE another cell nests a
 * table cell in a cell - which the browser wraps in an anonymous table of its
 * own, with the cell padding again. The roster's transient row sat wider and
 * taller than its neighbours that way (operator, 2026-09-25), and the speed
 * column's "set" and "32-bit" badges, the rules' DISARMED and the
 * credentials' "env var" did the same more quietly. A pill is a CELL; a
 * badge is what goes inside one.
 */
export function badge(text, cls) {
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = text ?? '';
    return span;
}

/** A cell with a liveness dot before its label. */
export function dotCell(text, dotCls) {
    const td = document.createElement('td');
    const dot = document.createElement('span');
    dot.className = `dot ${dotCls}`;
    td.appendChild(dot);
    td.appendChild(document.createTextNode(text ?? ''));
    return td;
}

/** A row from prebuilt cells. */
export function rowEl(cells) {
    const tr = document.createElement('tr');
    for (const c of cells) tr.appendChild(c);
    return tr;
}
