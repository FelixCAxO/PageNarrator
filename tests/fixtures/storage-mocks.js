export function createMemoryStorage(initial = {}) {
  const state = { ...initial };
  const storage = {
    async get(keys = null) {
      if (keys == null) return { ...state };
      if (typeof keys === 'string') return { [keys]: state[keys] };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, state[key]]));
      return Object.fromEntries(
        Object.entries(keys).map(([key, fallback]) => [key, state[key] ?? fallback]),
      );
    },
    async set(values) {
      Object.assign(state, values);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
    },
    async clear() {
      for (const key of Object.keys(state)) delete state[key];
    },
    values() {
      return { ...state };
    },
    state() {
      return { ...state };
    },
    data: state,
  };
  storage.api = storage;
  return storage;
}

export function createMemoryCacheStorage(initial = {}) {
  const state = { ...initial };
  return {
    async get(key) {
      return state[key];
    },
    async set(key, value) {
      state[key] = value;
    },
    async delete(key) {
      delete state[key];
    },
    async clear() {
      for (const key of Object.keys(state)) delete state[key];
    },
    values() {
      return { ...state };
    },
  };
}
