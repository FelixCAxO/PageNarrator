# Chrome Web Store review

**A dedicated GPU is recommended for multilingual voices and voice cloning.** These features require WebGPU with fp16 support. Compatible integrated GPUs may work, but performance has not been verified. The suggested 8 GB+ VRAM and 8 GB+ system RAM setup is provisional, not a tested minimum.

For CPU-only Kokoro, aim for a modern 6-core CPU or better and 8 GB+ system RAM. Expect longer startup times and possible pauses between sections. These are suggested starting points, not verified minimums or guarantees of smooth playback.

Use the submitted extension ZIP. No account, activation, or special build is needed.

1. Pin PageNarrator and open an accessible English article.
2. With internet access, choose **Prepare voice** or **Read page**. Missing files download from Hugging Face. The hosts receive your IP address and file paths, not narration text. Wait for setup to finish.
3. Check pause/resume, highlights, selected text, and playback after closing the popup.
4. Open a PDF. Grant access to its origin if prompted. Local files need **Allow access to file URLs**. Scans use local English OCR; check accuracy against the image. Scan quality and layout affect the result.
5. Check the ten English voices and experimental OmniVoice catalog. OmniVoice needs WebGPU with fp16 and a separate download of about 1.35 GB. Kokoro has a slower CPU fallback.
6. Restart the browser and test the same cached voice and mode offline. A different mode or a cleared or evicted cache may need another download.

All executable code and English OCR files ship in the package. Voice data downloads use pinned revisions. The four required permissions support reading, local storage, and offscreen playback. Optional origins cover documents the user chooses. No access restriction is bypassed.

## Dashboard test instructions (500-character field)

Leave username and password blank. Paste this text into **Additional instructions** (Ytterligare anvisningar).

```text
No account required. Open an accessible English article and the PageNarrator toolbar. With internet access, choose Prepare voice; wait for download and preparation, then click Read page. Test pause/resume, highlighting and playback after closing the popup. CPU/WASM works but is slower than WebGPU. For online PDFs, allow the requested origin; local PDFs require Allow access to file URLs. Scans use English OCR. The same cached voice/mode works offline.
```
