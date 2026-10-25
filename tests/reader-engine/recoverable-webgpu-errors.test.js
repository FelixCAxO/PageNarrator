import { describe, expect, it } from 'vitest';
import { installRecoverableWebGpuErrorSuppression } from '../../src/lib/recoverable-webgpu-errors.js';

describe('recoverable WebGPU errors', () => {
  it('suppresses only Chromium no-adapter probe rejections', () => {
    let handler = null;
    const windowRef = {
      addEventListener(type, listener) {
        if (type === 'unhandledrejection') handler = listener;
      },
    };

    installRecoverableWebGpuErrorSuppression(windowRef);

    let prevented = false;
    handler({
      reason: new Error('No available adapters.'),
      preventDefault() {
        prevented = true;
      },
    });

    let normalPrevented = false;
    handler({
      reason: new Error('model asset missing'),
      preventDefault() {
        normalPrevented = true;
      },
    });

    expect(prevented).toBe(true);
    expect(normalPrevented).toBe(false);
  });
});
