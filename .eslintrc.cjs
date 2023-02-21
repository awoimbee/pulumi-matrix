module.exports = {
  env: {
    es2021: true,
    node: true
  },
  extends: [
    'standard'
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    sourcetype: "module"
  },
  plugins: [
    "@typescript-eslint"
  ],
  rules: {
    "comma-dangle": ["error", "never"],
    "quotes": ["error", "double"],
    "semi": ["error", "always"],
    "sort-imports": ["warn", { allowSeparatedGroups: true, ignoreDeclarationSort: true }],
    "no-new": 0
  },
}
