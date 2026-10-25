/** Keep one output stream open across decoded media elements without changing their samples or rate handling. */
export function createSpeechMediaOutput({ AudioContext = globalThis.AudioContext, onError = () => {} } = {}) {
  let context = null;
  const nodes = new Set();
  return {
    connect(audio) {
      if (typeof AudioContext !== 'function') return () => {};
      try {
        context ||= new AudioContext({ latencyHint: 'interactive' });
        if (context.state !== 'running') {
          // A blocked context must never silence an otherwise playable HTML audio element.
          void context.resume().catch(onError);
          return () => {};
        }
        const node = context.createMediaElementSource(audio);
        node.connect(context.destination); nodes.add(node);
        return () => { if (nodes.delete(node)) node.disconnect(); };
      } catch (error) { onError(error); return () => {}; }
    },
    release() {
      for (const node of nodes) node.disconnect();
      nodes.clear();
      const previous = context; context = null;
      if (previous) void previous.close().catch(onError);
    },
  };
}
