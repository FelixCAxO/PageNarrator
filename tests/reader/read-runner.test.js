import { describe, expect, it } from 'vitest';
import { createReaderSession } from '../../src/reader/reader-session.js';
import { createReadRunner } from '../../src/reader/read-runner.js';

describe('read runner', () => {
  it('runs the readerEngine page read callback without duplicating orchestration state', async () => {
    const session = createReaderSession();
    const runner = createReadRunner({ session });
    const calls = [];

    await expect(runner.startPage({
      startMode: 'viewport',
      run: async (options) => {
        calls.push(options);
        return 'read-complete';
      },
    })).resolves.toBe('read-complete');

    expect(calls).toEqual([{ startMode: 'viewport' }]);
    expect(session.state.readingState).toBe('idle');
  });
});
