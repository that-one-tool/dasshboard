# DaSSHboard — Implementation Plan

Read [SPEC.md](SPEC.md) first. This plan cuts the work into **vertical slices**: every phase ends with a runnable app that does strictly more than the previous phase, verified by automated tests plus a manual checklist. Do not start a phase until the previous phase's Definition of Done is fully met.

**Agent assignment key:** 🟣 Opus (hard concurrency/protocol work) · 🔵 Sonnet (standard features) · 🟢 Haiku (well-specified, low-ambiguity tasks). An agent may always escalate a task upward if it stalls. Every phase is additionally gated by a 🔵 Sonnet **adversarial reviewer**, whose findings are fixed by a dedicated 🟣 Opus **fixer** agent (protocol below).

**Rules for every phase**

- Work on top of the previous phase's merged result; keep `cargo test`, `npm test`, `cargo clippy -- -D warnings`, and `tsc --noEmit` green at the end of every phase.
- If reality forces a deviation from SPEC.md, update SPEC.md in the same change and note it in the handoff.
- End each phase by appending a dated entry to `HANDOFF.md`: what was built, what was deferred, known quirks.

### Adversarial review gate (applies to every phase)

When the implementing agent(s) believe a phase is done (tests green, manual checklist passed), a **fresh 🔵 Sonnet reviewer agent** — one that took no part in the implementation — reviews the phase before it can close:

- **Stance:** contradictory by design. Its brief is to *disprove* the Definition of Done, not confirm it. It assumes the implementation is wrong somewhere and hunts for the evidence.
- **Scope:** the full phase diff against SPEC.md. Standing checklist on top of the phase-specific focus listed in each Definition of Done:
  - Spec deviations (silent behavior changes, IPC shape drift from SPEC §5, undocumented decisions).
  - Bad Rust patterns: `unwrap`/`expect`/`panic!` on fallible paths, blocking calls inside async, unbounded channels, locks held across `await`, missing cleanup on error paths, leaked tasks.
  - Bad TS patterns: `any`/`as` escapes from strict mode, unremoved listeners/observers, state mutated outside the state module, dead code.
  - Secret hygiene: nothing secret in JSON files, logs, error messages, or backend→frontend payloads.
  - Test quality: tests that cannot fail, missing negative/edge cases, checklist items not actually covered by anything.
- **Output:** a review entry appended to `HANDOFF.md` with findings tagged **Blocking** / **Should-fix** / **Nit**. Each finding must be self-contained — file/line references, what's wrong, why it matters, and the expected behavior per SPEC.md — because the fixer works from this report alone. The reviewer does **not** fix code itself — that would compromise its independence.
- **Fix cycle:** if the review contains any Blocking or Should-fix findings, spawn a **fresh 🟣 Opus fixer agent** — neither the original implementer nor the reviewer — whose input is the review report plus SPEC.md and `HANDOFF.md`. It fixes the findings (keeping `npm run check` green and adding regression tests where a finding revealed a test gap), and appends a fix log to `HANDOFF.md` noting how each finding was resolved. Nits may be deferred with a note instead of fixed.
- **Sign-off:** the same reviewer re-examines the fixer's changes and either writes "REVIEW PASSED — no blocking findings" in `HANDOFF.md` (phase closes) or issues a follow-up report for another fix cycle. If reviewer and fixer still disagree after two cycles, a separate 🟣 Opus arbiter is spawned to make the final call and record the rationale in `HANDOFF.md`.

---

## Phase 0 — Scaffold & walking skeleton 🔵

**Goal:** a Tauri 2 + Vite + vanilla TS app that builds, runs, and proves the IPC and test plumbing end to end.

Tasks:

1. `git init`; scaffold Tauri 2 app (vanilla-ts template), identifier `com.dasshboard.app`, window title "DaSSHboard", min size 900×600.
2. Add deps — Rust: `russh`, `russh-keys`, `keyring`, `tokio`, `serde`, `uuid`, `thiserror` (pin versions). Frontend: `@xterm/xterm`, `@xterm/addon-fit`. Dev: `vitest`, strict `tsconfig`.
3. Prove the skeleton: a `ping` command returning the app version, called from `main.ts` and rendered in the window; a placeholder xterm.js terminal that echoes local keystrokes (no SSH) to prove the xterm bundle works.
4. Test plumbing: one trivial Rust unit test, one trivial Vitest test, `npm run check` script chaining `tsc --noEmit` + `vitest run` + `cargo test` + `cargo clippy -- -D warnings`.
5. Create `HANDOFF.md` with the Phase 0 entry.

**Definition of Done**

- [ ] `npm run tauri dev` opens the window; version shown via IPC; the echo terminal accepts typing.
- [ ] `npm run check` passes from a clean clone.
- [ ] 🔵 Adversarial review passed (`HANDOFF.md` sign-off). Focus: does `npm run check` actually fail on a seeded error (break a test on purpose); are versions pinned; is `tsconfig` really strict; does the scaffold build from a clean clone with no undocumented prerequisites.

---

## Phase 1 — Device management (no SSH yet) 🔵 backend / 🟢 UI

**Goal:** full device CRUD with secure secret storage. The app is now a useful address book even before SSH exists.

Tasks:

1. 🔵 Rust `DeviceStore` (SPEC §4): load/save `devices.json` in `app_config_dir` with atomic writes; version field; CRUD.
2. 🔵 Secret storage behind a `SecretStore` trait (keyring impl + in-memory fake for tests); wire `save_device`/`delete_device`/`list_devices` commands per SPEC §5, including the "secrets never leave the backend" rule.
3. 🟢 Sidebar UI: device list with add/edit/delete; device editor dialog per SPEC §7 (auth-method radio, password field never pre-filled, "unchanged" placeholder).
4. 🟢 `src/ipc.ts` with typed wrappers for the device commands; `AppError` handling → toast/dialog.
5. Tests: Rust store CRUD + atomic-write + missing/corrupt-file recovery (temp dirs, fake secret store); Vitest for form validation logic (port range, required fields).

**Definition of Done**

- [ ] `npm run check` green.
- [ ] Manual: add a device with a password → restart app → device persists, password field shows "unchanged"; verify the password is in Windows Credential Manager (service `DaSSHboard`) and **not** in `devices.json`; delete the device → keyring entry gone.
- [ ] 🔵 Adversarial review passed (`HANDOFF.md` sign-off). Focus: secret hygiene end to end (grep the diff for any path where a secret could reach a file, log, error string, or frontend payload); atomic-write correctness under a crash between temp-write and rename; corrupt/missing `devices.json` recovery; keyring failures surfaced as `Keyring` errors, not panics.

---

## Phase 2 — One real SSH terminal 🟣

**Goal:** the riskiest slice — click a device, get a live interactive shell in a single full-window pane. Everything after this is composition.

Tasks:

1. `SessionManager` + `SessionHandle` (SPEC §3): tokio task per session, mpsc control channel, managed state.
2. russh client: connect (10 s timeout), auth per device (password from keyring; key file + optional passphrase), PTY + shell, keepalive 30 s. Output bytes → the per-session IPC `Channel`; `write_stdin`, `resize_pty`, `disconnect` commands; `session_status` events for the full lifecycle (SPEC §5–6).
3. Host-key verification: `known_hosts.json` store, TOFU prompt flow with `host_key_prompt` event + `respond_host_key` command + 60 s timeout, changed-key big-warning variant (SPEC §6).
4. Frontend: single pane wired per SPEC §7 — device dropdown + Connect, xterm.js with fit addon + ResizeObserver, status overlays (connecting/error/disconnected + Retry), host-key trust dialog, `test_connection` button in the device editor now functional.
5. Tests: integration tests against a disposable SSH server (Docker `linuxserver/openssh-server`, or the in-process fallback per SPEC §9) covering: password auth OK, wrong password ⇒ `SshAuth`, unreachable host ⇒ `SshConnect` within timeout, echo through PTY, host-key store accept/reject/mismatch paths. Unit tests for known-hosts matching.

**Definition of Done**

- [ ] `npm run check` green, including SSH integration tests.
- [ ] Manual: connect to a real device → TOFU dialog appears once, then never again; run `htop`/`vim` (escape sequences, colors OK); resize the window and columns adjust (`tput cols` changes); type interactively with no visible lag; disconnect cleanly; pull the network cable / stop sshd → pane shows error state and Retry works.
- [ ] 🔵 Adversarial review passed (`HANDOFF.md` sign-off). Focus: async correctness in `SessionManager` — locks held across `await`, deadlock potential in the host-key oneshot flow (including the 60 s timeout and user-closes-dialog paths), cleanup on *every* failure path (auth fail, mid-handshake drop, channel close), no `unwrap` on network-fallible code, error taxonomy matches SPEC §5.

---

## Phase 3 — Multi-pane grid & concurrent sessions 🟣 sessions/splitters / 🔵 grid UI

**Goal:** several independent live terminals at once in preset grids with adjustable splitters.

Tasks:

1. 🔵 Grid module (`src/grid.ts`): render N×M CSS Grid from `{rows, cols, rowSizes, colSizes}`; preset picker in the toolbar; pane focus management (click to focus, visible focus ring).
2. 🟣 Splitters: drag bars between tracks updating the size fractions (min pane fraction 0.15), throttled re-fit of affected terminals during drag.
3. 🟣 Concurrency hardening: N simultaneous sessions with independent channels/status; rapid connect/disconnect churn must not leak tasks or map entries (add a debug `session_count` assertion hook for tests).
4. 🔵 Grid-shrink flow per SPEC §7 (drop excess panes, confirm when live sessions would be closed); empty-pane device picker in every cell.
5. Tests: Vitest for grid math (preset transitions, fraction clamping/normalization, row-major pane mapping on shrink/grow); Rust integration test opening 4 concurrent sessions to the test server and driving I/O on all of them.

**Definition of Done**

- [ ] `npm run check` green.
- [ ] Manual: 2x2 with 3–4 live connections; typing goes only to the focused pane; drag splitters → terminals reflow and remote `tput cols` agrees; switch 2x2 → 1x2 with confirmations; no zombie sessions after churn (status dots consistent).
- [ ] 🔵 Adversarial review passed (`HANDOFF.md` sign-off). Focus: session/task leaks under connect–disconnect churn (verify via the `session_count` hook); data/status routed to the *correct* pane when sessions open and close out of order; splitter math edge cases (min-fraction clamping, normalization drift after many drags); listener/observer cleanup when panes are destroyed.

---

## Phase 4 — Layout profiles 🔵 / 🟢 UI polish

**Goal:** the headline feature — save the workspace, reload it with one click, auto-connect everything.

Tasks:

1. 🔵 Rust `ProfileStore`: `profiles.json` per SPEC §4, profile commands per SPEC §5 including `defaultProfileId` handling.
2. 🔵 Save / Save As / rename / delete / set-default in the sidebar; dirty-state tracking (workspace diff vs. loaded profile → • indicator).
3. 🔵 Load flow per SPEC §7: confirm teardown when sessions are live, apply grid, parallel auto-connect, per-pane failure isolation.
4. 🟢 App-start behavior: load default profile if set, else 1x1 empty; deleting a device nulls it out of any profile panes referencing it (backend-side referential cleanup, covered by a store test).
5. Tests: Rust ProfileStore CRUD + default-id + device-deletion cleanup; Vitest for dirty-state diffing and load/teardown state machine.

**Definition of Done**

- [ ] `npm run check` green.
- [ ] Manual: build a 2x2 with 4 devices → Save As "Homelab" → set default → restart app → grid restores and all 4 connect automatically; stop sshd on one device and reload the profile → that pane errors, other three connect; edit sizes → dot appears → Save → dot clears.
- [ ] 🔵 Adversarial review passed (`HANDOFF.md` sign-off). Focus: referential integrity (device deleted while referenced by a profile / while its pane is live); load-flow races (loading a profile while a previous load's connects are still in flight, closing the app mid-load); dirty-state false positives/negatives (splitter nudge-and-return, floating-point size comparison); `defaultProfileId` invariants after delete/rename.

---

## Phase 5 — Polish & packaging 🟢 (🔵 for reconnect logic)

**Goal:** ship-quality v1.

Tasks:

1. 🔵 Auto-reconnect option per device (off by default): on unexpected drop, retry with backoff (2 s/4 s/8 s, max 5 attempts, cancel button in the overlay).
2. 🟢 Terminal settings (persisted in `settings.json`): font size, font family, dark/light terminal theme; applied live to all terminals.
3. 🟢 UX details: paste-multiline confirmation, pane header tooltips (host:port), Ctrl+Shift+V paste, right-click paste, empty-state hints for first run (no devices yet → arrow to Add device).
4. 🟢 App icon, window state persistence (size/position), `tauri build` producing a Windows installer (NSIS/MSI); verify installed build against the Phase 4 checklist.
5. 🟢 README.md: screenshots, build/run instructions, where data lives, security notes summary.

**Definition of Done**

- [ ] `npm run check` green; `npm run tauri build` produces an installer; installed app passes the Phase 4 manual checklist.
- [ ] Manual: kill sshd mid-session with auto-reconnect on → session comes back by itself; font-size change applies live and survives restart.
- [ ] 🔵 Adversarial review passed (`HANDOFF.md` sign-off). Focus: reconnect state machine (cancel mid-backoff, manual Retry during an automatic attempt, device edited/deleted while reconnecting); settings applied to *all* live terminals and to terminals created afterward; installer artifacts contain no dev leftovers; README instructions actually reproduce a working build.

---

## Phase 6 — Holistic UI review & refinement 🟣

**Goal:** a 🟣 Opus agent audits the entire UI as a whole — something no per-phase reviewer sees — and implements improvements. Unlike the per-phase gates, in this phase the Opus agent both finds *and fixes* issues; the phase then goes through the standard adversarial review like any other.

Tasks:

1. **Audit:** run the installed app end to end through every SPEC §7 flow (first run, add/edit/delete device, TOFU dialog, single and multi-pane sessions, splitters, grid switching, profile save/load/default, settings, error and empty states). Record findings in `HANDOFF.md` as a structured UI audit: visual consistency (spacing, typography, color usage, status-dot semantics, dark theme coherence), interaction quality (focus rings, tab order, keyboard navigation, shortcut discoverability), state coverage (every pane state reachable and visually distinct; no flash of wrong state), resize/reflow behavior at min window size and maximized, latency feel (terminal input echo, connect feedback within 100 ms).
2. **Fix:** implement the improvements, ordered by user impact. Keep each fix small and `npm run check`-green; behavior changes that alter SPEC §7 must update SPEC.md in the same change.
3. **Consistency pass:** unify duplicated CSS/DOM patterns that accreted across phases (dialog structure, buttons, overlays, toasts) into shared modules — improvements here must be refactors, not redesigns.
4. **Re-verify:** after fixes, re-run the manual checklists from Phases 1–5 to confirm nothing regressed, and re-check the audit's findings list, marking each Fixed / Deferred (with reason).

**Definition of Done**

- [ ] UI audit + resolution log in `HANDOFF.md`; every finding marked Fixed or Deferred-with-reason.
- [ ] `npm run check` green; Phases 1–5 manual checklists re-pass on the improved UI.
- [ ] 🔵 Adversarial review passed (`HANDOFF.md` sign-off). Focus: regressions hiding in refactors (CSS unification changing untouched screens, shared-module extraction altering behavior); SPEC §7 kept in sync with every UX change; audit findings genuinely resolved rather than marked Fixed optimistically.

---

## Risk register

| Risk                                                   | Phase | Mitigation                                                                                                                              |
| ------------------------------------------------------ | ----- | --------------------------------------------------------------------------------------------------------------------------------------- |
| russh API friction (PTY, auth flows, keepalive)        | 2     | Phase 2 is Opus-owned and isolated to one pane; SPEC §6 fixes the exact behavior so the rest of the app doesn't depend on russh details |
| Host-key prompt deadlock (await inside russh Handler)  | 2     | oneshot + 60 s timeout specified up front; integration test covers reject path                                                          |
| Keyring quirks per OS                                  | 1     | `SecretStore` trait with fake for tests; real keyring exercised in manual checklist                                                     |
| Terminal perf with 6 panes streaming                   | 3     | Channels not events for data; if laggy, batch writes before `terminal.write()`                                                          |
| Docker unavailable for SSH tests on an agent's machine | 2–3   | Test util must fall back to in-process russh server (SPEC §9)                                                                           |
| Tauri e2e tooling immaturity on Windows                | all   | Deliberately out of scope; manual checklists are the gate for interactive behavior                                                      |
