import js from '@eslint/js';
import globals from 'globals';

export default [
    {
        files: ['src/main.js', 'src/preload.js', 'src/kubectl-client.js', 'src/github-client.js', 'src/azure-client.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: { ...globals.node },
        },
        rules: {
            ...js.configs.recommended.rules,
            eqeqeq: 'error',
            curly: 'error',
            'no-unused-vars': 'error',
        },
    },
    {
        files: ['src/renderer.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: { ...globals.browser },
        },
        rules: {
            ...js.configs.recommended.rules,
            eqeqeq: 'error',
            curly: 'error',
            'no-unused-vars': 'error',
        },
    },
];
