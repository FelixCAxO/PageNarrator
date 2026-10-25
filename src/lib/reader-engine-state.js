export function createReaderEngineInitialState({
  performance = globalThis.performance,
  now = Date.now,
} = {}) {
  return {
    readerEngineOpenedAtMs: typeof performance?.now === 'function' ? performance.now() : now(),
  };
}
