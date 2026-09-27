# DaSSHboard website

This is the static [Astro](https://astro.build/) site served at
**https://that-one-tool.github.io/dasshboard/**.

```sh
npm ci
npm run dev      # http://localhost:4321/dasshboard/
npm run check    # astro check, Vitest, production build
```

- The site reads the app version from `../desktop/src-tauri/tauri.conf.json` at
  build time, so run builds from this directory.
- Fonts and images are bundled. The site loads no remote content.
- The page is built once per desktop-app language: English at the root, the
  others under `/fr/`, `/es/`, `/de/`, `/pt/`, `/zh/`, `/ja/`. All copy lives in
  `src/i18n/`; `en.ts` is the source of truth, and the tests fail if another
  locale is missing a message or a `{version}` placeholder.
- To replace a CSS mockup with a real screenshot, drop an image into
  `src/assets/screenshots/` named after its slot (see the README there).
- `site-deploy.yml` deploys the site on a push to `main` under `apps/website/**`
  and after each desktop release.
- Scope website commits as `(site)` so they never trigger a desktop release.
