/**
 * Host-key trust dialog (SPEC §6/§7). Listens for `host_key_prompt` events
 * (raised by a live connect or by `test_connection`) and resolves each via
 * `respond_host_key`. A *changed* key gets a prominent MITM warning variant.
 *
 * Only one prompt is shown at a time; concurrent prompts queue, and one answer
 * covers every queued prompt for the same host key (e.g. a profile opening
 * several panes to one new host). A prompt the backend stops waiting on
 * (`host_key_prompt_closed`) is dropped, so Trust never silently does nothing.
 * Dynamic values
 * (host, fingerprint) are injected via `textContent`, never `innerHTML`, since
 * they are server-controlled strings.
 */

import {
  onHostKeyPrompt,
  onHostKeyPromptClosed,
  respondHostKey,
  type HostKeyPromptEvent,
} from "../ipc";
import { hostKeyDialogText } from "./overlay";
import { requireEl } from "../ui/dom";
import { consumeKey, isTopDialog, pushDialog, removeDialog } from "../ui/dialogStack";
import { t } from "../i18n";

/** How long Trust stays disabled after a prompt appears: a prompt can swap in
 * under the cursor (the one before it answered or dropped), and a click meant
 * for that one must not trust this one. */
export const TRUST_ARM_DELAY_MS = 600;

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
        <div><dt data-i18n="hostkey.host">${t("hostkey.host")}</dt><dd class="hostkey-host"></dd></div>
        <div><dt data-i18n="hostkey.keyType">${t("hostkey.keyType")}</dt><dd class="hostkey-keytype"></dd></div>
        <div><dt data-i18n="hostkey.fingerprint">${t("hostkey.fingerprint")}</dt><dd class="hostkey-fingerprint"></dd></div>
      </dl>
      <div class="form-actions">
        <button type="button" class="btn btn-danger" data-hostkey-action="trust" data-i18n="hostkey.trust">
          ${t("hostkey.trust")}
        </button>
        <button type="button" class="btn btn-secondary" data-hostkey-action="reject" data-i18n="hostkey.reject">
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
  const trustBtn = requireEl<HTMLButtonElement>(root, '[data-hostkey-action="trust"]');
  let armTimer: number | undefined;

  function armTrustLater(): void {
    window.clearTimeout(armTimer);
    trustBtn.disabled = true;
    armTimer = window.setTimeout(() => (trustBtn.disabled = false), TRUST_ARM_DELAY_MS);
  }

  function showNext(): void {
    const next = queue.shift();
    if (!next) {
      current = null;
      root.classList.add("dialog-hidden");
      root.setAttribute("aria-hidden", "true");
      removeDialog(root);
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
    // Dialogs share one z-index, so the last in the DOM paints on top: one
    // opened after this root was created would hide the prompt while it holds
    // focus and the keys. Moving it last keeps what is seen and what is
    // answered the same.
    document.body.appendChild(root);
    pushDialog(root);
    armTrustLater();
    // Focus the safe default (Reject), not Trust — so a stray Enter/Space never
    // trusts an unknown or changed key.
    rejectBtn.focus();
  }

  async function respond(accept: boolean): Promise<void> {
    const prompt = current;
    if (!prompt) return;
    // The same answer covers every queued prompt for this exact host key.
    const answered = [prompt, ...takeSameKey(prompt)];
    // Advance the UI first so a slow IPC round trip can't wedge the dialog; a
    // failure to deliver the response is non-fatal (the backend prompt simply
    // times out and rejects).
    current = null;
    showNext();
    await Promise.all(answered.map((p) => deliver(p.promptId, accept)));
  }

  /** Remove and return the queued prompts for the same host + key as `prompt`. */
  function takeSameKey(prompt: HostKeyPromptEvent): HostKeyPromptEvent[] {
    const same = queue.filter((p) => isSameKey(p, prompt));
    removeFromQueue((p) => isSameKey(p, prompt));
    return same;
  }

  function removeFromQueue(match: (p: HostKeyPromptEvent) => boolean): void {
    const kept = queue.filter((p) => !match(p));
    queue.splice(0, queue.length, ...kept);
  }

  async function deliver(promptId: string, accept: boolean): Promise<void> {
    try {
      await respondHostKey(promptId, accept);
    } catch {
      /* backend will time out and reject on its own */
    }
  }

  /** The backend stopped waiting on `promptId`: forget it, advancing past it
   * if it is the one on screen. */
  function dropClosed(promptId: string): void {
    removeFromQueue((p) => p.promptId === promptId);
    if (current?.promptId === promptId) showNext();
  }

  const onClick = (e: Event): void => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const action = target.dataset.hostkeyAction;
    if (action === "trust" && !trustBtn.disabled) void respond(true);
    else if (action === "reject") void respond(false);
  };
  root.addEventListener("click", onClick);

  // Escape rejects the prompt (safe default) — never leaves it wedged open.
  const onKey = (e: KeyboardEvent): void => {
    if (current && e.key === "Escape" && isTopDialog(root)) {
      consumeKey(e);
      void respond(false);
    }
  };
  document.addEventListener("keydown", onKey, true);

  const unlistenPromise = onHostKeyPrompt((event) => {
    queue.push(event);
    if (!current) showNext();
  });
  const unlistenClosedPromise = onHostKeyPromptClosed(dropClosed);

  return () => {
    root.removeEventListener("click", onClick);
    document.removeEventListener("keydown", onKey, true);
    window.clearTimeout(armTimer);
    removeDialog(root);
    void unlistenPromise.then((unlisten) => unlisten());
    void unlistenClosedPromise.then((unlisten) => unlisten());
    root.remove();
  };
}

/** Same host, key and verdict — a changed-key prompt is never answered by a
 * neutral unknown-key one (it must always get its own loud warning). */
function isSameKey(a: HostKeyPromptEvent, b: HostKeyPromptEvent): boolean {
  return (
    a.host === b.host &&
    a.port === b.port &&
    a.fingerprint === b.fingerprint &&
    a.changed === b.changed
  );
}
