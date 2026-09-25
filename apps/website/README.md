# DaSSHboard website

The product website, built with [Astro](https://astro.build/) as a fully static
site and served by GitHub Pages at
**https://that-one-tool.github.io/dasshboard/** (hence `base: "/dasshboard"` in
`astro.config.mjs`).

## Develop

```sh
npm ci
npm run dev      # http://localhost:4321/dasshboard/
npm run check    # astro check + Vitest + production build (the site's gate)
```

From the repo root: `npm run site:dev` / `npm run site:check`.

## How it works

- The version and download links are computed at build time:
  `src/lib/appVersion.ts` reads `version` from the desktop app's
  `../desktop/src-tauri/tauri.conf.json` (the canonical release version), and
  `src/lib/downloads.ts` builds the CrabNebula installers link and the GitHub
  release-notes link. Builds and tests must run from this directory.
- Fonts (Inter) and the icon are bundled locally; the page makes no remote requests.
- Design tokens in `src/styles/global.css` mirror the desktop app's theme and
  follow the OS light/dark preference.

## Deploy

`.github/workflows/site-deploy.yml` builds and deploys to GitHub Pages on:

- a push to `main` touching `apps/website/**` (or the site workflows);
- a successful desktop `release` workflow run, so the displayed version refreshes
  only once the new installers are published;
- a manual run (`workflow_dispatch`).

Pull requests touching the site run the same gate via `site-check.yml`.
Use the `(site)` commit scope for website changes (e.g. `feat(site): …`) so they
never cut a desktop release.
