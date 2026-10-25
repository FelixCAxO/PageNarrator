/** Stop waiting promptly while observing any late completion or failure.
 * @template T
 * @param {PromiseLike<T>|T} task
 * @param {AbortSignal|null} [signal]
 * @returns {Promise<T>}
 */
export function withAbortSignal(task, signal = null) {
  const source = Promise.resolve(task);
  if (!signal) return source;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Reading stopped.', 'AbortError'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    source.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
