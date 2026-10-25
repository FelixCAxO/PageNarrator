# Reader guide

Open PageNarrator from the Chrome toolbar. Playback continues when you close the popup.

## Start reading

- **Read page:** reads from the current visible section or saved position. Restart and finished-page reads start at the top.
- **Read selected:** reads the text you highlighted on a webpage or in the PDF viewer.
- **Prepare voice:** downloads missing files from Hugging Face and loads the voice. First setup can take time. Narrated text stays on your device.

Use Kokoro for the ten English voices. OmniVoice adds experimental multilingual speech and requires WebGPU with fp16 support. See [hardware](requirements-hardware.md) and [voices](multilingual-tts.md).

## Playback

The player shows the title, status, progress, and words left. Use Back (previous section), Pause/Resume, Stop, and Next. Stop stays available while speech is being prepared.

Open **Transcript** to follow the text. Open **Reading queue** to search, choose a section, or enter its number and press Go. Both appear after text loads.

There are no global playback shortcuts in v1.0.0. Use Tab and Enter to reach the popup controls.

## Settings

Changes save automatically. Voice changes apply at the next section.

| Setting | What it does |
| --- | --- |
| Voice settings | Choose the language and voice. Set speed from 0.5× to 3×. |
| Section pause | Adjust the pause between sections. |
| Performance | Auto, High quality, Balanced, or Battery saver. |
| Processing | Auto, WebGPU, or CPU / WebAssembly for Kokoro. |
| Release voice memory when idle | Unload the voice when it is no longer needed. |
| Skip code snippets | Leave code blocks out of automatic reading. |
| Highlights | Set area and word colors and opacity. |

Advanced settings show the active hardware path after reading starts. Cached files work offline for the same voice and processing mode. Another voice or mode, or cleared storage, may require another download.

Start with **Auto**. It adapts preparation and buffering to the device and observed playback. **High quality** uses longer sections and more look-ahead, which can use more memory; it does not select different voice weights. **Balanced** reduces that work. **Battery saver** uses shorter sections and progressive preparation; its name is not a measured energy-saving guarantee. These settings differ from **Processing**, which chooses GPU or CPU execution.

First Kokoro setup downloads about 93 MB on CPU or 326 MB on GPU, including one voice. Additional voices are about 0.5 MB each. Downloading, verifying files, and preparing the engine are separate stages; completed bytes do not mean the voice is ready yet.

## Updating

1. Stop playback and extract the new release ZIP into a temporary folder.
2. Copy its contents into the original extension folder, replacing existing files. Keep the original folder path.
3. Open `chrome://extensions` and click **Reload** on the existing PageNarrator entry. Refresh your reading tabs.

Keeping the same entry and path preserves the extension identity, settings, and saved positions. Pinned voice files can stay cached across updates. Removing the extension or clearing its storage deletes local data. For source installations, update and rebuild into the same `dist/` folder before reloading.

## PDFs and recovery

The PDF viewer supports page navigation, zoom from 50% to 300%, rotation, fit, selection, and reading. Local files need **Allow access to file URLs** in Chrome's extension details. English scans use local OCR; check the recognized text against the page.

If **Read selected** finds no text, select a passage and retry. Chrome settings pages and other protected pages cannot be read. Grant website access only when prompted for a document you chose. For failed voice setup, check the connection and retry. See [support](https://pagenarrator.com/support).

## Host-page layout contract

Highlight overlays use `position: fixed`. Extension code must not write inline layout styles to `body` or `document.documentElement`, rewrite viewport metadata, or use `chrome.scripting.insertCSS`.

The PDF viewer uses deterministic render-window management and applies CSS text-range highlight first; the queued next-region overlay is disabled for PDFs.

## Developer notes

The offscreen engine owns playback. Popup actions use `src/lib/reader-engine-host.js` once per request. Pending controls stay disabled until the request ends; Stop remains available. Queue updates preserve an edited section number and update only the active item when the content is unchanged.

Settings load through `src/lib/playback-settings.js` and `src/lib/reader-engine-storage-adapter.js`. Invalid values are normalized and saved back without interrupting playback.

Checks: `tests/ci/popup-controller-flows.test.js`, `tests/ci/popup-preparing-state.test.js`, `tests/ci/advanced-settings.test.js`, `tests/e2e/all-functions-and-settings.e2e.js`, and `tests/e2e/popup-read.e2e.js`.
