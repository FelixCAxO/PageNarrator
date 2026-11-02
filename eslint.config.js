import parser from '@typescript-eslint/parser';
import typescript from '@typescript-eslint/eslint-plugin';
import noUnresolved from 'eslint-plugin-import-x/rules/no-unresolved';
import globals from 'globals';

export default [
  {
    ignores: [
      '.chrome-for-testing/**', '.chrome-preview/**', '.claude/**', '.agents/**',
      '.codex/**', '.superpowers/**', '.cache/**', '**/.wrangler/**', 'artifacts/**',
      'dist*/**', 'node_modules/**', 'releases/**', 'tmp/**', 'test-results/**',
      'voice-packs/**', 'vendor/phonemizer/espeak.mjs', 'website/public/**',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parser,
      parserOptions: { project: './tsconfig.eslint.json' },
      globals: { ...globals.browser, ...globals.node, ...globals.es2022 },
    },
    // Load the rule we use; unused legacy rules require minimatch's removed makeRe API.
    plugins: { '@typescript-eslint': typescript, import: { rules: { 'no-unresolved': noUnresolved } } },
    settings: { 'import-x/ignore': ['^cloudflare:'] },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true, caughtErrors: 'none' }],
      '@typescript-eslint/no-floating-promises': 'error',
      // Root-relative source imports execute inside browser probes.
      'import/no-unresolved': ['error', { ignore: ['^cloudflare:', '^kokoro-js$', '^vitest/config$', '^/src/'] }],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='catch'] > ArrowFunctionExpression > BlockStatement[body.length=0]",
          message: 'Promise catch handlers must report, return, or delegate errors instead of using an empty handler.',
        },
        {
          selector: "CallExpression[callee.property.name='catch'] > FunctionExpression > BlockStatement[body.length=0]",
          message: 'Promise catch handlers must report, return, or delegate errors instead of using an empty handler.',
        },
      ],
    },
  },
  { files: ['src/**/*.js'], ignores: ['src/lib/logger.js'], rules: { 'no-console': 'error' } },
];
