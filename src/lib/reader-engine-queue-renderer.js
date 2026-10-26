import { t } from './i18n.js';
import {
  createReadingQueueWindow,
  createTranscriptWindow,
} from './reader-engine-view.js';

/** @param {any} [deps] */
export function createReaderEngineQueueRenderer({
  els,
  requestJump,
  renderQueueNavigation,
  getQueueSearchQuery = () => '',
  shouldAutoOpenQueue = () => true,
} = {}) {
  function renderTranscript(text) {
    const transcript = createTranscriptWindow(text);
    const doc = els.transcript?.ownerDocument || globalThis.document;
    els.transcript.replaceChildren(...transcript.paragraphs.map((paragraph) => {
      const node = doc.createElement('p');
      node.textContent = paragraph;
      return node;
    }));
    els.transcriptCount.textContent = transcript.countLabel;
  }

  function renderQueue(chunks, activeIndex) {
    const queue = createReadingQueueWindow(chunks, activeIndex, { query: getQueueSearchQuery() });
    renderQueueNavigation(chunks, activeIndex);
    els.queue.replaceChildren(...queue.items.map((item) => createQueueItem(item)));
    els.queueCount.textContent = queue.countLabel;
    if (els.queueCard && queue.items.length && shouldAutoOpenQueue()) els.queueCard.open = true;
    els.queue.querySelector?.('[data-state="current"]')?.scrollIntoView?.({ block: 'center' });
  }

  function createQueueItem(item) {
    const doc = els.queue?.ownerDocument || globalThis.document;
    const node = doc.createElement('li');
    node.dataset.state = item.state;
    node.setAttribute('role', 'button');
    node.tabIndex = 0;
    node.setAttribute('aria-label', t("Read section $1", [item.number]));

    const index = doc.createElement('span');
    index.className = 'queue-index';
    index.textContent = String(item.number);

    const text = doc.createElement('span');
    text.textContent = item.text;

    node.addEventListener('click', () => requestJump(item.number - 1));
    node.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      requestJump(item.number - 1);
    });

    node.append(index, text);
    return node;
  }

  return { renderQueue, renderTranscript };
}
