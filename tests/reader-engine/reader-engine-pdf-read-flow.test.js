import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('toolbar player PDF read flow', () => {
  it('uses the PageNarrator viewer as the PDF chunk owner before falling back to toolbar-player extraction', () => {
    const targetResolver = readFileSync(new URL('../../src/lib/reader-engine-target-resolver.js', import.meta.url), 'utf8');
    const viewerStreamImport = "import { createPdfViewerStreamingArticle } from './lib/pdf-viewer-chunk-stream.js';";
    const viewerOwnedBranch = 'if (isPdfTab) {';
    const readerEngineExtraction = 'const article = await extractReadableTab({';

    expect(targetResolver).toContain(viewerStreamImport.replace('./lib/', './'));
    expect(targetResolver).toContain('return createPdfViewerStreamingArticle({');
    expect(targetResolver.indexOf(viewerOwnedBranch)).toBeGreaterThan(-1);
    expect(targetResolver.indexOf(viewerOwnedBranch)).toBeLessThan(targetResolver.indexOf(readerEngineExtraction));
  });

  it('opts normal content-script reads into streamed article chunking with profile chunk options', () => {
    const targetResolver = readFileSync(new URL('../../src/lib/reader-engine-target-resolver.js', import.meta.url), 'utf8');

    expect(targetResolver).toContain('streamArticleChunks: true');
    expect(targetResolver).toContain('speechChunkOptions,');
    expect(targetResolver.indexOf('streamArticleChunks: true')).toBeGreaterThan(
      targetResolver.indexOf('const article = await extractReadableTab({'),
    );
  });
});
