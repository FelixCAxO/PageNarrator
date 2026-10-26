import { t } from './i18n.js';
/** @param {any} deps */
export function createReaderEngineArticleSummaryController({
  els,
  renderTranscript,
  renderQueue,
  getInitialPreview,
  createArticleSummary,
  createResumePrompt,
  getState,
}) {
  function setArticleSummary(article) {
    const summary = createArticleSummary({
      title: article.title,
      text: article.text,
      source: article.source,
      chunks: article.chunks,
    });
    els.title.textContent = summary.title;
    els.readingTitle.textContent = summary.title;
    els.meta.textContent = summary.metaText;
    els.mode.textContent = t("Reading: $1", [summary.modeLabel]);
    els.body.textContent = summary.previewText || getInitialPreview(article.chunks || article.text);

    const { activeChunks, currentChunk } = getState();
    renderTranscript(article.text);
    renderQueue(activeChunks, currentChunk);
  }

  function renderResumePrompt(saved) {
    if (!els.resumePrompt) return;
    const prompt = createResumePrompt(saved);
    els.resumePrompt.hidden = !prompt.visible;
    if (!prompt.visible) return;
    els.resumeTitle.textContent = prompt.title;
    els.resumeDetail.textContent = prompt.detail;
    els.resumeExcerpt.textContent = prompt.excerpt;
  }

  function renderCodeSuggestion(suggestion = { visible: false }) {
    if (!els.codeSuggestion) return;
    els.codeSuggestion.hidden = !suggestion.visible;
    if (!suggestion.visible) return;
    els.codeSuggestionTitle.textContent = suggestion.title;
    els.codeSuggestionDetail.textContent = suggestion.detail;
  }

  return {
    setArticleSummary,
    renderResumePrompt,
    renderCodeSuggestion,
  };
}
