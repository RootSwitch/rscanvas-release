# Third-party artwork notices

The RSCanvas mark (`public/favicon.svg`, the favicon and the header logo) is
not third-party: it is the Canvas Suite mark, drawn by the author for the
suite RSCanvas supersedes, and it is released with the project under the
same licence. Nothing below applies to it. The same goes for its two raster
copies, `public/favicon.ico` and `public/apple-touch-icon.png`: they are
rendered from that SVG by `tools/make-favicons.mjs`, carry its hash, and are
the same work at a fixed size.

RSCanvas draws device-type icons on wall tiles. The artwork comes from two
upstream sets, and `public/stencils.js` is generated from them by
`tools/build-stencils.mjs`, which CLASSIFIES each icon by its own signature
rather than trusting a list - so this file cannot silently drift out of date
while the build keeps succeeding.

Current contents of `public/stencils.js`:

| icon | set |
|---|---|
| firewall, switch, router, server, nas, storage, access point | Affinity |
| ups, vm | Tabler |

## Affinity - Unlicense (public domain)

<https://github.com/ecceman/affinity>

Released under the Unlicense: a public-domain dedication. No attribution is
required and none is claimed; this entry exists so a reader can tell which
icons carry obligations and which do not.

## Tabler Icons - MIT

<https://tabler.io/icons> - <https://github.com/tabler/tabler-icons>

MIT requires the copyright and permission notice to travel with the work, so
it travels here:

    MIT License

    Copyright (c) 2020-2024 Paweł Kuna

    Permission is hereby granted, free of charge, to any person obtaining a
    copy of this software and associated documentation files (the
    "Software"), to deal in the Software without restriction, including
    without limitation the rights to use, copy, modify, merge, publish,
    distribute, sublicense, and/or sell copies of the Software, and to permit
    persons to whom the Software is furnished to do so, subject to the
    following conditions:

    The above copyright notice and this permission notice shall be included
    in all copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
    OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
    MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
    NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
    DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
    OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
    USE OR OTHER DEALINGS IN THE SOFTWARE.

Both sets are redistributed with their colours rewritten to `currentColor`,
which is a modification the licences permit and which is what lets one icon
serve all 31 themes.

## What is deliberately NOT here

No operating-system or vendor logos. A penguin beside Linux hosts was the
idea that started this feature, and it stops at the first trademark: OS and
vendor marks are owned, their usage terms vary per holder, and a monitoring
wall is not worth an argument about any of them. Device TYPES are generic
shapes - a firewall, a switch, a rack - and carry no such claim.
