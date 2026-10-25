import { describe, expect, it } from 'vitest';
import { createPdfMemoryProfile } from '../../src/lib/pdf-memory-profile.js';

describe('PDF memory profile', () => {
  it('uses low memory settings on 4 GB devices', () => {
    const profile = createPdfMemoryProfile({
      navigatorRef: { deviceMemory: 4 },
      pageCount: 20,
    });

    expect(profile).toMatchObject({
      name: 'low',
      preloadBehind: 1,
      preloadAhead: 1,
      maxRenderedPages: 3,
      renderWindowByteBudget: 3_000_000,
      rootMarginPx: 0,
      unloadDelayMs: 150,
      pdfWordTrailLength: 4,
      showQueuedPdfRegion: false,
      preferCssOnlyPdfRegion: true,
    });
  });

  it('uses the hardest render budget for large documents even on unknown memory', () => {
    const profile = createPdfMemoryProfile({
      navigatorRef: {},
      pageCount: 120,
    });

    expect(profile.name).toBe('large');
    expect(profile.preloadBehind).toBe(0);
    expect(profile.preloadAhead).toBe(1);
    expect(profile.maxRenderedPages).toBe(2);
    expect(profile.renderWindowByteBudget).toBeLessThanOrEqual(2_000_000);
    expect(profile.rootMarginPx).toBe(0);
  });

  it('keeps quality page budget on higher-memory devices', () => {
    const profile = createPdfMemoryProfile({
      navigatorRef: { deviceMemory: 16 },
      pageCount: 20,
    });

    expect(profile).toMatchObject({
      name: 'quality',
      preloadBehind: 2,
      preloadAhead: 2,
      maxRenderedPages: 5,
      renderWindowByteBudget: 5_000_000,
      rootMarginPx: 0,
      unloadDelayMs: 500,
      pdfWordTrailLength: 4,
      showQueuedPdfRegion: false,
      preferCssOnlyPdfRegion: true,
    });
  });

  it('keeps a fading PDF word trail even under the large-document render budget', () => {
    const profile = createPdfMemoryProfile({
      navigatorRef: { deviceMemory: 4 },
      pageCount: 120,
    });

    expect(profile).toMatchObject({
      name: 'large',
      preloadBehind: 0,
      preloadAhead: 1,
      maxRenderedPages: 2,
      renderWindowByteBudget: 2_000_000,
      pdfWordTrailLength: 4,
    });
  });
});
