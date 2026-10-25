/**
 * @param {object} [deps]
 * @param {ReturnType<import('./reader-session.js').createReaderSession>} [deps.session]
 * @param {((options: any) => Promise<any>|any)|null} [deps.extract]
 */
export function createReadRunner({ session, extract = null } = {}) {
  async function start(options = {}) {
    const article = typeof extract === 'function' ? await extract(options) : options;
    const chunks = article?.chunks || article?.activeChunks || options.chunks || [];
    session?.startRead?.({
      ...options,
      chunks,
      source: article?.source || options.source,
      pdfPageCount: article?.pdfPageCount || options.pdfPageCount,
    });
    return article;
  }

  /** @param {{ run?: ((options: any) => Promise<any>|any)|null, [key: string]: any }} [pageOptions] */
  async function startPage({ run = null, ...options } = {}) {
    if (typeof run === 'function') return run(options);
    return start(options);
  }

  return {
    start,
    startPage,
    pause() {
      session?.setReadingState?.('paused');
    },
    resume() {
      session?.setReadingState?.('reading');
    },
    stop() {
      return session?.resetRead?.();
    },
    next() {
      const current = session?.snapshot?.().currentChunk || 0;
      session?.setCurrentChunk?.(current + 1);
    },
    previous() {
      const current = session?.snapshot?.().currentChunk || 0;
      session?.setCurrentChunk?.(current - 1);
    },
  };
}
