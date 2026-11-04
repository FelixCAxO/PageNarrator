// Development observation only. Page OCR and independent line verification use
// different result schemas; preserve their request association when harvesting.
export function createOcrWorkerResultCapture(primary, verification) {
  const requests = new Map();
  return {
    request(message) {
      if (message?.method === 'recognize' || message?.method === 'recognizeLine') requests.set(message.id, message.method);
    },
    receive(message) {
      const method = requests.get(message?.id);
      requests.delete(message?.id);
      if (!message?.result) return;
      if (method === 'recognize') primary.push(message.result);
      else if (method === 'recognizeLine') verification.push(message.result);
    },
  };
}

export function ocrPageResultLines(value) {
  return (value?.data?.blocks || []).flatMap(block => block.paragraphs || []).flatMap(part => part.lines || []);
}
