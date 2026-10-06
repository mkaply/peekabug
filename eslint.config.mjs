import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/", "web-ext-artifacts/"] },
  js.configs.recommended,
  {
    files: ["*.js"],
    languageOptions: {
      sourceType: "script",
      globals: { ...globals.browser, ...globals.webextensions },
    },
  },
  {
    files: ["test/**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: globals.node,
    },
  },
];
