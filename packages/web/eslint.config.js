import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "src/engine/pkg/**", "src/wasm/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" },
      ],
      // Existing `any` in src is tracked debt: visible on every run, not yet a gate.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    // Node test doubles emulate an untyped DOM (MockNode, listeners, `this` capture).
    files: ["tests/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
      "@typescript-eslint/no-this-alias": "off",
    },
  },
  {
    files: ["tests/**/*.mjs"],
    languageOptions: { globals: { URL: "readonly" } },
  },
);
