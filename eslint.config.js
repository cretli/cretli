// Flat ESLint config (ESLint 9). Run: npm run lint
// Errors block CI; `no-unused-vars` and `eqeqeq` stay warnings so incremental
// cleanup of older files does not gate unrelated pull requests.
import js from '@eslint/js';
import globals from 'globals';

export default [
  // Global ignores — must be a standalone block. When `ignores` is combined
  // with `rules` in the same block, it only scopes that block and does NOT
  // exclude files globally, which caused generated bundles to be linted.
  {
    ignores: [
      'node_modules/**',
      'app_front/node_modules/**',
      'public/dist/**',
      'app_front/dist/**',
      'data/**',
      '.tmp/**',
      '.vendor/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2025,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
        ...globals.es2021,
      },
    },
    rules: {
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-undef': 'error',
      'no-use-before-define': 'off',
      'no-inner-declarations': 'off',
      eqeqeq: ['warn', 'smart'],
    },
  },
  {
    files: ['tests/**'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  // ANSI-aware parsers deliberately match control characters (\x1b, \x07) in
  // regular expressions to strip terminal escape sequences. Disable the rule
  // for those files instead of muting each regex.
  {
    files: [
      'lib/status-parser.js',
      'lib/fork-chat-text.js',
      'lib/fork-title.js',
      'lib/codex/codex-device-auth.js',
      'app_front/agents.js',
      'app_front/chat.js',
      'app_front/statusTests.js',
      'scripts/test-fork-title.js',
      'tests/status-parser.test.js',
      'tests/status-parser-flow.test.js',
    ],
    rules: {
      'no-control-regex': 'off',
    },
  },
];
