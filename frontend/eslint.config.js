import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'src/api/schema.gen.ts'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
      prettier,
    ],
    languageOptions: { ecmaVersion: 2023, globals: globals.browser },
    rules: {
      // window.Telegram is reachable only through the platform adapter.
      'no-restricted-globals': [
        'error',
        { name: 'Telegram', message: 'Use src/platform instead.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'window', property: 'Telegram', message: 'Use src/platform instead.' },
        { object: 'globalThis', property: 'Telegram', message: 'Use src/platform instead.' },
      ],
    },
  },
  {
    files: ['src/platform/telegram.ts'],
    rules: { 'no-restricted-globals': 'off', 'no-restricted-properties': 'off' },
  },
)
