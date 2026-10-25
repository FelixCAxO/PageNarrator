// @ts-check
import { isArticleDocument, parseArticleDocument } from '../../engines/article-extractor.js';
import {
  chooseArticleExtraction,
  hasChatTurns,
  hasNumberedChatTurns,
  iterateArticleSpeechChunks,
  iterateChatTranscriptSpeechChunks,
  revealChatTranscriptStart,
} from '../../lib/article-extraction.js';
import { MESSAGE_TYPES } from '../../lib/message-types.js';

const articleChunkStreams = new Map();
let nextArticleStreamId = 0;

const articleFallback = { isArticleDocument, parse: parseArticleDocument };

export async function handleExtractMessage(msg, { documentRef = document } = {}) {
  if (msg?.type === MESSAGE_TYPES.GET_ARTICLE_CHUNK) return readArticleChunk(msg.streamId, msg.count ?? msg.maxChunks);
  if (msg?.type === MESSAGE_TYPES.CLOSE_ARTICLE_CHUNK_STREAM) return closeArticleChunkStream(msg.streamId);

  // Chats keep only nearby turns in the DOM (ChatGPT, Claude) or load older history lazily
  // (Gemini); restarting from the top scrolls back to the first turn so it gets extracted.
  if (msg?.startMode === 'top' && !msg.readSelection && hasChatTurns(documentRef)) {
    await revealChatTranscriptStart(documentRef);
  }
  const article = chooseArticleExtraction(documentRef, {
    articleFallback,
    readSelection: Boolean(msg.readSelection),
    startMode: msg.startMode,
  });
  if (!shouldStreamArticleChunks(article, msg)) return article;
  return createStreamedArticleResponse(article, msg.speechChunkOptions, documentRef);
}

function shouldStreamArticleChunks(article, msg = {}) {
  if (!msg.streamChunks || msg.readSelection) return false;
  if (!article || article.error) return false;
  return hasStreamableChunks(article.chunks) || Boolean(String(article.text || '').trim());
}

/**
 * @param {any} article
 * @param {any} speechChunkOptions
 * @param {Document} documentRef
 */
function createStreamedArticleResponse(article, speechChunkOptions, documentRef) {
  const streamId = `article-stream-${Date.now()}-${++nextArticleStreamId}`;
  const chunks = article.chat && hasNumberedChatTurns(documentRef)
    ? iterateChatTranscriptSpeechChunks(documentRef, article, speechChunkOptions)
    : iterateArticleSpeechChunks(article, speechChunkOptions);
  articleChunkStreams.set(streamId, chunks[Symbol.asyncIterator]());
  return {
    ...article,
    text: '',
    chunks: Array.isArray(article.chunks) ? article.chunks : [],
    streaming: true,
    chunkStreamId: streamId,
  };
}

function hasStreamableChunks(chunks) {
  if (Array.isArray(chunks)) return chunks.length > 0;
  return typeof chunks === 'object'
    && chunks !== null
    && typeof chunks[Symbol.iterator] === 'function';
}

async function readArticleChunk(streamId, requestedCount = 1) {
  const iterator = articleChunkStreams.get(streamId);
  if (!iterator) return { done: true };

  const count = Math.max(1, Math.trunc(Number(requestedCount) || 1));
  if (count === 1) {
    try {
      const result = await iterator.next();
      if (result?.done) {
        articleChunkStreams.delete(streamId);
        return { done: true };
      }
      return { done: false, chunk: result.value };
    } catch (error) {
      articleChunkStreams.delete(streamId);
      return { error: /** @type {any} */ (error)?.message ?? String(error) };
    }
  }

  try {
    const chunks = [];
    while (chunks.length < count) {
      const result = await iterator.next();
      if (result?.done) {
        articleChunkStreams.delete(streamId);
        break;
      }
      chunks.push(result.value);
    }

    if (!chunks.length) return { done: true };
    return {
      done: false,
      chunk: chunks[0],
      chunks,
    };
  } catch (error) {
    articleChunkStreams.delete(streamId);
    return { error: /** @type {any} */ (error)?.message ?? String(error) };
  }
}

async function closeArticleChunkStream(streamId) {
  const iterator = articleChunkStreams.get(streamId);
  articleChunkStreams.delete(streamId);
  await iterator?.return?.();
  return { closed: true };
}
