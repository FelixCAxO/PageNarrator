import { rememberPdfViewerReadableTarget } from './pdf-viewer-readable-target.js';

export async function openPdfViewerForSourceTab({
  tabs = globalThis.chrome?.tabs,
  storage = globalThis.chrome?.storage?.local,
  sourceTab = null,
  viewerUrl = '',
  title = '',
  waitForReaderTabReady = async () => false,
} = {}) {
  if (!viewerUrl) throw new Error('No PageNarrator PDF viewer URL provided.');
  if (!tabs?.create && !tabs?.update) throw new Error('Chrome tab APIs are unavailable.');

  const openedTab = await openViewerTab({ tabs, sourceTab, viewerUrl });
  const viewerTab = {
    ...openedTab,
    id: openedTab?.id || sourceTab?.id,
    title: title || openedTab?.title || sourceTab?.title || 'PDF document',
    url: openedTab?.url || viewerUrl,
  };

  const remembered = await rememberPdfViewerReadableTarget({
    storage,
    viewerTab,
    viewerUrl,
    title: viewerTab.title,
  });
  await waitForReaderTabReady(remembered?.id || viewerTab.id);
  return remembered;
}

async function openViewerTab({ tabs, sourceTab, viewerUrl }) {
  if (sourceTab?.id && typeof tabs.update === 'function') {
    try {
      return await tabs.update(sourceTab.id, {
        url: viewerUrl,
        active: true,
      });
    } catch {
      // The source tab can disappear during handoff; creating a viewer preserves the read flow.
    }
  }

  if (typeof tabs.create !== 'function') throw new Error('Chrome tab creation is unavailable.');
  return tabs.create({
    url: viewerUrl,
    active: true,
  });
}
