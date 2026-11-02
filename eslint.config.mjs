import js from '@eslint/js';
import nextVitals from 'eslint-config-next/core-web-vitals';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// One config for the whole monorepo, so every package follows the same rules.
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/.next/**', '**/coverage/**', '**/next-env.d.ts', '**/generated/**'],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
  },
  // Next.js rules (React, hooks, a11y, Core Web Vitals) only apply to the web app.
  ...nextVitals.map((config) => ({ ...config, files: ['apps/web/**/*.{js,jsx,ts,tsx,mjs}'] })),
  {
    files: ['apps/web/**'],
    settings: { next: { rootDir: 'apps/web' } },
  },
);
