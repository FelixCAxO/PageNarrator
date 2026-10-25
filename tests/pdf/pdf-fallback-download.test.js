import { expect, it, vi } from 'vitest';
import { binaryResource } from '../../src/pdf/binary-resource.js';
import { extractPdfArticle } from '../../src/lib/pdf-extraction.js';
import { extractReadableTab } from '../../src/lib/active-tab-extraction.js';

const tab = { id: 1, url: 'https://example.test/document' };

it('rejects a declared oversized fallback before buffering its body', async () => {
  const cancel = vi.fn(), arrayBuffer = vi.fn();
  const fetch = async () => ({ ok: true, headers: new Headers({ 'content-length': String(1024 ** 3) }), body: { cancel }, arrayBuffer });
  await expect(extractPdfArticle({ tab, requirePdfData: true, fetch })).rejects.toMatchObject({ code: 'pdf_limit' });
  expect(arrayBuffer).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledOnce();
});

it('enforces the same fallback source limit with no Content-Length', async () => {
  const cancel = vi.fn(), chunk = new Uint8Array(1024 * 1024);
  chunk.set(new TextEncoder().encode('%PDF-'));
  const fetch = async () => new Response(new ReadableStream({ pull(stream) { stream.enqueue(chunk); }, cancel }));
  await expect(extractPdfArticle({ tab, requirePdfData: true, fetch })).rejects.toMatchObject({ code: 'pdf_limit' });
  expect(cancel).toHaveBeenCalledOnce();
});

it('rejects misleading declared lengths while streaming', async () => {
  const cancel = vi.fn();
  const fetchImpl = async () => new Response(new ReadableStream({ start(stream) { stream.enqueue(new Uint8Array(9)); }, cancel }), { headers: { 'content-length': '8' } });
  await expect(binaryResource(tab.url, { maxBytes: 16, fetchImpl })).rejects.toMatchObject({ code: 'pdf_network' });
  expect(cancel).toHaveBeenCalledOnce();
});

it('rejects HTML from a bounded prefix even if the server labels it as PDF', async () => {
  const cancel = vi.fn(), fetch = async () => new Response(new ReadableStream({
    start(stream) { stream.enqueue(new TextEncoder().encode('<html>'.padEnd(1024, ' '))); }, cancel,
  }), { headers: { 'content-type': 'application/pdf' } });
  await expect(extractPdfArticle({ tab, requirePdfData: true, fetch })).rejects.toThrow('Current tab did not return PDF data.');
  expect(cancel).toHaveBeenCalledOnce();
});

it('cancels a stalled fallback stream without waiting for the next chunk', async () => {
  const controller = new AbortController(), cancel = vi.fn(), fetching = vi.fn(async () => new Response(new ReadableStream({
    start(stream) { stream.enqueue(new TextEncoder().encode('%PDF-')); }, cancel,
  })));
  const loading = extractPdfArticle({ tab, requirePdfData: true, fetch: fetching, signal: controller.signal });
  await vi.waitFor(() => expect(fetching).toHaveBeenCalledOnce());
  controller.abort();
  await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
  expect(cancel).toHaveBeenCalledOnce();
});

it('never attempts fallback after cancelled content extraction', async () => {
  const controller = new AbortController(), extractPdfArticle = vi.fn();
  const sendMessage = vi.fn(() => { controller.abort(); throw new DOMException('Stopped', 'AbortError'); });
  await expect(extractReadableTab({ tab, tabs: { sendMessage }, extractPdfArticle, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(extractPdfArticle).not.toHaveBeenCalled();
});
