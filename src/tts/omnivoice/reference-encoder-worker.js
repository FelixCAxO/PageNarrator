// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
import { encodeOmniVoiceReference } from './reference-encoder.js';

self.onmessage = async ({ data }) => {
  try {
    const result = await encodeOmniVoiceReference(data.pcm, {
      onProgress: (loaded, total) => self.postMessage({ progress: { loaded, total } }),
    });
    self.postMessage({ result }, { transfer: [result.codes.buffer] });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
