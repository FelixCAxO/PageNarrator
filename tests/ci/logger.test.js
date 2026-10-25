import { describe, expect, it } from 'vitest';
import {
  createLogger,
  createSuppressedErrorHandler,
  normalizeLogLevel,
} from '../../src/lib/logger.js';

describe('extension logger', () => {
  it('normalizes unsupported log levels to silent by default', () => {
    expect(normalizeLogLevel('debug')).toBe('debug');
    expect(normalizeLogLevel('warn')).toBe('warn');
    expect(normalizeLogLevel('verbose')).toBe('silent');
    expect(normalizeLogLevel()).toBe('silent');
  });

  it('keeps best-effort failures silent until the extension log level enables them', () => {
    const calls = [];
    const logger = createLogger('readerEngine', {
      getLogLevel: () => 'silent',
      consoleRef: {
        warn: (...args) => calls.push(args),
      },
    });

    createSuppressedErrorHandler(logger, 'Failed to hide floating reader')(new Error('tab closed'));

    expect(calls).toEqual([]);
  });

  it('logs suppressed failures with context when warn logging is enabled', () => {
    const calls = [];
    const logger = createLogger('readerEngine', {
      getLogLevel: () => 'warn',
      consoleRef: {
        warn: (...args) => calls.push(args),
      },
    });

    createSuppressedErrorHandler(logger, 'Failed to hide floating reader')(new Error('tab closed'));

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('[PageNarrator:readerEngine]');
    expect(calls[0][1]).toBe('Failed to hide floating reader');
    expect(calls[0][2]).toBeInstanceOf(Error);
  });
});
