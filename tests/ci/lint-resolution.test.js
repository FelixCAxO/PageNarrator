import path from 'node:path';
import { ESLint } from 'eslint';
import { expect, it } from 'vitest';

it('retains unresolved-import enforcement with the patched glob matcher', async () => {
  const eslint = new ESLint();
  const lint = source => eslint.lintText(source, { filePath: path.resolve('src/popup.js') });
  const [valid] = await lint("import { STORAGE_KEYS } from './lib/storage-keys.js'; export { STORAGE_KEYS };");
  expect(valid.messages).toEqual([]);
  const [invalid] = await lint("import value from './missing-release-lint-fixture.js'; export { value };");
  expect(invalid.messages.map(message => message.ruleId)).toContain('import/no-unresolved');
}, 30_000);
