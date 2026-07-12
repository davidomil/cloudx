export default [
  {
    files: ["scripts/ai-change/**/*.mjs"],
    ignores: ["scripts/ai-change/**/*.test.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      eqeqeq: "error",
      "no-constant-condition": "error",
      "no-duplicate-imports": "error",
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
];
