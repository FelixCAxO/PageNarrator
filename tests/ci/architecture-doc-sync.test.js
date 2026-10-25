import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve('.');
const TEST_PATH_RE = /`(tests\/[^`]+?\.test\.[cm]?[jt]s)`/g;

describe('architecture docs sync', () => {
  it('mentions only existing test files in project architecture docs', () => {
    const architecture = readFileSync(join(ROOT, 'docs', 'project-architecture.md'), 'utf8');
    const missing = [...architecture.matchAll(TEST_PATH_RE)]
      .map((match) => match[1])
      .filter((path) => !existsSync(join(ROOT, path)));

    expect(missing).toEqual([]);
  });
});
