# Security

Report vulnerabilities privately to **support@pagenarrator.com**. Include the version, steps to reproduce, and impact. Leave out private documents and credentials.

## Data and access

Speech runs locally. Voice downloads use pinned revisions; JavaScript, WebAssembly, and English OCR ship in the extension. Online PDFs are fetched from their host. Resume stores URLs, titles, positions, and short text excerpts locally.

Personal voice imports run in a packaged worker. The original audio is used during import. The preset stores its name, spoken language, transcript, and voice codes in trusted extension storage. The import worker fetches pinned model data and never sends the audio or transcript to a server.

Messages check Chrome's sender identity. Content scripts cannot access extension storage. Websites cannot frame private extension pages. The PDF viewer waits for a trusted read request for the matching source before it fetches the document. PDF scripts are disabled. Diagnostics stay local.

These controls do not protect against malicious device software, browser-debugger access, or access to the browser profile. Browser eviction can remove cached models and saved data.

## Checks

See `tests/security/`, `tests/e2e/content-pdf-security.e2e.js`, and `tests/ci/release-package-policy.test.js`. Run `npm run verify:release` before distribution. Automated checks do not establish independent penetration testing, listening quality, or physical hardware acceptance.
