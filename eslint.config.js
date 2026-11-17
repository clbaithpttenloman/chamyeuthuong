// Minimal ESLint flat config: react-hooks rules for src/**/*.tsx
// Requires typescript-eslint to parse TSX (TypeScript + JSX syntax).
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  // Apply TypeScript parser + register @typescript-eslint plugin for all src
  // .ts/.tsx files so that existing // eslint-disable-next-line @typescript-eslint/*
  // comments in test files are recognised (as off) rather than causing errors.
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  // react-hooks rules: only on component files (.tsx)
  {
    files: ['src/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
)
