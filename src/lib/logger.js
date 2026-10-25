import { STORAGE_KEYS } from './storage-keys.js';

const LOG_LEVELS = Object.freeze({
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
});

let cachedLogLevel = 'silent';

export function normalizeLogLevel(value) {
  const level = String(value || '').trim();
  return Object.prototype.hasOwnProperty.call(LOG_LEVELS, level) ? level : 'silent';
}

export async function refreshExtensionLogLevel({ storage = globalThis.chrome?.storage?.local } = {}) {
  if (!storage?.get) return cachedLogLevel;
  const state = await storage.get(STORAGE_KEYS.LOG_LEVEL);
  cachedLogLevel = normalizeLogLevel(state?.[STORAGE_KEYS.LOG_LEVEL]);
  return cachedLogLevel;
}

export function createLogger(scope, {
  getLogLevel = () => cachedLogLevel,
  consoleRef = globalThis.console,
} = {}) {
  function enabled(level) {
    return LOG_LEVELS[normalizeLogLevel(getLogLevel())] >= LOG_LEVELS[level];
  }

  function write(method, level, message, error = null) {
    if (!enabled(level)) return;
    const sink = typeof consoleRef?.[method] === 'function' ? consoleRef[method] : consoleRef?.log;
    sink?.call(consoleRef, `[PageNarrator:${scope}]`, message, error ?? '');
  }

  return {
    error(message, error) {
      write('error', 'error', message, error);
    },
    warn(message, error) {
      write('warn', 'warn', message, error);
    },
    info(message, detail) {
      write('info', 'info', message, detail);
    },
    debug(message, detail) {
      write('debug', 'debug', message, detail);
    },
  };
}

export function createSuppressedErrorHandler(logger, message) {
  return (error) => {
    logger?.warn?.(message, error);
  };
}

export const defaultLogger = createLogger('runtime');
export const logSuppressedError = createSuppressedErrorHandler(defaultLogger, 'Suppressed asynchronous failure');
