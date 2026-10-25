# Security

Report vulnerabilities privately to **support@pagenarrator.com**. Include the version, steps to reproduce, and impact. Leave out private documents and credentials. No response time is promised.

Supported releases start at 1.0.0. Earlier private builds are retired.

## Data and access

Speech runs locally. Voice downloads use pinned revisions; JavaScript, WebAssembly, and English OCR ship in the extension. Online PDFs are fetched from their host. Resume stores URLs, titles, positions, and short text excerpts locally.

Messages check Chrome's sender identity. Content scripts cannot access extension storage. Websites cannot frame private extension pages. PDF scripts are disabled. Diagnostics stay local.

These controls do not protect against malicious device software, browser-debugger access, or access to the browser profile. Browser eviction can remove cached models and saved data.

## Checks

See `tests/security/`, `tests/e2e/content-pdf-security.e2e.js`, and `tests/ci/release-package-policy.test.js`. Run `npm run verify:release` before distribution. Automated checks do not establish independent penetration testing, listening quality, or physical hardware acceptance.
