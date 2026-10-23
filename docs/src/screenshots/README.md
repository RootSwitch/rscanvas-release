# The source of the README's screenshots

`docs/images/*.png` are rendered, never taken by hand:

    node tools/make-screenshots.mjs              all of them
    node tools/make-screenshots.mjs dashboard    one

The script serves this checkout's real web client (`public/`) and answers
its API from `recording/`, then photographs it in headless Chrome or Edge at
1440x900 - one canvas size for every picture - with the clock frozen at the
recording's `capturedAt` and the zone set to America/Chicago, so relative
times and window labels read the same on every run. No sign-in is involved:
the page is told it is an admin and every write is refused. A request the
recording has no answer for fails the run rather than drawing a gap.

## The recording

The demo network, recorded 2026-10-23: a small company - headquarters, two
branches and a cloud site, 38 devices - simulated by RSFleet and polled by a
real RSCanvas (0.1.0-alpha.10) for two weeks, the same network the online
demo replays. It was made by rendering the shots THROUGH that instance:

    NODE_TLS_REJECT_UNAUTHORIZED=0 node tools/make-screenshots.mjs --capture https://<instance>:18080

which saves every answer the shots ask for, scrubbed, to `recording/`
(tools/screenshot-recording.mjs): any private address outside the demo's own
ranges refuses the capture, and the lab's own names - and anything else the
uncommitted tools/screenshots.local.mjs lists - are rewritten. The pictures'
clock stands 45 seconds after the capture began, so every answer is already
in the past; a capture that outlasts that margin is refused. The committed
pictures are then rendered from the recording itself, so they can be
rebuilt from what sits beside them. (A few bytes can differ between two
renders - the browser's own variance - never a word.)

Eight pictures:

| picture | what it shows |
|---|---|
| `dashboard.png` | where a sign-in lands: open alerts, health by location and application, service health |
| `services.png` | the Dashboard's service health: each site's voice and bandwidth, then the web and TCP checks |
| `services-report.png` | the services report: Branch 2's voice test over the last fortnight, a day a row (at the Wide width, so its fourteen columns fit) |
| `device.png` | the GPU server's page, its first GPU's temperature chart open |
| `devices.png` | the device list, problems first |
| `report.png` | the traffic report: the edge firewall's two uplinks over the last week |
| `wall.png` | the NOC board, divided by location |
| `system.png` | the System tab, its health section open |

`--recording DIR` and `--out DIR` render a preview elsewhere.

Until this recording, the pictures came from a trimmed, dressed snapshot of
the 30,000-entity load-test lab (`fixture/` and `dress.mjs`, in git history
before 2026-10-23).
