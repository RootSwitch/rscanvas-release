# The source of the README's screenshots

`docs/images/*.png` are rendered, never taken by hand:

    node tools/make-screenshots.mjs              all of them
    node tools/make-screenshots.mjs dashboard    one

The script serves this checkout's real web client (`public/`) and answers
its API from `fixture/`, then photographs it in headless Chrome or Edge at
1440x900 - one canvas size for every picture - with the clock frozen at
`fixture/meta.json`'s `capturedAt` and the zone set to America/Chicago, so
relative times and window labels read the same on every run. No sign-in is
involved: the page is told it is an admin and every write is refused.

## The fixture

A snapshot of the web API's answers from the 30,000-entity load-test lab,
taken 2026-09-26 and trimmed to what the six pictures need:

- 45 of the lab's 1,550 synthetic devices - 40 up, 5 of the dead ones - and
  the alerts, reachability events and audit rows that belong to them.
- The Dashboard's answers for all three windows, one device's page, its
  chart and round-trip history, and one traffic report (`meta.json` names
  its interfaces and dates).
- The wall's board (`wall.json`): the same 45 devices, on a board created
  on the lab for the picture with the product's own shape generator and
  set to a glance grid - columns fitted to the screen, and type icon, CPU,
  memory, top traffic and ping on each tile. Its colours are the lab's own:
  every mock device has five dead links, so the healthy ones wear amber.
- Lightly dressed, so the pictures show the states the page can draw: the
  devices carry rack locations, one an application, two are declared
  transient (one present, one away) and one is muted. Nothing else was
  altered; the traffic is the mock fleet's own, which is why its links carry
  terabytes a day.
- Addresses rewritten by the same rules `tools/make-public-tree.sh` applies
  to the public tree, before rendering - a picture cannot be scrubbed
  afterwards.

To refresh it, snapshot the same routes from a lab instance (read-only
GETs as an admin), apply the same trim and rewrite, and re-run the script.
The pictures should change only where the page or the data did.
