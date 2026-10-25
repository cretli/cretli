// Flat ESLint config (ESLint 9). Run: npm run lint
// Errors block CI; `no-unused-vars` and `eqeqeq` stay warnings so incremental
// cleanup of older files does not gate unrelated pull requests.
import js from '@eslint/js';
import globals from 'globals';
import babelParser from '@babel/eslint-parser';

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
  // TypeScript sources (erasable syntax only). Parsed with Babel's TypeScript
  // parser plugin because typescript-eslint cannot load the native TypeScript 7 API.
  // Syntax-level linting only: same rules as the JS block, no type-aware rules.
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: { babelrc: false, configFile: false, parserOpts: { plugins: ['typescript'] } },
      },
    },
    rules: {
      // Type-only names and parameter types are seen as unused/undefined by the core rules.
      'no-undef': 'off',
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    files: ['tests/**'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  // public/sw.js is a classic service worker scope: importScripts is a worker
  // global that neither globals.node nor globals.browser declares.
  {
    files: ['public/sw.js'],
    languageOptions: {
      globals: { importScripts: 'readonly' },
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
      'lib/todo-worktree-manual.js',
      'lib/codex/codex-device-auth.ts',
      'app_front/features/agents/views/agentsPanel.js',
      'app_front/features/chat/views/chatPanel.js',
      'app_front/features/statusTests/views/statusTestsPanel.js',
      'scripts/test-fork-title.js',
      'tests/status-parser.test.js',
      'tests/status-parser-flow.test.js',
    ],
    rules: {
      'no-control-regex': 'off',
    },
  },
];
