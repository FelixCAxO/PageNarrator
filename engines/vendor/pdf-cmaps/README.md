# Adobe character-map data

These 168 textual mappings are Adobe data. `manifest.json` pins official source URLs, Git blobs, sizes, SHA-256 hashes, and notices. Original notices stay in effect; the data are not relicensed as PageNarrator code. PDF.js comparisons use separate development CMaps; the product does not retain its compressed format.

`src/pdf/cmap-data.js` is PageNarrator's bounded reader for code spaces, CID/Unicode mappings, writing modes, and base maps. It never executes PostScript wrappers. Retaining mappings does not qualify rendering, selection, or narration.

Run `node scripts/import-pdf-cmaps.mjs --download` to import pinned data, then `node scripts/import-pdf-cmaps.mjs --check` for offline verification. The runtime allowlist uses the same manifest. No Adobe/PDF.js parser or runtime is copied.
