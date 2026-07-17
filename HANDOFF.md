# HANDOFF

Dated entries, newest first is not required — append chronologically at the bottom of each phase's section per PLAN.md.

---

## Phase 0 — Scaffold & walking skeleton (2026-07-17)

### What was built

- `git init` at the project root (`F:\Developpement\Apps\DaSSHboard`), no prior repo existed.
- Scaffolded a Tauri 2 + Vite + vanilla-TS app via `create-tauri-app@4.6.2`. Since the project root already contained `SPEC.md`/`PLAN.md` (non-empty dir), the scaffolder ran into a temp subfolder (`_scaffold_tmp/dasshboard`) and the generated files/dirs (`.gitignore`, `.vscode`, `README.md`, `index.html`, `package.json`, `src/`, `src-tauri/`, `tsconfig.json`, `vite.config.ts`) were moved up into the project root; the temp folder was removed.
  - Identifier: `com.dasshboard.app`. Window title: `DaSSHboard` (was `dasshboard`, changed in `src-tauri/tauri.conf.json`). `productName` also changed to `DaSSHboard`.
  - Window size 1100x720 default, `minWidth: 900`, `minHeight: 600` added (not present in the default template).
- Dependencies added, all pinned to specific versions resolved from crates.io / npm on 2026-07-17 (see Versions below).
- Walking skeleton:
  - Rust: a `ping` Tauri command (`src-tauri/src/lib.rs`) returning `env!("CARGO_PKG_VERSION")` via a small pure helper `app_version()`. The `greet` boilerplate command was removed.
  - Frontend: `src/ipc.ts` holds the typed `invoke` wrapper for `ping` (starting the SPEC §10 convention of centralizing IPC payloads in one module, ahead of the full command surface landing in later phases). `src/version.ts` holds a pure `formatPingMessage()` used to render the result; `src/main.ts` calls `ping()` on `DOMContentLoaded` and writes the formatted string into `#version-banner`.
  - Placeholder terminal: `src/main.ts` creates an `@xterm/xterm` `Terminal` with the `@xterm/addon-fit` `FitAddon`, wires `terminal.onData -> terminal.write` (local echo only, no backend/PTY involved — that's Phase 2), and re-fits on a `ResizeObserver` over the pane container.
  - UI: dark background (`#1e1e1e`), single-column flex layout, terminal pane fills the remaining vertical space (`flex: 1 1 auto`). Boilerplate Vite/Tauri/TS logos and the greet form were removed from `index.html`; unused `src/assets/*` SVGs deleted.
- Test plumbing:
  - Rust: `src-tauri/src/lib.rs` has a `#[cfg(test)] mod tests` with two unit tests on `app_version()` (matches `CARGO_PKG_VERSION`; looks like `MAJOR.MINOR.PATCH`).
  - Vitest: `src/version.test.ts`, four cases against `formatPingMessage()` (happy path, whitespace trimming, empty string, whitespace-only string).
  - `tsconfig.json`: `strict: true` (from the template) plus `noUncheckedIndexedAccess: true` added.
  - `package.json` `check` script: `tsc --noEmit && vitest run && cd src-tauri && cargo test && cargo clippy -- -D warnings`, chained with `&&` so npm runs it through `cmd.exe` on Windows and any failing step aborts the chain with a non-zero exit code.
- `.gitignore`: root covers `node_modules`, `dist`, `dist-ssr`, plus an explicit `src-tauri/target` line (redundant with `src-tauri/.gitignore`'s `/target/`, added anyway per the task's explicit ask for clarity from the root).

### Versions pinned

**Rust (`src-tauri/Cargo.toml`)**, resolved via `cargo add --dry-run` against crates.io on 2026-07-17:

| Crate | Version | Notes |
|---|---|---|
| `tauri` | `2` (template default, unification with the rest via `Cargo.lock`) | |
| `tauri-plugin-opener` | `2` | |
| `serde` | `1` (`derive` feature) | |
| `serde_json` | `1` | |
| `russh` | `0.62.2` | Client-only usage starts Phase 2. Note: PLAN.md's "russh 0.4x+ API" guidance is stale — 0.62 is the current stable line and is what's pinned. |
| `russh-keys` | `0.49.2` | Still published and not deprecated as of 2026-07-17 (verified via crates.io). Newer `russh` versions also expose an in-crate `keys` module, but PLAN.md explicitly lists `russh-keys` as a separate dependency, so both are pinned; Phase 2 decides which is actually used for key loading. |
| `keyring` | `4.1.5` | Default features include `windows-native-keyring-store`, appropriate for this Windows dev environment; SecretStore usage starts Phase 1. |
| `tokio` | `1.53.0` | Features: `rt-multi-thread`, `macros`, `sync`, `time`, `net`, `io-util`. Usage (per-session tasks) starts Phase 2. |
| `uuid` | `1.24.0` | Features: `v4`, `serde`. Usage (device/profile/session IDs) starts Phase 1. |
| `thiserror` | `2.0.18` | Usage (`AppError` taxonomy) starts Phase 1. |
| `aws-lc-rs` | `1.17.1` | **Added directly**, not just pulled in transitively by `russh`. See "Known quirks" below. |

**Frontend (`package.json`)**:

| Package | Version |
|---|---|
| `@tauri-apps/api` | `^2` (template default) |
| `@tauri-apps/plugin-opener` | `^2` |
| `@xterm/xterm` | `6.0.0` |
| `@xterm/addon-fit` | `0.11.0` |
| `@tauri-apps/cli` (dev) | `^2` |
| `vite` (dev) | `^6.0.3` |
| `typescript` (dev) | `~5.6.2` |
| `vitest` (dev) | `4.1.10` |

Toolchain present in the build environment (verified, not installed by this agent): Node v24.18.0, npm 10.9.2, `cargo`/`rustc` 1.88.0, git 2.55.0.

### Known quirks / deviations

- **NASM build dependency worked around, not installed.** `russh`'s default crypto backend feature (`aws-lc-rs`, via `aws-lc-sys`) tries to assemble optimized routines with a local NASM install on Windows. This environment has no NASM (verified: `where nasm` found nothing), and installing a system assembler wasn't something this agent should do unprompted (out of scope per the task's "verify prerequisites, don't install toolchains" instruction, and installing software falls under actions that need user say-so). Fix: added `aws-lc-rs = { version = "1.17.1", features = ["prebuilt-nasm"] }` as a **direct** dependency in `src-tauri/Cargo.toml` (in addition to russh's transitive pull of the same crate) so Cargo's feature unification turns on `prebuilt-nasm` for the whole graph — this downloads AWS's prebuilt NASM object files at build time instead of invoking a local `nasm` binary. Confirmed this alone fixes `cargo build`/`cargo test`/`cargo clippy`. If a future environment has NASM installed, this dependency/feature is harmless to keep. This is a build-environment workaround, not a SPEC.md behavior change, so SPEC.md was not touched.
- **Deps unused so far compile clean without `#[allow]` or dummy usage.** `russh`, `russh-keys`, `keyring`, `tokio`, `uuid`, `thiserror` are declared in `Cargo.toml` but not referenced anywhere in `src-tauri/src/*.rs` yet — Phase 0 only needed `ping`. Verified `cargo clippy -- -D warnings` still exits 0 with these present and unused: rustc/clippy don't warn on unused *external crate* dependencies by default (that requires the opt-in `unused_crate_dependencies` lint, not enabled here). So no `#[allow(...)]` or placeholder "touch the API once" code was needed — each crate gets used for real starting in the phase noted in the table above.
- `russh-keys` vs. `russh::keys`: not resolved in Phase 0 (see table above) — left for Phase 2 to decide, since PLAN.md's task list for Phase 0 only asked to add the dependency, not use it.
- Scaffolder's boilerplate `README.md` (from `create-tauri-app`) was kept as-is at the root; it currently describes the generic Tauri+Vite template, not DaSSHboard. Phase 5's task list already calls for a proper `README.md` (screenshots, build/run instructions, security notes) — left untouched here rather than half-writing it out of scope.

### Definition of Done — results

- **`npm run check` passes from the project root.** PASS. Full chain (`tsc --noEmit && vitest run && cd src-tauri && cargo test && cargo clippy -- -D warnings`) exits 0. Evidence: `tsc --noEmit` — no output, exit 0. `vitest run` — 1 file, 4/4 tests passed. `cargo test` — 2/2 unit tests passed (`app_version_matches_cargo_toml`, `app_version_looks_like_semver`), plus 0 in the `main.rs` bin and 0 doctests (expected, none written there). `cargo clippy -- -D warnings` — exits 0, no warnings emitted.
  - **Verified the check script actually fails on seeded errors** (this is explicitly called out as the reviewer's focus, so pre-verified here): seeded a TS type error in `src/version.ts` → `tsc` reported `error TS2322` and the whole chain exited 2. Reverted, seeded a wrong-string assertion in `src/version.test.ts` → vitest reported 2/4 failing and the chain exited 1. Reverted, seeded a wrong `assert_eq!` expectation in `src-tauri/src/lib.rs`'s test → `cargo test` failed and the chain exited 101. Reverted and confirmed a clean run goes back to exit 0. (One artifact hit during this process: after `mv`-restoring the Rust file, `cargo test` initially reported the *old* failing assertion again because the restored file's mtime was older than Cargo's incremental-build fingerprint expected, so it reused a stale test binary — `touch`-ing the file forced a rebuild and the tests passed. This is a Cargo mtime-fingerprinting quirk from my own manual revert-via-`mv`, not a defect in the source or in `npm run check`'s normal operation — a real edit from an editor always bumps mtime forward.)
- **`npm run tauri dev` compiles and launches.** PASS (compile + launch only, per the task's own scoping — interactive checks are out of reach for this agent). Ran in the background; log shows Vite ready in 276ms, `cargo` compiling, `Finished 'dev' profile ... target(s) in 2.52s`, then `Running 'target\debug\dasshboard.exe'`. Confirmed the process actually started (not just that cargo returned 0) — the dev server was left running briefly, then stopped; no leftover `dasshboard.exe` process afterward (`tasklist` came back empty), i.e. it started and was cleanly torn down. **Left for the human checklist** (cannot be verified by this agent, which has no way to interact with a native GUI window): the version string is actually visible in the rendered window via the `ping` IPC round trip, and the placeholder terminal visibly accepts typed keystrokes and echoes them.
- **Committed with git.** See commit below.

### Human checklist (interactive — not verifiable by this agent)

1. Run `npm run tauri dev`.
2. Confirm the window title bar reads "DaSSHboard" and the window cannot be resized below roughly 900x600.
3. Confirm the banner under the "DaSSHboard" heading reads something like `DaSSHboard backend v0.1.0 — IPC round trip OK` (proves the `ping` command round-tripped over IPC).
4. Click into the terminal pane and type a few characters — confirm they appear in the terminal (local echo, no backend involved yet).
5. Resize the window and confirm the terminal pane visually resizes with it (fit addon + `ResizeObserver` wired up).

### Commit

`git init` + initial commit with message `Phase 0: scaffold and walking skeleton` (see git log).
