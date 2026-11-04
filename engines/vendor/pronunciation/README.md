# English pronunciation data

PageNarrator's GPL-3.0-or-later phonemizer uses three separately licensed inputs.

| Input | License and attribution |
| --- | --- |
| CMUdict US words and phones | Carnegie Mellon University's permissive license in [cmudict/LICENSE](cmudict/LICENSE) |
| UK IPA records | GPL-3.0-only. The [upstream credits](ipa-dict/README.upstream.md) attribute ipacards to Melissa Boiko, formerly publishing as Leonardo Boiko, and credit eSpeak for the lexical transcriptions. Keep [GPL-3.0.txt](ipa-dict/GPL-3.0.txt). |
| Kokoro tokenizer fixtures | Apache-2.0 model metadata at revision `1939ad2a8e416c0acfeecc08a694d14ef25f2231` |

[sources.json](sources.json) pins lexical URLs, revisions, sizes, and hashes. The compiler checks phones against Kokoro's vocabulary and records skipped entries in [excluded.json](excluded.json).

- `node tooling/scripts/build-pronunciation-data.mjs --check` verifies the packaged dictionary offline. Use `--download` to fetch the pinned inputs.
- `node tooling/scripts/build-browser-phonemizer.mjs --check` verifies the source and WASM. Rebuild with Zig 0.17.0 set through `PN_ZIG`.
- `node tooling/scripts/probe-english-pronunciation.mjs --regression` checks native lookups against their source records. [Acceptance classifications](acceptance-classifications.json) explain four UK final-vowel differences while preserving their strict test outcomes.

Lookup uses contextual overrides, the dialect lexicon, known stems and compounds, then bounded spelling rules. These lexical checks cover the recorded cases. See [release verification](../../../docs/release-readiness.md) for listening and hardware coverage.
