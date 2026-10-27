import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { releaseExtensionAsset, releaseTestEnvironment, verifyReleaseZip } from '../../scripts/test-github-release.mjs';

describe('GitHub release E2E input', () => {
  const bytes = Buffer.from('published extension ZIP');
  const asset = { name: 'pagenarrator-1.0.1.zip', digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };

  it('selects the published extension ZIP and rejects missing integrity metadata or changed bytes', () => {
    expect(releaseExtensionAsset({ tagName: 'v1.0.1', assets: [
      { ...asset, name: 'pagenarrator-1.0.1-source.zip' }, asset,
    ] })).toBe(asset);
    expect(verifyReleaseZip(bytes, asset)).toBe(asset.digest.slice(7));
    expect(() => verifyReleaseZip(Buffer.from('different build'), asset)).toThrow('checksum mismatch');
    expect(() => releaseExtensionAsset({ tagName: '../dist', assets: [asset] })).toThrow('Invalid release tag');
    expect(() => releaseExtensionAsset({ tagName: 'v1.0.2', assets: [asset] })).toThrow('Missing ZIP');
    expect(() => releaseExtensionAsset({ tagName: 'v1.0.1', assets: [{ ...asset, digest: null }] })).toThrow('digest');
  });

  it('overrides a local build path and enables real Kokoro and OmniVoice journeys', () => {
    expect(releaseTestEnvironment('/downloaded/extension', {
      PN_E2E_EXTENSION_DIR: '/local/dist', PN_E2E_REAL_MODEL: '0', PN_E2E_OMNIVOICE: '0', EXISTING: 'kept',
    })).toEqual({ PN_E2E_EXTENSION_DIR: '/downloaded/extension', PN_E2E_REAL_MODEL: '1', PN_E2E_OMNIVOICE: '1', EXISTING: 'kept' });
  });
});
