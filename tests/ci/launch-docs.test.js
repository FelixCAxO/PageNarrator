import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('free-product launch docs', () => {
  it('documents one artifact and the full clean-install capability check', () => {
    const checklist = read('docs/launch-checklist.md');
    expect(checklist).toContain('pagenarrator-<version>.zip');
    expect(checklist).toContain('clean-install');
    expect(checklist).toContain('3× speed');
    expect(checklist).toContain('no licensing or payment network request');
  });

  it('documents the static website and legacy redirects', () => {
    const checklist = read('docs/launch-checklist.md');
    expect(checklist).toContain('website/public');
    expect(checklist).toContain('/pricing`, `/activate`, and `/refund` redirect');
    expect(checklist).toContain('no checkout script, price, purchase action, activation UI, or payment endpoint');
  });

  it('documents the single built-extension test surface', () => {
    const liveTests = read('docs/live-extension-tests.md');
    const hardening = read('docs/regression-hardening.md');
    expect(liveTests).toContain('dist/');
    expect(liveTests).toContain('repeated unlimited reads');
    expect(liveTests).toContain('unconditional PDF access');
    expect(hardening).toContain('clean-install access to every advanced feature');
  });

  it('retains software constraints and explicitly identifies the waivable physical requirement', () => {
    const gates = JSON.parse(read('config/verification-gates.json'));
    expect(gates.release).toContain('npm run probe:tts:lower-spec-pdf:no-build');
    expect(gates.release).toContainEqual({ command: 'npm run requirements:tts -- --fail-on-non-pass', gateId: 'physical-hardware' });
  });

  it('provides exact current Chrome Web Store privacy-practice answers', () => {
    const listing = read('docs/cws-listing.md');

    expect(listing).toContain('## Privacy practices');
    expect(listing).toContain('### Single purpose');
    for (const permission of ['`activeTab`', '`scripting`', '`storage`', '`offscreen`', 'Optional host permissions']) {
      expect(listing, permission).toContain(permission);
    }
    expect(listing).toContain('Remote code: No');
    for (const dataType of ['Website content', 'Web history', 'Authentication information']) {
      expect(listing, dataType).toContain(dataType);
    }
    expect(listing).toContain('legacy credentials');
    expect(listing).toContain('until automatic upgrade cleanup succeeds');
    expect(listing).toContain('accepts no new custom-provider credentials');
    expect(listing).toContain('https://pagenarrator.com/privacy');
  });

  it('fits clean-install reviewer instructions into the dashboard field', () => {
    const notes = read('docs/cws-review-notes.md').replace(/\r\n/g, '\n');
    const instructions = notes.match(/## Dashboard test instructions \(500-character field\)\n[\s\S]*?```text\n([^`]+)\n```/)?.[1] || '';

    expect(instructions.length).toBeGreaterThan(0);
    expect(instructions.length).toBeLessThanOrEqual(500);
    for (const required of ['No account required', 'internet', 'Prepare voice', 'Read page', 'CPU/WASM', 'Allow access to file URLs']) {
      expect(instructions, required).toContain(required);
    }
  });

  it('ships the reviewed Short description as the Store summary', () => {
    // The dashboard shows the packaged manifest description as the summary; it has no field of its own.
    const manifest = JSON.parse(read('manifest.json'));
    const summary = read('docs/cws-listing.md').replace(/\r\n/g, '\n').match(/## Short description\n\n(.+)\n/)?.[1];

    expect(manifest.description).toBe('__MSG_extensionDescription__');
    const english = JSON.parse(read(`_locales/${manifest.default_locale}/messages.json`));
    expect(english.extensionDescription.message).toBe(summary);
    expect(summary.length).toBeLessThanOrEqual(132);
  });

  it('justifies exactly the permissions the packaged manifest requests', () => {
    const manifest = JSON.parse(read('manifest.json'));
    const section = read('docs/cws-listing.md').replace(/\r\n/g, '\n').match(/### Permission justifications\n([\s\S]*?)\n#/)?.[1] || '';
    const justified = [...section.matchAll(/^- `([^`]+)`:/gm)].map(([, permission]) => permission);

    expect(justified.sort()).toEqual([...manifest.permissions].sort());
    expect(manifest.host_permissions || []).toEqual([]);
    expect(manifest.optional_host_permissions.length).toBeGreaterThan(0);
    expect(section).toMatch(/^- Optional host permissions:/m);
    for (const [, , answer] of section.matchAll(/^- `([^`]+)`: (.+)$/gm)) {
      expect(answer.length).toBeLessThanOrEqual(1000);
    }
    expect(section).toContain('voice preparation');
  });
});
