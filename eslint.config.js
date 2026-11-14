import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Architecture boundaries (ADR-9b13ab6). These rules are what keeps business logic in one place:
//  - core imports nothing from cli/server/web and does no terminal I/O.
//  - cli and server never import each other (the single exception is `cli/commands/start.ts`,
//    which only launches the server).
//  - web imports only the web-safe `core/types` entry point, and no Node modules.
const forbid = (patterns, message) => ({
  'no-restricted-imports': ['error', { patterns: patterns.map((group) => ({ group: [group], message })) }],
});

const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  fetch: 'readonly',
};

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', '.idea/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/cli/**', '**/server/**', '**/web/**', 'react', 'react-dom', 'commander'], message: 'core must not depend on cli, server or web (ADR-9b13ab6).' },
            { group: ['node:fs', 'node:fs/*', 'fs', 'fs/*'], message: 'Filesystem access belongs in src/core/storage (ADR-7027c6a).' },
          ],
        },
      ],
      'no-console': 'error',
      'no-restricted-properties': [
        'error',
        { object: 'process', property: 'exit', message: 'core never exits the process; throw GitboardError.' },
        { object: 'process', property: 'stdout', message: 'core never prints; return data to the adapter.' },
        { object: 'process', property: 'stderr', message: 'core never prints; return data to the adapter.' },
      ],
    },
  },
  {
    // The storage layer is where filesystem access lives, so only the layering rule applies here.
    files: ['src/core/storage/**/*.ts'],
    rules: forbid(['**/cli/**', '**/server/**', '**/web/**'], 'core must not depend on cli, server or web (ADR-9b13ab6).'),
  },
  {
    files: ['src/cli/**/*.ts'],
    ignores: ['src/cli/commands/start.ts'],
    rules: forbid(['**/server/**', '**/web/**'], 'cli must not import the server or web (ADR-9b13ab6).'),
  },
  {
    files: ['src/server/**/*.ts'],
    rules: forbid(['**/cli/**', '**/web/**'], 'server must not import the cli or web (ADR-9b13ab6).'),
  },
  {
    files: ['src/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/core/*', '!**/core/types'],
              message: 'web may import only the web-safe core/types entry point (ADR-9b13ab6).',
            },
            { group: ['**/cli/**', '**/server/**'], message: 'web must not import cli or server.' },
            { group: ['node:*', 'fs', 'path', 'child_process'], message: 'web must not use Node modules.' },
          ],
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.mjs', '*.config.js'],
    languageOptions: { globals: nodeGlobals },
  },
  {
    // Tests parse JSON envelopes and HTTP bodies; typing those as `any` keeps assertions readable.
    files: ['tests/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
