# AGENTS.md

DaSSHboard is a desktop SSH dashboard: users save devices, put live terminals
in a grid, and reload the workspace in one click. Monorepo: `apps/desktop/`
(Tauri 2, Rust backend, vanilla TypeScript + Vite + xterm.js frontend) and
`apps/website/` (Astro). Each app has its own `package.json`; the root one
holds scripts only.

## Skills

Read the skill (`.claude/skills/<name>/SKILL.md`) before you work in its area:

- `desktop-frontend` — `apps/desktop/src/`: module map, IPC and UI text.
- `desktop-backend` — `apps/desktop/src-tauri/`: module map, new commands,
  tests.
- `website` — `apps/website/`.
- `release` — desktop release, only when the user asks.

Docs: `README.md` (users, one line per feature), `apps/desktop/README.md`
(setup, architecture, data files, CI), `apps/website/README.md`.

## Rules

- TDD: write the failing test first, then make it pass. Each new `.ts` module
  gets a `*.test.ts` beside it (except `main.ts` and `i18n/`).
- After each change, run the gate from the repo root until green:
  `npm run check` (desktop), `npm run site:check` (website),
  `npm run check:all` (both).
- Commit scope `(site)` is website only; any other scope, or none, releases
  the desktop app.
- Leave changes uncommitted; the user commits and pushes (except in the
  `release` skill).
- Minimal changes; ask before touching files outside the task. When a
  requirement or design choice is unclear, ask instead of guessing; when two
  approaches are good, show both and let the user choose.
- Small single-purpose functions, cyclomatic complexity < 4.
- Quality limits are a ratchet:
    - `eslint-suppressions.json` only shrinks: after a fix, run
      `npx eslint . --prune-suppressions`.
    - `src-tauri/clippy.toml` limits only tighten.
    - The coverage floor in `vite.config.ts` only rises; raise it when coverage
      rises.
    - Suppressions are counts per file and rule: new code stays inside the
      limits, also in files with suppressions.
- Sizes (width, height, min/max, flex-basis, grid tracks, `<img>`/SVG size):
  rem for components, em in media queries, %/vw/vh with `min()`/`clamp()` for
  layout, never px. Desktop icons use `.icon` / `.icon-lg`. Script that needs
  px uses `remToPx` (`ui/dom.ts`).
- Clear names; comments only for a non-obvious why.
- Keep READMEs, skills and this file in sync with your changes, and short.
  Code structure goes in the skills, not in a README.

## Security

- Secrets (passwords, key passphrases) live only in the OS keychain (service
  `DaSSHboard`), never in a config file.
- A secret goes frontend → backend only when the user saves a device; the
  backend never sends one back.
- Host keys are trust-on-first-use. A changed key shows a loud warning, and the
  connection waits until the user accepts it.
- Keep the Tauri CSP strict; the app loads no remote content.
