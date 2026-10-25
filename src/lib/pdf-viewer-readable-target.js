import { createReadableTabSnapshot, saveReadableTabTarget } from './readable-tab-target.js';

export async function rememberPdfViewerReadableTarget({
  storage,
  viewerTab,
  viewerUrl = '',
  title = '',
} = {}) {
  const tabSnapshot = createReadableTabSnapshot({
    ...viewerTab,
    title: viewerTab?.title || title,
    url: viewerTab?.url || viewerUrl,
  });
  if (!tabSnapshot) return null;

  await saveReadableTabTarget({
    storage,
    tabId: tabSnapshot.id,
    tab: tabSnapshot,
  });
  return tabSnapshot;
}
