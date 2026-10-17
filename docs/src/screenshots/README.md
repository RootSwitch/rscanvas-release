# The source of the README's screenshots

`docs/images/*.png` are rendered, never taken by hand:

    node tools/make-screenshots.mjs              all of them
    node tools/make-screenshots.mjs dashboard    one

The script serves this checkout's real web client (`public/`) and answers
its API from `fixture/`, dressed by `dress.mjs` as it is loaded, then photographs it in headless Chrome or Edge at
1440x900 - one canvas size for every picture - with the clock frozen at
`fixture/meta.json`'s `capturedAt` and the zone set to America/Chicago, so
relative times and window labels read the same on every run. No sign-in is
involved: the page is told it is an admin and every write is refused.

## Moving to the demo network (2026-10-09)

The next round of pictures comes from the demo network - Canvas Suite's
company, polled by a real RSCanvas for the online demo - so the README shows
the NOC board divided by location and the service checks live. Captured by
rendering the shots THROUGH that instance:

    NODE_TLS_REJECT_UNAUTHORIZED=0 node tools/make-screenshots.mjs --capture https://<instance>:18080

which saves every answer the shots ask for, scrubbed, to `recording/`
(tools/screenshot-recording.mjs: any private address outside the demo's own
ranges refuses the capture, and the lab's own names are rewritten by the
uncommitted tools/screenshots.local.mjs). Once `recording/` exists a plain
run renders from it, and fails on any request it has no answer for. Eight
pictures: the Dashboard, its service health, the services report (Branch 2's
voice test), the GPU server's page, the device list, the traffic report, the
NOC board and the health page. `--recording DIR` and `--out DIR` render a
preview elsewhere. Until then, the lab's fixture below still makes the six
pictures the README has.

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
- Dressed by `dress.mjs` (2026-09-30), in code so the snapshot stays the
  lab's and every change is there to read. The lab's devices are one mock
  repeated - a two-core Linux box with 52 ports, five of them dead - which
  made a wall of forty identical amber tiles. The dressing gives the 45
  devices eight kinds (router, firewall, switches, servers, NAS, storage,
  virtual machines, UPSes) across locations and applications; leaves most
  of them clean, with one alert each on three and two down; makes
  lab-node-16100 a render workstation with two GPUs and two ports named
  eth0 and eth1; puts the transient and muted declarations on lab virtual
  machines; rebuilds the Dashboard's CPU and memory lists from those
  devices; and supplies the two answers the snapshot predates (the
  Dashboard's device health and the System tab's group alerts). The
  traffic, histories and report are still the lab's own, which is why its
  links carry terabytes a day.
- Addresses rewritten by the same rules `tools/make-public-tree.sh` applies
  to the public tree, before rendering - a picture cannot be scrubbed
  afterwards.

To refresh it, snapshot the same routes from a lab instance (read-only
GETs as an admin), apply the same trim and rewrite, and re-run the script.
The pictures should change only where the page or the data did.
