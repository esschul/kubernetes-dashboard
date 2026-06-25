import js from '@eslint/js';
import globals from 'globals';

export default [
    {
        files: ['src/main.js', 'src/preload.js', 'src/command-paths.js', 'src/kubectl-client.js', 'src/github-client.js', 'src/azure-client.js', 'src/pr-client.js'],
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
        files: [
            'src/renderer.js',
            'src/renderer-utils.js',
            'src/renderer-logs.js',
            'src/renderer-feed.js',
            'src/renderer-pipelines.js',
            'src/renderer-prs.js',
            'src/renderer-deployments.js',
        ],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: {
                ...globals.browser,
                module: 'readonly', // renderer-utils.js conditional CommonJS export
            },
        },
        rules: {
            ...js.configs.recommended.rules,
            eqeqeq: 'error',
            curly: 'error',
            'no-unused-vars': 'error',
            // Cross-file globals are defined in sibling scripts and visible at runtime.
            // ESLint cannot trace references across plain <script> tags without a bundler.
            'no-undef': 'off',
        },
    },
];
