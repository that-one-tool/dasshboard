---
name: website
description: Structure and rules of the DaSSHboard website (apps/website, static Astro site). Use when changing the site's copy, locales, screenshots, pages or deploy.
---

# Website (`apps/website/`)

Read `apps/website/README.md` first (commands, locales, i18n, screenshots,
deploy, no remote content). Gate: `npm run site:check` from the repo root.

Code pointers the README leaves out:

- `base: "/dasshboard"`.
- `src/lib/appVersion.ts` reads the version; tokens, font and icon are copies
  of the desktop ones.
- `components/HomePage.astro` builds each locale page.
- `components/Screenshot.astro` falls back to the CSS mockups in
  `components/mocks/`.
