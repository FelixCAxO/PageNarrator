import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DEFAULT_CORPUS_DIR = new URL('./corpus/', import.meta.url);

export async function startCorpusFixtureServer({
  corpusDir = DEFAULT_CORPUS_DIR,
} = {}) {
  const root = path.resolve(corpusDir instanceof URL ? fileURLToPath(corpusDir) : corpusDir);
  const server = createServer(async (request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405);
      response.end();
      return;
    }

    const pathname = decodeURIComponent(new URL(request.url || '/', 'http://127.0.0.1').pathname);
    const slug = path.basename(pathname === '/' ? 'index.html' : pathname);
    const filePath = path.join(root, slug);
    if (!filePath.startsWith(root)) {
      response.writeHead(403);
      response.end();
      return;
    }

    try {
      const info = await stat(filePath);
      if (!info.isFile()) throw new Error('not a file');
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/html; charset=utf-8',
      });
      createReadStream(filePath).pipe(response);
    } catch {
      response.writeHead(404);
      response.end('Not found');
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Corpus fixture server did not start.');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    urlFor(slug) {
      return `${this.origin}/${slug}`;
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
