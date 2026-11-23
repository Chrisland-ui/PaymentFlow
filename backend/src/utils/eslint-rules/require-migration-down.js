'use strict';

/**
 * ESLint rule: require-migration-down
 *
 * Flags migration files in backend/migrations/ that export `up` but do not
 * export a `down` function. A missing `down` function makes rollback impossible
 * and violates the migration authoring standards in docs/migrations.md.
 *
 * This rule only activates for files matching the path pattern:
 *   backend/migrations/NNN_*.js
 *
 * Compliant example (exports both up and down):
 *   module.exports = { version: VERSION, up, down };
 *
 * Non-compliant example (missing down):
 *   module.exports = { version: VERSION, up };
 */

/** @type {import('eslint').Rule.RuleModule} */
const requireMigrationDown = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Migration files must export a `down` function to allow rollback.',
      url: 'https://github.com/onlyonee1/PaymentFlow/blob/main/docs/migrations.md#rollback-policy-and-limitations',
    },
    messages: {
      missingDown:
        'Migration file is missing a `down` export. ' +
        'Every migration must implement down() so it can be rolled back. ' +
        'See docs/migrations.md for the required structure.',
    },
    schema: [],
  },

  create(context) {
    // Only enforce on migration files.
    const filename = context.getFilename();
    if (!/backend[\\/]migrations[\\/]\d{3}_/.test(filename)) {
      return {};
    }

    let hasUpExport = false;
    let hasDownExport = false;

    /**
     * Check whether a given ObjectExpression (the value of module.exports = {...})
     * contains both 'up' and 'down' properties.
     */
    function inspectExportObject(node) {
      if (node.type !== 'ObjectExpression') return;
      const keys = node.properties
        .filter((p) => p.type === 'Property')
        .map((p) => (p.key.type === 'Identifier' ? p.key.name : null));

      if (keys.includes('up')) hasUpExport = true;
      if (keys.includes('down')) hasDownExport = true;
    }

    return {
      // Pattern: module.exports = { version, up, down }
      AssignmentExpression(node) {
        if (
          node.left.type === 'MemberExpression' &&
          node.left.object.name === 'module' &&
          node.left.property.name === 'exports'
        ) {
          inspectExportObject(node.right);
        }
      },

      // Pattern: module.exports = { ..., up, ...spread }
      // Handles spreads conservatively — treat any spread as potentially
      // providing 'down' to avoid false positives on complex exports.
      'AssignmentExpression > ObjectExpression > SpreadElement'() {
        hasDownExport = true; // conservative: assume spread may include down
      },

      // Report at end of program if up exists but down does not.
      'Program:exit'(node) {
        if (hasUpExport && !hasDownExport) {
          context.report({
            node,
            messageId: 'missingDown',
          });
        }
      },
    };
  },
};

module.exports = requireMigrationDown;
