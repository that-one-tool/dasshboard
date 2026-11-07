---
name: release
description: Release a new DaSSHboard desktop version (bump, docs, gate, Release commit, push).
disable-model-invocation: true
---

# Desktop release

How CI releases: `apps/desktop/README.md` (Releasing, Flatpak). The gate
script `.github/scripts/release-gate.sh` has tests in `release-gate.test.sh`.
After a release, `site-deploy.yml` redeploys the website.

## Steps

1. `git fetch` and pull; work on `main`.
2. Pick the version (semver): a new feature is minor, fixes only are patch.
3. Bump it in `apps/desktop/package.json`, `src-tauri/tauri.conf.json` and
   `src-tauri/Cargo.toml` (CI fails if they differ). Refresh the locks:
   `npm install --package-lock-only` (in `apps/desktop/`) and
   `cargo update -p dasshboard --offline` (in `src-tauri/`).
4. Update user docs: root `README.md` feature lines, and the website feature
   text in `apps/website/src/i18n/*.ts` (all 8 locales, same structure).
5. Run `npm run check:all` until green.
6. Commit everything in one commit. Header `Release vX.Y.Z: <short summary>`
   (`release-gate.sh` releases on it), body a short bullet list of the
   user-visible changes.
7. Push to `main`.
