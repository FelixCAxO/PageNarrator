import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { CdpConnection } from './cdp-connection.js';

function createDuplexPipe() {
  const reader = new EventEmitter();
  reader.setEncoding = () => {};
  const writes = [];
  const writer = {
    writes,
    ended: false,
    write(chunk) {
      writes.push(chunk);
    },
    end() {
      this.ended = true;
    },
  };
  return { reader, writer };
}

function createChromeProcess(pipe = createDuplexPipe()) {
  return {
    pipe,
    stdio: ['ignore', 'ignore', 'ignore', pipe.writer, pipe.reader],
  };
}

describe('shared CDP connection', () => {
  it('parses null-delimited command responses split across chunks', async () => {
    const chromeProcess = createChromeProcess();
    const cdp = new CdpConnection(chromeProcess);

    const response = cdp.send('Runtime.evaluate', { expression: '1 + 1' }, 'session-1');

    expect(chromeProcess.pipe.writer.writes).toEqual([
      `${JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression: '1 + 1' },
        sessionId: 'session-1',
      })}\0`,
    ]);

    chromeProcess.pipe.reader.emit('data', '{"id":1,"result"');
    chromeProcess.pipe.reader.emit('data', ':{"value":2}}\0');

    await expect(response).resolves.toEqual({ value: 2 });
  });

  it('rejects pending commands when Chrome reports a CDP error', async () => {
    const chromeProcess = createChromeProcess();
    const cdp = new CdpConnection(chromeProcess);

    const response = cdp.send('Target.attachToTarget');
    chromeProcess.pipe.reader.emit('data', JSON.stringify({
      id: 1,
      error: { message: 'No target', data: 'target closed' },
    }) + '\0');

    await expect(response).rejects.toThrow('No target: target closed');
  });

  it('dispatches event listeners without interfering with command responses', async () => {
    const chromeProcess = createChromeProcess();
    const cdp = new CdpConnection(chromeProcess);
    const events = [];
    cdp.on('Target.targetCreated', (event) => events.push(event));

    chromeProcess.pipe.reader.emit('data', JSON.stringify({
      method: 'Target.targetCreated',
      params: { targetInfo: { type: 'page' } },
    }) + '\0');

    expect(events).toEqual([{ targetInfo: { type: 'page' } }]);
  });
});
