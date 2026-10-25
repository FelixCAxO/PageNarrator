export function makeLoader(behavior) {
  const calls = [];
  return {
    calls,
    fn: async (modelId, options) => {
      calls.push({ modelId, options });
      return behavior(calls.length, options);
    },
  };
}
