/**
 * Trusted-hosts management dialog. Lists every host key the app has recorded
 * (TOFU) and lets the user forget one — after which the next connect to that
 * host re-prompts for trust. Opened from the padlock button in the header
 * (its own action, alongside settings).
 *
 * Host/fingerprint strings are server-controlled, so every dynamic value is
 * injected via `textContent`, never `innerHTML` (same rule as the host-key
 * trust dialog). Forgetting is a security-relevant, one-way action, so it goes
 * through a `danger` confirm first.
 */

import { forgetHost, listKnownHosts, type KnownHostEntry } from "../ipc";
import { confirm } from "../ui/confirm";

export interface KnownHostsDialogOptions {
  /** Surface a load/forget failure to the user (wired to the toast in main.ts). */
  onError: (message: string) => void;
}

/** Looks up a required element, throwing loudly on markup/code drift. */
function requireEl<E extends Element>(root: ParentNode, selector: string): E {
  const el = root.querySelector<E>(selector);
  if (!el) throw new Error(`Expected element not found: ${selector}`);
  return el;
}

/**
 * Open the trusted-hosts dialog. Resolves when the dialog is dismissed. The
 * dialog owns its own lifecycle (overlay/Escape/Close all dismiss and restore
 * focus to the trigger).
 */
export function openKnownHostsDialog(options: KnownHostsDialogOptions): void {
  const root = document.createElement("div");
  root.className = "dialog known-hosts-dialog";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.innerHTML = `
    <div class="dialog-overlay"></div>
    <div class="dialog-content known-hosts-content">
      <div class="dialog-header"><h2>Trusted hosts</h2></div>
      <p class="known-hosts-lead">
        Host keys you have trusted. Forget a host to be prompted again on the
        next connection — do this if a server was rebuilt or you no longer trust it.
      </p>
      <ul class="known-hosts-list" aria-live="polite"></ul>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" data-action="close">Close</button>
      </div>
    </div>
  `;

  const list = requireEl<HTMLUListElement>(root, ".known-hosts-list");
  const closeBtn = requireEl<HTMLButtonElement>(root, '[data-action="close"]');

  /** Reload the list from the backend and (re)render every row. */
  async function refresh(): Promise<void> {
    let hosts: KnownHostEntry[];
    try {
      hosts = await listKnownHosts();
    } catch (err) {
      options.onError(errorMessage(err));
      return;
    }
    renderList(list, hosts, async (entry) => {
      const ok = await confirm(
        `Forget the trusted host ${entry.id}? You will be asked to verify its ` +
          `key again the next time you connect.`,
        { title: "Forget host", confirmLabel: "Forget", danger: true },
      );
      if (!ok) return;
      try {
        await forgetHost(entry.id);
      } catch (err) {
        options.onError(errorMessage(err));
        return;
      }
      await refresh();
    });
  }

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
  closeBtn.focus();
  void refresh();
}

/** Render the host rows (or an empty-state note) into `list`. */
function renderList(
  list: HTMLUListElement,
  hosts: KnownHostEntry[],
  onForget: (entry: KnownHostEntry) => void,
): void {
  list.replaceChildren();

  if (hosts.length === 0) {
    const empty = document.createElement("li");
    empty.className = "known-hosts-empty";
    empty.textContent = "No trusted hosts yet.";
    list.appendChild(empty);
    return;
  }

  for (const entry of hosts) {
    const row = document.createElement("li");
    row.className = "known-hosts-row";

    const info = document.createElement("div");
    info.className = "known-hosts-info";
    const host = document.createElement("span");
    host.className = "known-hosts-id";
    host.textContent = entry.id;
    const fp = document.createElement("span");
    fp.className = "known-hosts-fp";
    fp.textContent = `${entry.keyType} · ${entry.fingerprint}`;
    info.append(host, fp);

    const forget = document.createElement("button");
    forget.type = "button";
    forget.className = "btn btn-danger known-hosts-forget";
    forget.textContent = "Forget";
    forget.addEventListener("click", () => onForget(entry));

    row.append(info, forget);
    list.appendChild(row);
  }
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(err);
}
