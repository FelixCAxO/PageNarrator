import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { emitOnDemandContentScriptLoader } from '../../build/runtime-assets.js';

const manifest = JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'));

function chunk(fileName, options = {}) {
  return { type: 'chunk', fileName, imports: [], dynamicImports: [], ...options };
}

function contentBundle() {
  return {
    'assets/content-renamed.js': chunk('assets/content-renamed.js', {
      facadeModuleId: 'F:\\project\\src\\content.js',
      imports: ['assets/shared.js'],
      dynamicImports: ['assets/extraction-renamed.js'],
    }),
    'assets/shared.js': chunk('assets/shared.js', { imports: ['assets/tokens.js'] }),
    'assets/tokens.js': chunk('assets/tokens.js', { imports: ['assets/shared.js'] }),
    'assets/extraction-renamed.js': chunk('assets/extraction-renamed.js', {
      imports: ['assets/shared.js'],
      dynamicImports: ['assets/highlight.js'],
    }),
    'assets/highlight.js': chunk('assets/highlight.js'),
    'assets/reader-engine.js': chunk('assets/reader-engine.js'),
    'assets/pdf-viewer.js': chunk('assets/pdf-viewer.js'),
    'src/pdf-viewer.html': { type: 'asset', fileName: 'src/pdf-viewer.html', source: '' },
    'onnx/runtime.mjs': { type: 'asset', fileName: 'onnx/runtime.mjs', source: '' },
    'voice-packs/selected-manifest.json': {
      type: 'asset', fileName: 'voice-packs/selected-manifest.json', source: '{}',
    },
  };
}

describe('extension browser resource boundary', () => {
  it('omits the unused external API and denies embedding and non-UI playback commands', () => {
    expect(manifest).not.toHaveProperty('externally_connectable');
    expect(manifest.content_security_policy.extension_pages).toMatch(/(?:^|;)\s*frame-ancestors 'none'(?:;|$)/);
    expect(manifest).not.toHaveProperty('commands');
    expect(manifest).not.toHaveProperty('web_accessible_resources');
  });

  it('exposes only the complete content module graph, replacing any broad upstream resources', () => {
    const plugin = emitOnDemandContentScriptLoader();
    const input = {
      ...manifest,
      web_accessible_resources: [{ resources: ['assets/*.js', 'src/pdf-viewer.html'], matches: ['<all_urls>'] }],
    };
    const result = plugin.renderCrxManifest(input, contentBundle());

    expect(plugin.enforce).toBe('post');
    expect(result.web_accessible_resources).toEqual([{
      resources: [
        'assets/content-renamed.js',
        'assets/extraction-renamed.js',
        'assets/highlight.js',
        'assets/shared.js',
        'assets/tokens.js',
      ],
      matches: ['<all_urls>'],
    }]);
    expect(result.externally_connectable).toEqual(manifest.externally_connectable);
    expect(input.web_accessible_resources[0].resources).toEqual(['assets/*.js', 'src/pdf-viewer.html']);
  });

  it('keeps the injected loader aligned with the generated content entry name', () => {
    const emitFile = vi.fn();
    emitOnDemandContentScriptLoader().generateBundle.call({ emitFile }, {}, contentBundle());

    expect(emitFile).toHaveBeenCalledOnce();
    const [loader] = emitFile.mock.calls[0];
    expect(loader).toMatchObject({ type: 'asset', fileName: 'src/content.js' });
    expect(loader.source).toContain('chrome.runtime.getURL("assets/content-renamed.js")');
  });

  it('fails closed when the content entry is missing', () => {
    expect(() => emitOnDemandContentScriptLoader().renderCrxManifest(manifest, {}))
      .toThrow(/content.*entry/i);
  });

  it.each(['assets/missing.js', 'https://example.com/remote.js', 'onnx/runtime.mjs'])(
    'fails closed instead of exposing an unresolved or non-module import: %s',
    (dependency) => {
      const bundle = contentBundle();
      bundle['assets/shared.js'].imports.push(dependency);
      expect(() => emitOnDemandContentScriptLoader().renderCrxManifest(manifest, bundle))
        .toThrow(/content.*dependency/i);
    },
  );
});
