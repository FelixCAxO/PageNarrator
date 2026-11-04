import { createHash, randomUUID } from 'node:crypto';

export function publicPdfLibraryManifest(privateBytes) {
  const manifest = JSON.parse(privateBytes);
  const redact = ({ categories, expectedCode }) => ({ id: `library-${randomUUID()}`, categories,
    ...(expectedCode ? { expectedCode } : {}) });
  return { schemaVersion: 2, benchmarkId: manifest.benchmarkId, gold: manifest.gold,
    privateManifest: { bytes: Buffer.byteLength(privateBytes), sha256: createHash('sha256').update(privateBytes).digest('hex') },
    records: manifest.records.map(redact), ...(manifest.routingControls ? { routingControls: manifest.routingControls.map(redact) } : {}) };
}
