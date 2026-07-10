module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: { ecmaVersion: 2022, sourceType: "module" },
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  env: { node: true, es2022: true },
  rules: {
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    "no-empty": ["warn", { allowEmptyCatch: true }],
    // Intentional typed-EventEmitter pattern: an interface merges typed on()
    // overloads onto the class.
    "@typescript-eslint/no-unsafe-declaration-merging": "off",
  },
  ignorePatterns: ["dist", "node_modules", "media", "esbuild.js"],
};
