import { describe, expect, it } from 'vitest';
import { createPdfPageModel } from '../../src/lib/pdf-page-model.js';
import { item } from './pdf-page-model.fixtures.js';

describe('PDF numeric source markers', () => {
  it('keeps a smaller same-baseline numbered step as content', () => {
    const source = [item('1', 60, 640, 4, 7), item('Determine that the product is available.', 74, 640, 240, 10)];
    const before = structuredClone(source), model = createPdfPageModel(source);
    expect(model.speech).toContain('1 Determine that the product is available.');
    expect(source).toEqual(before);
  });

  it('keeps a smaller same-baseline number inside a sentence', () => {
    const model = createPdfPageModel([item('Version', 60, 640, 42, 12), item('3', 106, 640, 4, 7), item('remains supported.', 114, 640, 130, 12)]);
    expect(model.speech).toContain('Version 3 remains supported.');
  });

  it('still removes a truly raised citation after row alignment normalizes its y', () => {
    const source = [item('Evidence supports this result', 60, 640, 180, 12), item('12', 242, 644, 8, 7), item('in practice.', 254, 640, 70, 12)];
    const model = createPdfPageModel(source);
    expect(model.speech).toContain('Evidence supports this result in practice.');
    expect(model.speech).not.toContain('12');
    expect(model.anchorText).toContain('12');
  });

  it('keeps the existing raised mathematical exponent exception', () => {
    const model = createPdfPageModel([item('The area is x', 60, 640, 80, 12), item('2', 142, 644, 4, 7), item('square units.', 150, 640, 90, 12)]);
    expect(model.speech).toContain('2');
  });
});

describe('PDF quoted URL literals in strict code calls and assignments', () => {
  it.each([
    "connect('www.python.org', 80, timeout=500)",
    'client.connect(hostname="https://host.example/path", port=443)',
    'endpoint = "https://user@example.org/0000-0002-1825-0097"',
    "client.connect('https://host.example/it\\'s')",
    '客户端.连接("https://host.example/path")',
  ])('keeps the complete quoted URI and structural punctuation: %s', code => {
    const source = [item(code, 60, 640, code.length * 6, 10)], before = structuredClone(source);
    const model = createPdfPageModel(source);
    expect(model.speech).toContain(code);
    expect(model.anchorText).toContain(code);
    expect(source).toEqual(before);
  });

  it.each([
    'Visit https://host.example/path for documentation.',
    "The documentation is at 'https://host.example/path'.",
    'endpoint == "https://host.example/path"',
    "connect('https://host.example/path)",
    "connect(prefix + 'https://host.example/path')",
  ])('preserves the existing URL suppression outside the narrow literal contract: %s', text => {
    const model = createPdfPageModel([item(text, 60, 640, text.length * 6, 10)]);
    expect(model.speech).not.toContain('host.example');
    expect(model.anchorText).toContain('host.example');
  });
});
