import { vi } from "vitest";

export function createSignal() {
  const target = new EventTarget();
  return {
    aborted: false,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: vi.fn(target.removeEventListener.bind(target)),
    abort() {
      this.aborted = true;
      target.dispatchEvent(new Event('abort'));
    },
  };
}

export function createFakeAudio() {
  const target = new EventTarget();
  return {
    src: '',
    currentTime: 0,
    duration: 1,
    playbackRate: 1,
    paused: false,
    ended: false,
    onended: null,
    onerror: null,
    play: vi.fn(() => Promise.resolve()),
    pause: vi.fn(),
    load: vi.fn(),
    removeAttribute(name) {
      if (name === 'src') this.src = '';
    },
    addEventListener: vi.fn(target.addEventListener.bind(target)),
    removeEventListener: vi.fn(target.removeEventListener.bind(target)),
    dispatchEvent(event) {
      return target.dispatchEvent(event);
    },
  };
}
