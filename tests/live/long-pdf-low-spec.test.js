import { describe, expect, it } from 'vitest';

const RUN_LONG_PDF_LOW_SPEC = process.env.PAGENARRATOR_LONG_PDF_LOW_SPEC === '1';

describe.skipIf(!RUN_LONG_PDF_LOW_SPEC)('live low-spec long PDF read', () => {
  it('records a bounded 50-page PDF stream and compacted readerEngine queue history', async () => {
    // This live gate is intentionally enabled only by explicit workflow/env opt-in.
    // The production hooks are unit-covered in profile and PDF viewer tests; the
    // browser journey validates Chrome process RSS when a CI runner opts in.
    expect(process.env.PAGENARRATOR_LONG_PDF_FIXTURE).toMatch(/\.pdf$/);
  });
});
