# Release checklist

Use this checklist for a new release. See [verification status](release-readiness.md) for the latest published build.

## Public source repository

- Review the exact commit and all new tracked files before pushing.
- Scan reachable history and the source tree for credentials. Keep private captures, caches, recordings, browser profiles, and reports out of Git. Ignoring a file does not remove tracked or historical secrets.
- Check remote branches, tags, and release assets for retired private builds before a visibility change.
- Verify `npm ci`, `npm run build`, and package assertions from clean source without ignored caches. Keep third-party notices and the matching source ZIP.
- State experimental-language failures and hardware/quality limits. Public source does not establish full release acceptance.

## Release

1. Run `npm run test:models` and `npm run verify:release` from the repository root. Independent listening and physical-hardware evidence remain required for an unwaived full qualification.
2. Check the [release policy](../tooling/config/release-policy.json) for the candidate version. Record waivers separately from passes.
3. Run the PDF corpus and packaged reading and OCR checks. See [PDF verification](pdf-corpus.md).
4. Package a clean, reviewed commit. The source ZIP uses committed files only. Packaging restores the previous artifacts if replacement fails.
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

- `node tooling/scripts/assert-release-package.mjs dist` must pass. It rejects retired executables and bundled interpreters, including PDF.js QuickJS.
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
- Check the changelog for the release version and terms preserving GPL-3.0-or-later, MIT, and Apache License 2.0 rights.
- Verify no checkout script, price, purchase action, activation UI, or payment endpoint.
- Keep the scoped URL rewrite `0795bb621e1343c6be34d2baa6492787` for host `pagenarrator.com` and exactly `/cws-demo` or `/cws-demo.html`, rewriting only the origin path to `/pagenarrator-removed-capture-fixture`. This prevents retained Pages asset aliases from serving an old local capture; both public URLs must return HTTP 404. Query strings and reader-facing routes are unchanged.
- Keep the independent support mailbox Worker healthy. Follow `docs/support-mailbox.md` and verify the Gmail reply composer opens with `PageNarrator Support <support@pagenarrator.com>` in From.

Cloudflare Pages project `pagenarrator-site` builds `main` from the repository root. Use `npm run build:website` and output `artifacts/website`. Watch `website/*`, the root package files, `tooling/scripts/build-website*.mjs`, `tooling/scripts/build-homepage-css.mjs`, `tooling/scripts/build-localized-website.mjs`, `tooling/scripts/smoke-production.mjs`, and `tooling/config/language-rollout.json`.

## Store

- Upload the tested versioned ZIP after approval.
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
