import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import prettier from 'eslint-config-prettier'
import vue from 'eslint-plugin-vue'
import globals from 'globals'
import tseslint from 'typescript-eslint'

/** A rule that keeps the files of one layer from importing what is above it. */
const layer = (files, patterns, ignores = []) => [{ files, ignores, rules: { '@typescript-eslint/no-restricted-imports': ['error', { patterns }] } }]

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
  // The layers of docs/architecture.md: imports point down only.
  ...layer(
    ['client/src/domain/**'],
    [
      { group: ['vue', 'pinia', '@babylonjs/*'], message: 'domain/ is plain TypeScript: no Vue, Pinia or Babylon.' },
      { group: ['../stores/*', '../scene/*', '../components/*', '../input/*', '../api'], message: 'domain/ is the bottom layer: it uses shared/ and itself.' },
    ],
  ),
  ...layer(
    ['client/src/scene/**'],
    [
      { group: ['vue', 'pinia'], message: 'scene/ knows Babylon, not Vue: Viewer.vue passes state in.' },
      {
        group: ['../stores/*', '../components/*', '../input/*', '../api'],
        message: 'scene/ takes plain data and callbacks; it does not reach for stores or the API.',
      },
    ],
  ),
  ...layer(
    ['client/src/stores/**'],
    [
      { group: ['../components/*', '../input/*'], message: 'stores/ are below the components and the keymap.' },
      { group: ['../scene/*', '@babylonjs/*'], allowTypeImports: true, message: 'stores/ may use types from scene/, not its code.' },
    ],
  ),
  ...layer(
    ['client/src/components/**', 'client/src/input/**', 'client/src/App.vue'],
    [{ group: ['../scene/*', './scene/*', '@babylonjs/*'], message: 'Only Viewer.vue talks to the scene; other components go through the stores.' }],
    ['client/src/components/Viewer.vue'],
  ),
  ...layer(
    ['server/src/services/**', 'server/src/rider/**'],
    [{ group: ['../routes/*', '../../routes/*'], message: 'Routes use services and the rider pipeline, not the other way round.' }],
  ),
  { files: ['server/**', 'shared/**', '*.js'], languageOptions: { globals: globals.node } },
  // browser tests run in Node, and hand some functions to the page
  { files: ['e2e/**'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  // Config files are not part of a tsconfig, so they get the rules that need no type information.
  { files: ['*.js', 'client/vite.config.ts'], extends: [tseslint.configs.disableTypeChecked] },
  // Last, so formatting is left to Prettier.
  prettier,
)
