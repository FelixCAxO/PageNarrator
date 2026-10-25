export function applyReadingPreferences(article, {
  skipCodeSnippets = false,
  skipTablesUnlessCaptioned = false,
} = {}) {
  if (!article || typeof article !== 'object') return article;
  if (!skipCodeSnippets && !skipTablesUnlessCaptioned) return article;

  const chunkPredicate = createChunkPredicate({ skipCodeSnippets, skipTablesUnlessCaptioned });

  if (isChunkStream(article.chunkStream)) {
    const filtered = {
      ...article,
      chunkStream: filterChunkStream(article.chunkStream, chunkPredicate),
    };
    if (Array.isArray(article.chunks) && article.chunks.length) {
      const chunks = filterChunks(article.chunks, chunkPredicate);
      return {
        ...filtered,
        chunks,
        text: chunks.map(getChunkSpeechText).filter((speech) => String(speech || '').trim()).join('\n\n'),
      };
    }
    return filtered;
  }

  if (Array.isArray(article.chunks)) {
    const chunks = filterChunks(article.chunks, chunkPredicate);
    return {
      ...article,
      chunks,
      text: chunks.map(getChunkSpeechText).filter((speech) => String(speech || '').trim()).join('\n\n'),
    };
  }

  if (skipCodeSnippets && typeof article.text === 'string') {
    return {
      ...article,
      text: filterCodeParagraphs(article.text),
    };
  }

  return article;
}

function createChunkPredicate({ skipCodeSnippets = false, skipTablesUnlessCaptioned = false } = {}) {
  let skippedTableAnchorId = null;
  let skippingUnanchoredTableRows = false;
  return (chunk) => {
    if (skipCodeSnippets && isCodeChunk(chunk)) return false;

    if (skipTablesUnlessCaptioned) {
      if (isTableChunk(chunk)) {
        const captioned = hasTableCaption(chunk);
        skippedTableAnchorId = captioned ? null : chunk?.anchorId ?? null;
        skippingUnanchoredTableRows = !captioned && !skippedTableAnchorId;
        return captioned;
      }

      if (isTableRowChunk(chunk)) {
        if (chunk?.parentAnchorId && skippedTableAnchorId && chunk.parentAnchorId === skippedTableAnchorId) return false;
        if ((skippedTableAnchorId || skippingUnanchoredTableRows) && !chunk?.parentAnchorId) return false;
      } else if (skippedTableAnchorId) {
        skippedTableAnchorId = null;
      } else if (skippingUnanchoredTableRows) {
        skippingUnanchoredTableRows = false;
      }
    }

    return true;
  };
}

function filterChunks(chunks, predicate) {
  const filter = typeof predicate === 'function' ? predicate : () => true;
  return chunks.filter((chunk) => filter(chunk));
}

export function isCodeChunk(chunk) {
  if (!chunk) return false;
  if (typeof chunk === 'object' && chunk.type === 'code') return true;
  return isCodeLikeText(getChunkSpeechText(chunk));
}

function getChunkSpeechText(chunk) {
  return typeof chunk === 'string' ? chunk : chunk?.speech || chunk?.text || '';
}

function isTableChunk(chunk) {
  return Boolean(chunk && typeof chunk === 'object' && chunk.type === 'table');
}

function isTableRowChunk(chunk) {
  return Boolean(chunk && typeof chunk === 'object' && chunk.type === 'table-row');
}

function hasTableCaption(chunk) {
  return Boolean(String(chunk?.anchorText || chunk?.caption || '').trim());
}

function isCodeLikeText(text) {
  const value = String(text || '').trim();
  if (value.length < 24) return false;
  if (/```|~~~/.test(value)) return true;

  const lines = value
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const codeLines = lines.filter(isCodeLikeLine).length;
  if (lines.length >= 2 && codeLines >= Math.max(2, Math.ceil(lines.length * 0.45))) return true;

  const compact = value.replace(/\s+/g, ' ');
  const assignmentCount = countMatches(compact, /\b[$A-Z_a-z][\w$]*(?:\.[A-Z_a-z][\w$]*)*\s*=/g);
  const callCount = countMatches(compact, /\b[$A-Z_a-z][\w$]*(?:\.[A-Z_a-z][\w$]*)+\s*\(/g)
    + countMatches(compact, /\b(?:print|console\.log|require|import|fetch|setTimeout|setInterval)\s*\(/g);
  const commentCount = countMatches(compact, /(^|\s)(?:#|\/\/|\/\*)/g);
  const bracketCount = countMatches(compact, /[\[\]{}();]/g);
  const keywordCount = countMatches(compact, /\b(?:import|from|def|class|function|const|let|var|return|with|as|if|else|for|while|try|catch|await|async|new)\b/g);
  const codeSignalCount = assignmentCount * 2 + callCount * 2 + commentCount + keywordCount + Math.floor(bracketCount / 3);
  const symbolDensity = countMatches(compact, /[=()[\]{};,:.#]/g) / compact.length;

  return codeSignalCount >= 7 && symbolDensity >= 0.08;
}

function isCodeLikeLine(line) {
  if (!line) return false;
  if (/^\s*(?:#|\/\/|\/\*|\*|\$|>|&gt;)\s+\S/.test(line)) return true;
  if (/^\s*(?:import|from|def|class|function|const|let|var|return|if|else|for|while|try|catch|with|await|async)\b/.test(line)) return true;
  if (/\b[$A-Z_a-z][\w$]*(?:\.[A-Z_a-z][\w$]*)*\s*=/.test(line)) return true;
  if (/\b[$A-Z_a-z][\w$]*(?:\.[A-Z_a-z][\w$]*)+\s*\(/.test(line)) return true;
  return /[{}();][\s;]*$/.test(line) && /[$A-Z_a-z0-9]/.test(line);
}

function countMatches(text, pattern) {
  return text.match(pattern)?.length || 0;
}

function filterCodeParagraphs(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph && !isCodeLikeText(paragraph))
    .join('\n\n');
}

function isChunkStream(stream) {
  return typeof stream?.[Symbol.asyncIterator] === 'function';
}

function filterChunkStream(stream, predicate) {
  return {
    [Symbol.asyncIterator]() {
      let iterator = null;
      const getIterator = () => {
        if (!iterator) iterator = stream[Symbol.asyncIterator]();
        return iterator;
      };
      return {
        async next(requestedCount) {
          const innerIterator = getIterator();
          while (true) {
            const result = await innerIterator.next(requestedCount);
            if (result.done) return { done: true, value: undefined };
            const filtered = filterStreamValue(result.value, predicate);
            if (filtered.keep) return { ...result, value: filtered.value };
          }
        },
        async return() {
          const innerIterator = getIterator();
          await innerIterator.return?.();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

function filterStreamValue(value, predicate) {
  if (!Array.isArray(value)) {
    return predicate(value)
      ? { keep: true, value }
      : { keep: false, value: undefined };
  }

  const chunks = filterChunks(value, predicate);
  if (!chunks.length) return { keep: false, value: undefined };
  return {
    keep: true,
    value: chunks.length === 1 ? chunks[0] : chunks,
  };
}
