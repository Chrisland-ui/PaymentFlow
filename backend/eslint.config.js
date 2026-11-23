'use strict';

const js = require('@eslint/js');
const pluginN = require('eslint-plugin-n');
const globals = require('globals');
const requireMigrationDown = require('./src/utils/eslint-rules/require-migration-down');

module.exports = [
  js.configs.recommended,
  pluginN.configs['flat/recommended'],
  {
    languageOptions: {
      ecmaVersion: 2021,
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'require-await': 'error',
      'no-console': 'error',
      'n/exports-style': 'off',
      'n/no-extraneous-require': 'off',
      'n/no-process-exit': 'off',
    },
  },
  {
    files: ['src/utils/logger.js'],
    rules: {
      'no-console': 'off',
    },
  },
  // Enforce down() in every migration file — see docs/migrations.md
  {
    files: ['migrations/*.js'],
    plugins: {
      'local-rules': { rules: { 'require-migration-down': requireMigrationDown } },
    },
    rules: {
      'local-rules/require-migration-down': 'error',
    },
  },
];
