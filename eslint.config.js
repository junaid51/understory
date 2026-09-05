import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.d.ts'] },
  ...tseslint.configs.strict,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      // A parameter an implementation must accept to honour an interface, but has
      // no use for, is named with a leading underscore rather than dropped. Dropping
      // it makes the concrete type reject calls the interface allows, which cost two
      // call sites a cast before this rule existed.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
)
