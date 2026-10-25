export class CdpTimeoutError extends Error {
  constructor(method, sessionId, timeoutMs) {
    super(`CDP ${method} did not answer within ${timeoutMs} ms${sessionId ? ' (target unresponsive)' : ''}.`);
    this.name = 'CdpTimeoutError';
    this.method = method;
    this.sessionId = sessionId || null;
  }
}

// A hung renderer never answers Runtime.evaluate; every command is bounded so
// callers record a timeout instead of waiting forever.
export const DEFAULT_CDP_COMMAND_TIMEOUT_MS = 60_000;

class CdpMessageRouter {
  constructor({ commandTimeoutMs = DEFAULT_CDP_COMMAND_TIMEOUT_MS } = {}) {
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closedError = null;
    this.commandTimeoutMs = commandTimeoutMs;
  }

  handleMessage(message) {
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(`${message.error.message}: ${message.error.data || ''}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    const callbacks = this.listeners.get(message.method) || [];
    for (const callback of callbacks) callback(message.params || {}, message.sessionId);
  }

  send(method, params = {}, sessionId, { timeoutMs = this.commandTimeoutMs } = {}) {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId;
    this.nextId += 1;
    const command = { id, method, params };
    if (sessionId) command.sessionId = sessionId;
    const response = new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpTimeoutError(method, sessionId, timeoutMs));
      }, timeoutMs) : null;
      timer?.unref?.();
      this.pending.set(id, { resolve, reject, timer });
    });
    this.write(JSON.stringify(command));
    return response;
  }

  on(method, callback) {
    const callbacks = this.listeners.get(method) || [];
    callbacks.push(callback);
    this.listeners.set(method, callbacks);
  }

  rejectPending(error) {
    this.closedError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  write() {
    throw new Error('CDP transport does not implement write().');
  }
}

export class CdpConnection extends CdpMessageRouter {
  constructor(chromeProcess, options = {}) {
    super(options);
    this.buffer = '';
    this.writer = chromeProcess?.stdio?.[3];
    this.reader = chromeProcess?.stdio?.[4];
    if (!this.writer || !this.reader) throw new Error('Chrome CDP pipe was not opened.');
    this.reader.setEncoding?.('utf8');
    this.reader.on('data', (chunk) => this.handleData(chunk));
    this.reader.on('close', () => this.rejectPending(new Error('CDP pipe closed.')));
  }

  handleData(chunk) {
    this.buffer += chunk;
    let boundary = this.buffer.indexOf('\0');
    while (boundary !== -1) {
      const raw = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 1);
      if (raw) this.handleMessage(JSON.parse(raw));
      boundary = this.buffer.indexOf('\0');
    }
  }

  write(payload) {
    this.writer.write(`${payload}\0`);
  }

  close() {
    this.writer?.end();
  }
}

// Browser-level CDP over the DevTools WebSocket, for browsers launched by a
// supervisor that cannot pass the remote-debugging pipes through.
export class CdpWebSocketConnection extends CdpMessageRouter {
  constructor(socket, options = {}) {
    super(options);
    this.socket = socket;
    socket.addEventListener('message', (event) => this.handleMessage(JSON.parse(String(event.data))));
    socket.addEventListener('close', () => this.rejectPending(new Error('CDP WebSocket closed.')));
    socket.addEventListener('error', () => this.rejectPending(new Error('CDP WebSocket failed.')));
  }

  static async connect(url, { WebSocketImpl = globalThis.WebSocket, timeoutMs = 30_000 } = {}) {
    if (typeof WebSocketImpl !== 'function') throw new Error('This Node.js runtime has no WebSocket implementation.');
    const socket = new WebSocketImpl(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP WebSocket did not open within ${timeoutMs} ms.`)), timeoutMs);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`CDP WebSocket could not connect to ${url}.`));
      }, { once: true });
    });
    return new CdpWebSocketConnection(socket);
  }

  write(payload) {
    this.socket.send(payload);
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // The browser may already have closed the socket.
    }
  }
}
