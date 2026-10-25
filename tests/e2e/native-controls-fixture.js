import { expect } from '@playwright/test';

// Playwright selectOption()/range fill() dispatch untrusted DOM events. Use the
// native keyboard behavior so these fixtures exercise the production UI gate.
export async function selectNativeOption(locator, value) {
  const options = await locator.locator('option').evaluateAll((nodes) => nodes.map((node) => node.value));
  const index = options.indexOf(value);
  if (index < 0) throw new Error(`Select option is unavailable: ${value}`);
  if (options.length > 100) {
    const label = await locator.locator('option').nth(index).textContent();
    await locator.pressSequentially(label);
    await expect(locator).toHaveValue(value);
    return;
  }
  const fromEnd = index > options.length - 1 - index;
  await locator.press(fromEnd ? 'End' : 'Home');
  const steps = fromEnd ? options.length - 1 - index : index;
  for (let step = 0; step < steps; step += 1) await locator.press(fromEnd ? 'ArrowUp' : 'ArrowDown');
  await expect(locator).toHaveValue(value);
}

export async function setNativeRange(locator, value) {
  const target = Number(value);
  const input = await locator.evaluate((node) => ({
    value: Number(node.value), min: Number(node.min), max: Number(node.max), step: Number(node.step),
  }));
  const steps = Math.round(Math.abs(target - input.value) / input.step);
  if (!Number.isFinite(target) || !Number.isFinite(steps) || input.step <= 0
    || target < input.min || target > input.max) throw new Error(`Invalid range target: ${value}`);
  const direction = target > input.value ? 'ArrowRight' : 'ArrowLeft';
  for (let step = 0; step < steps; step += 1) await locator.press(direction);
  await expect(locator).toHaveValue(String(value));
}
