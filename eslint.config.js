import jsEslint from "@eslint/js"
import globals from "globals"
import tsEslint from "typescript-eslint"

const eslintConfig = tsEslint.config(
  {
    ignores: ["coverage", "dist", "node_modules"],
  },
  {
    languageOptions: {
      globals: globals.node,
    },
  },
  jsEslint.configs.recommended,
  tsEslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          args: "all",
          argsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "no-type-imports",
        },
      ],
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
    },
  }
)

export default eslintConfig
