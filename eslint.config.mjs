// Flat ESLint config. Besides style, this file ENFORCES architecture rules (docs/ARCHITECTURE.md 4.5):
// no process.env in business code, no process-local timers, no raw clocks, no `any`, no top-level
// mutable state. Dependency direction between packages is enforced separately by dependency-cruiser.
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const SRC = ['apps/*/src/**/*.{ts,tsx}', 'packages/*/src/**/*.{ts,tsx}'];
const TESTS = ['**/*.test.{ts,tsx}', '**/test/**/*.{ts,tsx}', '**/__fixtures__/**'];

const rawTimeSyntax = [
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message:
      'Use an injected Clock (@heed/shared) instead of new Date(); time must be deterministic under test.',
  },
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message:
      'Use an injected Clock (@heed/shared) instead of Date.now(); time must be deterministic under test.',
  },
];

const topLevelStateSyntax = [
  {
    selector: "Program > VariableDeclaration[kind='let']",
    message:
      'No module-level mutable state: process memory is never a source of truth (ARCHITECTURE 4.5).',
  },
  {
    selector: "Program > ExportNamedDeclaration > VariableDeclaration[kind='let']",
    message:
      'No module-level mutable state: process memory is never a source of truth (ARCHITECTURE 4.5).',
  },
  {
    selector:
      "Program > VariableDeclaration > VariableDeclarator[init.type='NewExpression'][init.callee.name=/^(Map|Set|WeakMap|WeakSet)$/]",
    message:
      'No module-level Map/Set: create caches inside factories so they stay per-instance optimizations.',
  },
];

const serverOnlyModules = [
  '@heed/config',
  '@heed/config/*',
  '@heed/api',
  '@heed/api/*',
  'fastify',
  'fastify-*',
  '@fastify/*',
  'pino',
  'pino-*',
  'jose',
  'node:*',
  '@prisma/*',
  'prisma',
  'pg',
  'googleapis',
  '@google/*',
  '@google-cloud/*',
  'google-auth-library',
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'scripts/__fixtures__/**',
      'docs/**',
      'pnpm-lock.yaml',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            'Do not read process.env in application code. Configuration is resolved once in apps/api/src/main.ts and injected (SecretsProvider / loadServerConfig).',
        },
      ],
    },
  },

  // Plain JS/CJS/MJS config files: no type information.
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { ...globals.node } },
  },

  // Application source (not tests): no process-local timers, raw clocks, or module-level state.
  {
    files: SRC,
    ignores: TESTS,
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'setInterval',
          message:
            'No process/worker-local timers for business scheduling; use Job.scheduledAt, nextSyncAt, and Reminder.triggerAt (ARCHITECTURE 4.4). In the extension use chrome.alarms.',
        },
        { name: 'clearInterval', message: 'See setInterval.' },
      ],
      'no-restricted-syntax': ['error', ...rawTimeSyntax, ...topLevelStateSyntax],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@heed/shared/testing', '**/testing/**'],
              message: 'Test doubles are for tests only.',
            },
          ],
        },
      ],
    },
  },

  // Test support code that lives next to production code may use test doubles.
  {
    files: ['apps/api/src/testing/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },

  // The Clock implementation is the single place allowed to read the real time.
  {
    files: ['packages/shared/src/clock.ts'],
    rules: { 'no-restricted-syntax': ['error', ...topLevelStateSyntax] },
  },

  // The only module allowed to read process.env: the process entry point.
  {
    files: ['apps/api/src/main.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },

  // Operational scripts (CLI tools) run outside the application and may read the environment.
  {
    files: ['scripts/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-restricted-properties': 'off' },
  },

  // Extension: browser world. Server-only modules and node built-ins are forbidden at lint time too
  // (dependency-cruiser is the authoritative gate).
  {
    files: ['apps/extension/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser, ...globals.serviceworker } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: serverOnlyModules,
              message:
                'The extension is a thin client: it may import only @heed/shared (docs/ARCHITECTURE.md section 2).',
            },
            { group: ['@heed/shared/testing'], message: 'Test doubles are for tests only.' },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/extension/*.ts', 'apps/extension/scripts/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-restricted-imports': 'off' },
  },

  // Tests: real time, test doubles, and Node helpers are fine; strictness on `any` stays.
  {
    files: TESTS,
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-restricted-syntax': 'off',
      'no-restricted-globals': 'off',
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
);
