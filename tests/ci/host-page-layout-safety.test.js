import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT_DIR = fileURLToPath(new URL('../..', import.meta.url));
function readSource(relPath) {
  return readFileSync(join(ROOT_DIR, relPath), 'utf8');
}

function readJson(relPath) {
  return JSON.parse(readSource(relPath));
}

function tryReadJson(relPath) {
  try {
    return readJson(relPath);
  } catch {
    return null;
  }
}

function extractTemplateLiteral(source, assignment) {
  const assignmentStart = source.indexOf(`${assignment} = \``);
  expect(assignmentStart, `${assignment} assignment should exist`).toBeGreaterThanOrEqual(0);

  const templateStart = source.indexOf('`', assignmentStart);
  let escaped = false;
  for (let index = templateStart + 1; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '`') return source.slice(templateStart + 1, index);
  }

  throw new Error(`Could not find closing template literal for ${assignment}.`);
}

function extractCssRules(cssText) {
  const rules = [];
  const cssWithoutTemplateBraces = cssText.replace(/\$\{([^}]+)\}/g, (_, expression) => (
    `__PN_EXPR_${expression.trim().replace(/[^\w]+/g, '_').replace(/^_|_$/g, '')}__`
  ));
  const rulePattern = /([^{}]+?)\s*\{([^{}]*)\}/g;
  for (const match of cssWithoutTemplateBraces.matchAll(rulePattern)) {
    for (const selector of match[1].split(',')) {
      rules.push({
        selector: selector.trim(),
        declarations: match[2],
      });
    }
  }
  return rules;
}

// Modules that may execute in a host (non-extension) page context.
// Anything that mutates body/documentElement dimensions here would shrink or
// reflow the host page, which is the regression this suite prevents.
const HOST_PAGE_MODULES = [
  'src/content.js',
  'src/reader/extraction/content-extraction.js',
  'src/reader/highlighting/content-highlight.js',
  'src/lib/page-highlighter.js',
];

// Forbidden mutations on document.body / document.documentElement. Each entry
// reads "<element>.style.<prop>" with optional `document.` prefix and matches
// every host-page-narrowing property we care about.
const FORBIDDEN_STYLE_MUTATIONS = [
  /(^|[^\w$])(?:document\.)?body\.style\.(width|maxWidth|minWidth|margin|marginLeft|marginRight|padding|paddingLeft|paddingRight|transform|zoom)\s*[=;]/,
  /(^|[^\w$])(?:document\.)?documentElement\.style\.(width|maxWidth|minWidth|margin|marginLeft|marginRight|padding|paddingLeft|paddingRight|transform|zoom)\s*[=;]/,
];

const ALLOWED_HIGHLIGHT_STYLE_SELECTORS = new Set([
  '.pagenarrator-current-block',
  '.pagenarrator-resume-flash',
  '[__PN_EXPR_REGION_OVERLAY_ATTRIBUTE__]',
  '[__PN_EXPR_REGION_OVERLAY_ATTRIBUTE__="next"]',
  '[__PN_EXPR_REGION_OVERLAY_ATTRIBUTE__][data-pagenarrator-paused="true"]',
  '::highlight(__PN_EXPR_HIGHLIGHT_CHUNK__)',
  '::highlight(__PN_EXPR_HIGHLIGHT_WORD_TRAIL_0__)',
  '::highlight(__PN_EXPR_HIGHLIGHT_WORD_TRAIL_1__)',
  '::highlight(__PN_EXPR_HIGHLIGHT_WORD_TRAIL_2__)',
  '::highlight(__PN_EXPR_HIGHLIGHT_WORD_TRAIL_3__)',
]);

const FORBIDDEN_GLOBAL_STYLE_SELECTORS = [
  /^html$/i,
  /^body$/i,
  /^:root$/i,
  /^\*$/,
  /^\*::?(?:before|after)$/i,
  /:is\([^)]*\b(?:html|body)\b[^)]*\)/i,
  /:where\([^)]*\b(?:html|body)\b[^)]*\)/i,
];

describe('host page layout safety', () => {
  describe.each(HOST_PAGE_MODULES)('%s', (relPath) => {
    const source = readSource(relPath);

    it.each(FORBIDDEN_STYLE_MUTATIONS)(
      'does not mutate host body/html dimensions (%s)',
      (pattern) => {
        expect(source, `${relPath} matched forbidden layout pattern ${pattern}`).not.toMatch(pattern);
      },
    );

    it('does not call chrome.scripting.insertCSS into the host page', () => {
      // insertCSS targets the host page and would silently apply rules we
      // cannot audit. Stick to executeScript with repo-owned module sources.
      expect(source).not.toMatch(/scripting\.insertCSS\s*\(/);
    });

    it('does not rewrite the viewport meta tag', () => {
      // Sites pick their own viewport scaling; the extension must not override
      // it (e.g. forcing initial-scale would visually shrink the page).
      expect(source).not.toMatch(/name\s*=\s*['"]viewport['"]/i);
    });
  });

  it('page highlighter overlays are pointer-events:none fixed overlays', () => {
    const source = readSource('src/lib/page-highlighter.js');
    expect(source).toMatch(/position:\s*fixed\s*!important/);
    expect(source).toMatch(/pointer-events:\s*none\s*!important/);
  });

  it('page highlighter injected stylesheet stays scoped to PageNarrator selectors', () => {
    const source = readSource('src/lib/page-highlighter.js');
    const cssText = extractTemplateLiteral(source, 'style.textContent');
    const rules = extractCssRules(cssText);
    const selectors = rules.map((rule) => rule.selector);

    expect(selectors).toEqual([...ALLOWED_HIGHLIGHT_STYLE_SELECTORS]);
    for (const selector of selectors) {
      expect(
        FORBIDDEN_GLOBAL_STYLE_SELECTORS.some((pattern) => pattern.test(selector)),
        `forbidden global selector in highlighter stylesheet: ${selector}`,
      ).toBe(false);
    }
    for (const rule of rules) {
      const positionMatch = rule.declarations.match(/position\s*:\s*([^;]+)/i);
      if (!positionMatch) continue;
      expect(rule.selector).toBe('[__PN_EXPR_REGION_OVERLAY_ATTRIBUTE__]');
      expect(positionMatch[1].trim()).toBe('fixed !important');
    }
  });

  it('page highlighter only writes PageNarrator CSS variables on documentElement', () => {
    const source = readSource('src/lib/page-highlighter.js');
    const block = source.match(/function applyHighlightStyleVariables\(\) \{(?<body>[\s\S]*?)\r?\n  \}\r?\n\r?\n  function buildSearchIndex/)?.groups?.body;
    expect(block).toBeTruthy();

    const properties = [...block.matchAll(/rootStyle\.setProperty\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
    expect(properties.length).toBeGreaterThan(0);
    expect(properties.every((property) => property.startsWith('--pn-'))).toBe(true);
    expect(properties).not.toEqual(expect.arrayContaining([
      'width',
      'max-width',
      'min-width',
      'margin',
      'padding',
      'transform',
      'zoom',
    ]));
  });

  it.each(['manifest.json', 'dist/manifest.json'])('%s declares no always-on content script', (relPath) => {
    const manifest = relPath === 'manifest.json' ? readJson(relPath) : tryReadJson(relPath);
    if (!manifest) return;
    expect(manifest.content_scripts).toBeUndefined();
  });

  it('prelaunch runs the host-layout guardrail before release builds', () => {
    const packageJson = readJson('package.json');
    const gates = readJson('config/verification-gates.json');

    expect(packageJson.scripts['test:host-layout']).toBe(
      'vitest run tests/ci/host-page-layout-safety.test.js',
    );
    expect(packageJson.scripts.prelaunch).toBe('npm run launch:full && npm run smoke:production');
    expect(packageJson.scripts['launch:full']).toBe('npm run verify:release');
    expect(gates.release).toContain('npm run test:host-layout');
    expect(gates.release.indexOf('npm run test:host-layout')).toBeLessThan(
      gates.release.indexOf('npm run build'),
    );
  });

  it('documents the host-page layout contract', () => {
    const readme = readSource('README.md');
    const readerUi = readSource('docs/reader-ui.md');

    expect(readerUi).toContain('Host-page layout contract');
    expect(readerUi).toContain('must not write inline layout styles to `body` or `document.documentElement`');
    expect(readerUi).toContain('`position: fixed`');
    expect(readerUi).toContain('`chrome.scripting.insertCSS`');
    expect(readme).toContain('does not request always-on website access');
  });
});
