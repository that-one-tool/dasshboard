import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Violations predating these rules are frozen in eslint-suppressions.json;
// after fixing some, shrink it with `npx eslint . --prune-suppressions`.
export default tseslint.config(
	{ ignores: ["dist/", "src-tauri/", "coverage/"] },
	js.configs.recommended,
	tseslint.configs.recommended,
	{
		files: ["src/**/*.ts"],
		rules: {
			"@typescript-eslint/no-unused-vars": [
				"error",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
			],
			complexity: ["error", 3],
			"max-lines-per-function": [
				"error",
				{ max: 20, skipBlankLines: true, skipComments: true, IIFEs: true },
			],
		},
	},
	{
		// Matching terminal control sequences is this module's job.
		files: ["src/terminal/**/*.ts"],
		rules: { "no-control-regex": "off" },
	},
	{
		files: ["src/**/*.test.ts"],
		rules: { complexity: "off", "max-lines-per-function": "off" },
	},
);
