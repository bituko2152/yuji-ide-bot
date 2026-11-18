const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
    { ignores: ['node_modules/', 'data/', 'assets/'] },
    js.configs.recommended,
    {
        languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...globals.node } },
        rules: {
            'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
            'no-empty': ['error', { allowEmptyCatch: true }]
        }
    }
];
