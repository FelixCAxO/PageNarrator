# Release checklist

The latest published release is 1.0.2, authorized by the maintainer on 2026-10-27 with the remaining limitations disclosed in its public verification report. The repository was recreated with one initial commit; retired earlier release assets were removed. New releases, deployments, Store submissions, and visibility changes need the maintainer's instruction. Do not enable non-deployment GitHub Actions.

## Public source repository

- Review the exact commit and all new tracked files before pushing.
- Scan reachable history and the source tree for credentials. Keep private captures, caches, recordings, browser profiles, and reports out of Git. Ignoring a file does not remove tracked or historical secrets.
- Check remote branches, tags, and release assets for retired private builds before a visibility change.
- Verify `npm ci`, `npm run build`, and package assertions from clean source without ignored caches. Keep third-party notices and the matching source ZIP.
- State experimental-language failures and hardware/quality limits. Public source does not establish full release acceptance.

## Release

1. Run `npm run test:models` and `npm run verify:release` from the repository root. The full gate needs the pinned private PDF library references.
2. Record v1.0.0's waived physical hardware and human/listening reviews (2026-10-24) and accepted Kokoro duration/PCM limitation (2026-10-25). These are not passes. Keep failed/unqualified diagnostics and unchanged thresholds. All other applicable automatic checks remain required; the explicit v1.0.1 extension was authorized on 2026-10-25 and neither version grants exceptions to v1.0.2. See [policy](../config/release-policy.json) and [verification status](release-readiness.md).
3. Run `npm run test:pdf-acceptance` against revision 05: 90 private reference pages plus ten authored controls. Reference generation alone is not a product pass. Keep results and failures. The separate historical lane is `npm run test:pdf-acceptance:historical`; see [PDF acceptance](pdf-corpus.md#fixed-pdf-acceptance-benchmark).
4. Build from a clean reviewed commit. Source packaging rejects tracked edits and stages an exact `git archive` export of HEAD. Untracked and ignored files never enter the source ZIP. A distributed source ZIP can be rebuilt only with its declared files unchanged under `SOURCE-MANIFEST.json`.
5. Distribute `releases/pagenarrator-<version>.zip` and `releases/pagenarrator-<version>-source.zip` together. Fixed entry times make identical contents reproduce the ZIP hash. Compare the upload's SHA-256 with the tested file.
6. Attach a public verification report to the same release. Record the exact source commit and archive hashes, tool/browser versions, commands and results, documented skips, waived checks, and accepted failures. Publish only an allowlist of summary fields: exclude private document names/text, absolute paths, browser profiles, credentials, and raw diagnostics. Link the report from the release notes and verification guide. A partial public rerun must stay separate from the historical full-gate record.

### Canonical source export

Use a fresh detached worktree for the build. Packaging exports canonical committed bytes through `git archive`; Git and `tar` must be available. From PowerShell at the repository root, with a new destination:

```powershell
$candidateId = git rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw 'Candidate commit could not be resolved.' }
$exportDir = Join-Path (Get-Location) "tmp/release-$candidateId"
New-Item -ItemType Directory -Path $exportDir -ErrorAction Stop | Out-Null
git -c core.autocrlf=false worktree add --detach "$exportDir/source" $candidateId
if ($LASTEXITCODE -ne 0) { throw 'Clean worktree creation failed.' }
$previousCandidateId = $env:PN_CANDIDATE_ID
$env:PN_CANDIDATE_ID = $candidateId
Push-Location "$exportDir/source"
try {
  npm ci
  if ($LASTEXITCODE -ne 0) { throw 'Clean dependency installation failed.' }
  npm run package
  if ($LASTEXITCODE -ne 0) { throw 'Release packaging failed.' }
} finally {
  Pop-Location
  $env:PN_CANDIDATE_ID = $previousCandidateId
}
```

Use both ZIPs from the worktree's `source/releases/`. To rebuild a distributed source ZIP without Git metadata, set `PN_CANDIDATE_ID` to the `candidateId` in `SOURCE-MANIFEST.json` before the same install/package commands. Keep that manifest alongside the source; a plain directory export without it is refused.

### Final checks

- `node scripts/assert-release-package.mjs dist` must pass. It rejects retired executables and bundled interpreters, including PDF.js QuickJS.
- Check clean-install, webpage, selected-text, PDF, 3× speed, highlights, cleanup, pauses, and resume.
- On a clean install, missing voice files download from Hugging Face only after Prepare voice or Read. Test failure/retry, restart, offline reuse of the same cached voice/mode, and a required download after cache clearing. Model requests must contain no narration text. Packaged English OCR must work offline.
- Confirm no licensing or payment network request.

## Website

- Use `npm run deploy:website`. It builds the reader-facing site in ignored `artifacts/website/` and deploys that filtered directory. Do not upload raw `website/public`: it contains local capture fixtures.
- Verify current Pages build settings before publishing. Git builds must use the same filtered output.
- Keep the GitHub ZIP installation path until Store publication. After approval, use the verified listing URL and update availability checks.
- Run `npm run smoke:production` for pages, sitemap, redirects, links, assets, and a missing route that must return HTTP 404 with `404.html`.
- Check desktop and mobile pages. `npm run test:benchmarks` checks layout at 320, 375, 768, and 1366 px.
- Verify `/pricing`, `/activate`, and `/refund` redirect to `/chrome-extension`.
- Keep Cloudflare Single Redirect `54d11e0e1dc54b96b256b400ac3bbc37` for `https://www.pagenarrator.com/*` → `https://pagenarrator.com/${1}`, HTTP 301 with query strings. Path redirects stay in `_redirects`.
- Check changelog v1.0.2 and terms preserving GPL-3.0-or-later, MIT, and Apache License 2.0 rights.
- Verify no checkout script, price, purchase action, activation UI, or payment endpoint.
- Keep the scoped URL rewrite `0795bb621e1343c6be34d2baa6492787` for host `pagenarrator.com` and exactly `/cws-demo` or `/cws-demo.html`, rewriting only the origin path to `/pagenarrator-removed-capture-fixture`. This prevents retained Pages asset aliases from serving an old local capture; both public URLs must return HTTP 404. Query strings and reader-facing routes are unchanged.
- Keep the independent support mailbox Worker healthy. Follow `docs/support-mailbox.md` and verify the Gmail reply composer opens with `PageNarrator Support <support@pagenarrator.com>` in From.

<details>
<summary>Recorded Pages setup and rollback target</summary>

Project `pagenarrator-site` uses repository `FelixCAxO/PageNarrator` (ID `1422933371`), branch `main`. On 2026-10-26 its Git build settings were corrected to repository root, command `npm run build:website`, and filtered output `artifacts/website`. Production builds remain on, previews/PR comments off. Watch paths cover `website/*`, the website build/smoke scripts, locale rollout config and package metadata. Verify these settings before publishing; never restore the earlier raw `website/public` upload.

Retired project `pagenarrator` points to deleted repository `1224875446` with automatic builds disabled. Retain its last successful deployment for rollback. Domain rollback needs both custom-domain associations and CNAME targets restored to `pagenarrator.pages.dev`. The September 26, 2026 smoke record checked 16 pages, 20 redirects, and 22 resources.

</details>

## Store

- Upload the tested versioned ZIP only when authorized. Version 1.0.0 starts public history; earlier private releases are retired.
- Use `docs/cws-listing.md`. Its short description must match the manifest `description` used as the Store summary.
- Delete every old rejected screenshot and promo tile from the Chrome Web Store dashboard. Upload only:
  - `docs/cws-listing/screenshot-01-toolbar-player-idle.png`
  - `docs/cws-listing/screenshot-02-toolbar-player-reading.png`
  - `docs/cws-listing/screenshot-03-toolbar-player-settings.png`
  - `docs/cws-listing/screenshot-04-toolbar-player-pdf.png`
  - `docs/cws-listing/screenshot-05-omnivoice-controls.png`
  - `docs/cws-listing/promo-tile-440x280.png`
- CWS screenshots must not include install CTAs, Add to Chrome buttons, Chrome Web Store listing text, or acquisition-page copy.
- Use owned demo content with no Google marks, Google-authored documents, real email addresses, or removed features. Run `npm run test:cws-media`. The description uses “for Google Chrome™” and Google's trademark attribution.
- Copy the listing's single-purpose, permission, remote-code, and handled-data answers. Check the actual dashboard selections and all Limited Use certifications.
- Keep the popup's pre-read disclosure and live privacy policy consistent with the submitted build and manifest permissions.
