/**
 * Host-key trust dialog (SPEC §6/§7). Listens for `host_key_prompt` events
 * (raised by a live connect or by `test_connection`) and resolves each via
 * `respond_host_key`. A *changed* key gets a prominent MITM warning variant.
 *
 * Only one prompt is shown at a time; concurrent prompts queue. Dynamic values
 * (host, fingerprint) are injected via `textContent`, never `innerHTML`, since
 * they are server-controlled strings.
 */

import {
  onHostKeyPrompt,
  respondHostKey,
  type HostKeyPromptEvent,
} from "../ipc";
import { hostKeyDialogText } from "./overlay";
import { requireEl } from "../ui/dom";
import { t } from "../i18n";

export function initHostKeyDialog(): () => void {
  const root = document.createElement("div");
  root.className = "dialog dialog-hidden hostkey-dialog";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-hidden", "true");
  root.innerHTML = `
    <div class="dialog-overlay"></div>
    <div class="dialog-content hostkey-content">
      <div class="dialog-header">
        <h2 class="hostkey-heading"></h2>
      </div>
      <p class="hostkey-lead"></p>
      <dl class="hostkey-facts">
        <div><dt>${t("hostkey.host")}</dt><dd class="hostkey-host"></dd></div>
        <div><dt>${t("hostkey.keyType")}</dt><dd class="hostkey-keytype"></dd></div>
        <div><dt>${t("hostkey.fingerprint")}</dt><dd class="hostkey-fingerprint"></dd></div>
      </dl>
      <div class="form-actions">
        <button type="button" class="btn btn-danger" data-hostkey-action="trust">
          ${t("hostkey.trust")}
        </button>
        <button type="button" class="btn btn-secondary" data-hostkey-action="reject">
          ${t("hostkey.reject")}
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(root);

  const queue: HostKeyPromptEvent[] = [];
  let current: HostKeyPromptEvent | null = null;

  const heading = requireEl<HTMLElement>(root, ".hostkey-heading");
  const lead = requireEl<HTMLElement>(root, ".hostkey-lead");
  const hostEl = requireEl<HTMLElement>(root, ".hostkey-host");
  const keyTypeEl = requireEl<HTMLElement>(root, ".hostkey-keytype");
  const fingerprintEl = requireEl<HTMLElement>(root, ".hostkey-fingerprint");
  const content = requireEl<HTMLElement>(root, ".hostkey-content");
  const rejectBtn = requireEl<HTMLButtonElement>(
    root,
    '[data-hostkey-action="reject"]',
  );

  function showNext(): void {
    const next = queue.shift();
    if (!next) {
      current = null;
      root.classList.add("dialog-hidden");
      root.setAttribute("aria-hidden", "true");
      return;
    }
    current = next;
    const text = hostKeyDialogText(next);
    heading.textContent = text.heading;
    lead.textContent = text.lead;
    hostEl.textContent = `${next.host}:${next.port}`;
    keyTypeEl.textContent = next.keyType;
    fingerprintEl.textContent = next.fingerprint;
    content.classList.toggle("hostkey-danger", text.danger);
    root.classList.remove("dialog-hidden");
    root.setAttribute("aria-hidden", "false");
    // Focus the safe default (Reject), not Trust — so a stray Enter/Space never
    // trusts an unknown or changed key.
    rejectBtn.focus();
  }

  async function respond(accept: boolean): Promise<void> {
    const prompt = current;
    if (!prompt) return;
    // Advance the UI first so a slow IPC round trip can't wedge the dialog; a
    // failure to deliver the response is non-fatal (the backend prompt simply
    // times out and rejects).
    current = null;
    showNext();
    try {
      await respondHostKey(prompt.promptId, accept);
    } catch {
      /* backend will time out and reject on its own */
    }
  }

  const onClick = (e: Event): void => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const action = target.dataset.hostkeyAction;
    if (action === "trust") void respond(true);
    else if (action === "reject") void respond(false);
  };
  root.addEventListener("click", onClick);

  // Escape rejects the prompt (safe default) — never leaves it wedged open.
  const onKey = (e: KeyboardEvent): void => {
    if (current && e.key === "Escape") {
      e.preventDefault();
      void respond(false);
    }
  };
  document.addEventListener("keydown", onKey, true);

  const unlistenPromise = onHostKeyPrompt((event) => {
    queue.push(event);
    if (!current) showNext();
  });

  return () => {
    root.removeEventListener("click", onClick);
    document.removeEventListener("keydown", onKey, true);
    void unlistenPromise.then((unlisten) => unlisten());
    root.remove();
  };
}
