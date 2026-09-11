/**
 * "About DaSSHboard" dialog (opened from the header help button). Shows the app
 * name, a one-line description, and the running version — the version is fetched
 * live from the backend via `ping()` (the same round trip the old header banner
 * used), so it always reflects the actual build rather than a hard-coded string.
 *
 * Self-contained lifecycle, mirroring the other modals: the overlay, the Close
 * button, and Escape all dismiss it and restore focus to the trigger.
 */

import { ping } from "../ipc";
import { formatPingMessage } from "../version";

/** A short, accurate description of what the app is (not marketing copy). */
const TAGLINE = "Multi-pane SSH & serial terminal dashboard";

/** Open the About dialog. Returns immediately; the version fills in when the
 * `ping` round trip resolves. */
export function openAboutDialog(): void {
  const root = document.createElement("div");
  root.className = "dialog about-dialog";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "About DaSSHboard");
  root.innerHTML = `
    <div class="dialog-overlay"></div>
    <div class="dialog-content about-content">
      <h2 class="about-name">DaSSHboard</h2>
      <p class="about-tagline"></p>
      <p class="about-version" aria-live="polite">Checking version…</p>
      <p class="about-built">Built with Tauri, Rust &amp; TypeScript.</p>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" data-action="close">Close</button>
      </div>
    </div>
  `;

  // Server-independent, static text — but set via textContent anyway to keep the
  // "no innerHTML for dynamic values" habit uniform across dialogs.
  const tagline = root.querySelector<HTMLElement>(".about-tagline");
  if (tagline) tagline.textContent = TAGLINE;

  const versionEl = root.querySelector<HTMLElement>(".about-version");
  const closeBtn = root.querySelector<HTMLButtonElement>('[data-action="close"]');

  const previouslyFocused = document.activeElement;
  const close = (): void => {
    document.removeEventListener("keydown", onKey, true);
    root.remove();
    if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
      previouslyFocused.focus();
    }
  };

  root.addEventListener("click", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.dataset.action === "close" || target.classList.contains("dialog-overlay")) {
      close();
    }
  });
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };
  document.addEventListener("keydown", onKey, true);

  document.body.appendChild(root);
  closeBtn?.focus();

  // Fill in the version once the backend answers; a failed ping leaves a plain
  // fallback rather than an error toast (this is an informational dialog).
  ping()
    .then((version) => {
      if (versionEl) versionEl.textContent = formatPingMessage(version);
    })
    .catch(() => {
      if (versionEl) versionEl.textContent = "Version unavailable";
    });
}
