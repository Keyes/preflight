import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import prettier from 'eslint-config-prettier'
import vue from 'eslint-plugin-vue'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig(
  { ignores: ['.claude/', '**/dist/', 'converter/', 'SketchUp_SDK/', 'server/data/', 'venues/', 'rider-shots/', 'test-results/', 'playwright-report/'] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  vue.configs['flat/recommended'],
  {
    files: ['**/*.{ts,vue}'],
    languageOptions: {
      parserOptions: {
        // .vue files are parsed by vue-eslint-parser, which hands their <script> to this parser
        parser: tseslint.parser,
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.vue'],
      },
    },
  },
  {
    rules: {
      // node:test's test() and describe() return promises that the runner itself waits for
      '@typescript-eslint/no-floating-promises': [
        'error',
        { allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['test', 'it', 'describe', 'suite'] }] },
      ],
      // `const { name: _, ...rest } = x` is how a field is left out of a copy
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true, argsIgnorePattern: '^_' }],
      // a single word that is not an HTML element is fine
      'vue/multi-word-component-names': ['error', { ignores: ['Viewer'] }],
    },
  },
  { files: ['client/**'], languageOptions: { globals: globals.browser } },
  { files: ['server/**', 'shared/**', '*.js'], languageOptions: { globals: globals.node } },
  // browser tests run in Node, and hand some functions to the page
  { files: ['e2e/**'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  // Config files are not part of a tsconfig, so they get the rules that need no type information.
  { files: ['*.js', 'client/vite.config.ts'], extends: [tseslint.configs.disableTypeChecked] },
  // Last, so formatting is left to Prettier.
  prettier,
)
