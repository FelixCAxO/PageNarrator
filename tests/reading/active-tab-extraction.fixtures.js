export function createDeps(overrides = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      tabs: {
        sendMessage: async (tabId, message) => {
          calls.push(['sendMessage', tabId, message]);
          return { source: 'reading-model', title: 'Article', text: 'Article text', url: 'https://example.test/article' };
        },
      },
      scripting: {
        executeScript: async (options) => {
          calls.push(['executeScript', options]);
        },
      },
      permissions: {
        request: async (request) => {
          calls.push(['permissions.request', request]);
          return true;
        },
      },
      getContentScriptFile: () => 'src/content.js',
      extractPdfArticle: async ({ tab, requirePdfData } = {}) => {
        calls.push(['extractPdfArticle', tab.url, Boolean(requirePdfData)]);
        if (!/pdf|programming|mhjfbmdgcfjbbpaeojofohoefgiehjai/i.test(`${tab.url} ${tab.title || ''}`)) throw new Error('Not a PDF');
        return { source: 'pdf', title: tab.title, text: 'PDF text', url: tab.url };
      },
      ...overrides,
    },
  };
}
