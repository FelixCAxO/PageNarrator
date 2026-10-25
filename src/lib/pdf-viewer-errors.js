import { getErrorRecord } from './error-registry.js';

export function classifyPdfLoadError(error) {
  const message = error?.message || String(error || '');
  if (/invalid pdf|corrupt|damaged|unsupported|missing pdf/i.test(message)) {
    return getErrorRecord('pdf_corrupt');
  }
  if (/\b(4\d\d|5\d\d)\b|network|fetch|download|not found/i.test(message)) {
    return getErrorRecord('pdf_network');
  }
  return getErrorRecord('pdf_unknown', { message: message || 'Could not open this PDF.', actionLabel: 'Retry' });
}

export function isPdfWorkerTerminatedError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return (
    message.includes('worker was terminated') ||
    message.includes('worker destroyed') ||
    message.includes('message channel closed') ||
    message.includes('transport closed') ||
    message.includes('cannot read properties of null') ||
    message.includes('worker error') ||
    error?.name === 'WorkerTerminatedException'
  );
}

export function isRecoverablePdfError(error) {
  return isPdfWorkerTerminatedError(error) || error?.name === 'RenderingCancelledException';
}
