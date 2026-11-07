/**
 * Keyboard-interactive prompt dialog: what a server asks while a connection
 * authenticates (a 2FA code, a PAM question), from any source — pane, tunnel,
 * Files panel, Test connection. One prompt at a time, each answered on its
 * own (a one-time code is never reused). Every text is the server's, so it
 * goes in as `textContent`; answers leave the DOM as soon as they are sent.
 */

import {
  markAuthPromptShown,
  onAuthPrompt,
  onAuthPromptClosed,
  respondAuthPrompt,
  type AuthPromptEvent,
  type AuthPromptField,
} from "../ipc";
import { requireEl } from "../ui/dom";
import { consumeKey, isTopDialog, pushDialog, removeDialog } from "../ui/dialogStack";
import { t } from "../i18n";
import { PromptQueue } from "./promptQueue";
import { showToast } from "../ui/toast";

/** A key pressed elsewhere this recently means the user is typing there: a
 * prompt shown now must not take the rest of those keys (a password meant for
 * a terminal). */
const TYPING_PAUSE_MS = 1000;
/** A prompt this new ignores Enter and Escape: a repeated Enter or a vim
 * user's Esc was not meant for it. */
const ARM_DELAY_MS = 1000;

interface AuthPromptView {
  root: HTMLElement;
  form: HTMLFormElement;
  lead: HTMLElement;
  name: HTMLElement;
  instructions: HTMLElement;
  fields: HTMLElement;
}

export function initAuthPromptDialog(): () => void {
  const dialog = new AuthPromptDialog();
  return () => dialog.dispose();
}

class AuthPromptDialog {
  private readonly view = buildView();
  private readonly queue = new PromptQueue<AuthPromptEvent>();
  private readonly unlisteners: Promise<() => void>[];
  private lastOutsideKeyAt = Number.NEGATIVE_INFINITY;
  private shownAt = Number.NEGATIVE_INFINITY;
  private readonly onKey = (e: KeyboardEvent): void => {
    this.noteOutsideKey(e);
    if (!this.isEscapeForThis(e) || !this.isArmed()) return;
    consumeKey(e);
    this.answer(null);
  };

  constructor() {
    this.view.form.addEventListener("submit", (e) => this.submit(e));
    this.view.root.addEventListener("click", (e) => this.cancelOnButton(e));
    document.addEventListener("keydown", this.onKey, true);
    this.unlisteners = [
      onAuthPrompt((event) => this.enqueue(event)),
      onAuthPromptClosed((promptId) => this.dropClosed(promptId)),
    ];
  }

  dispose(): void {
    document.removeEventListener("keydown", this.onKey, true);
    removeDialog(this.view.root);
    this.unlisteners.forEach((unlisten) => void unlisten.then((stop) => stop()));
    this.view.root.remove();
  }

  private enqueue(event: AuthPromptEvent): void {
    if (event.fields.length === 0) showInformation(event);
    else if (this.queue.push(event)) this.render();
  }

  private dropClosed(promptId: string): void {
    if (this.queue.drop(promptId)) this.render();
  }

  private submit(e: Event): void {
    e.preventDefault();
    if (this.isArmed()) this.answer(readAnswers(this.view.fields));
  }

  private noteOutsideKey(e: KeyboardEvent): void {
    if (e.target instanceof Node && this.view.root.contains(e.target)) return;
    this.lastOutsideKeyAt = performance.now();
  }

  private isArmed(): boolean {
    return performance.now() - this.shownAt >= ARM_DELAY_MS;
  }

  private cancelOnButton(e: Event): void {
    if (isCancelButton(e.target)) this.answer(null);
  }

  private isEscapeForThis(e: KeyboardEvent): boolean {
    return this.queue.current !== null && e.key === "Escape" && isTopDialog(this.view.root);
  }

  /** Answer the prompt on screen and move on before the IPC round trip, so a
   * slow or failed delivery never wedges the dialog. */
  private answer(answers: string[] | null): void {
    const prompt = this.queue.current;
    if (!prompt) return;
    this.queue.advance();
    this.render();
    void deliver(prompt.promptId, answers);
  }

  private render(): void {
    this.shownAt = performance.now();
    const typing = this.shownAt - this.lastOutsideKeyAt < TYPING_PAUSE_MS;
    const prompt = this.queue.current;
    renderPrompt(this.view, prompt, typing);
    if (prompt) void markShown(prompt.promptId);
  }
}

function buildView(): AuthPromptView {
  const root = document.createElement("div");
  root.className = "dialog dialog-hidden authprompt-dialog";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-hidden", "true");
  root.innerHTML = dialogMarkup();
  document.body.appendChild(root);
  return {
    root,
    form: requireEl<HTMLFormElement>(root, ".authprompt-form"),
    lead: requireEl<HTMLElement>(root, ".authprompt-lead"),
    name: requireEl<HTMLElement>(root, ".authprompt-name"),
    instructions: requireEl<HTMLElement>(root, ".authprompt-instructions"),
    fields: requireEl<HTMLElement>(root, ".authprompt-fields"),
  };
}

function dialogMarkup(): string {
  return `
    <div class="dialog-overlay"></div>
    <form class="dialog-content authprompt-content authprompt-form" autocomplete="off" tabindex="-1">
      <div class="dialog-header">
        <h2 data-i18n="authPrompt.heading">${t("authPrompt.heading")}</h2>
      </div>
      <div class="authprompt-body">
        <p class="authprompt-lead"></p>
        <p class="authprompt-name"></p>
        <p class="authprompt-instructions"></p>
        <div class="authprompt-fields"></div>
      </div>
      ${actionsMarkup()}
    </form>
  `;
}

function actionsMarkup(): string {
  return `
    <div class="form-actions">
      <button type="submit" class="btn btn-primary" data-i18n="common.continue">${t("common.continue")}</button>
      <button type="button" class="btn btn-secondary" data-authprompt-action="cancel" data-i18n="common.cancel">
        ${t("common.cancel")}
      </button>
    </div>
  `;
}

function renderPrompt(view: AuthPromptView, prompt: AuthPromptEvent | null, typing: boolean): void {
  view.fields.replaceChildren();
  if (!prompt) {
    hide(view.root);
    return;
  }
  const target = `${prompt.username}@${prompt.host}:${prompt.port}`;
  view.lead.textContent = t("authPrompt.lead", { target });
  setOptionalText(view.name, prompt.name);
  setOptionalText(view.instructions, prompt.instructions);
  view.fields.append(...prompt.fields.map(buildField));
  show(view.root);
  focusPrompt(view, typing);
}

/** While the user types, the dialog itself takes focus: keys go nowhere and
 * Enter submits nothing; Tab or a click reaches the field. */
function focusPrompt(view: AuthPromptView, typing: boolean): void {
  const field = view.fields.querySelector("input");
  (typing || !field ? view.form : field).focus();
}

function buildField(field: AuthPromptField, index: number): HTMLElement {
  const group = document.createElement("div");
  group.className = "form-group";
  const label = document.createElement("label");
  const input = document.createElement("input");
  input.id = `authprompt-field-${index}`;
  input.type = field.echo ? "text" : "password";
  input.autocomplete = "off";
  input.spellcheck = false;
  label.htmlFor = input.id;
  label.textContent = field.label;
  group.append(label, input);
  return group;
}

function setOptionalText(el: HTMLElement, text: string): void {
  el.textContent = text;
  el.hidden = text.trim() === "";
}

function readAnswers(fields: HTMLElement): string[] {
  return [...fields.querySelectorAll("input")].map((input) => input.value);
}

function isCancelButton(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.dataset.authpromptAction === "cancel";
}

/** A round asking nothing ("approve the push on your phone"): nothing to
 * answer, so a toast rather than a prompt. */
function showInformation(event: AuthPromptEvent): void {
  const target = `${event.username}@${event.host}:${event.port}`;
  const message = [event.name, event.instructions].filter((text) => text.trim()).join(" — ");
  showToast(t("authPrompt.info", { target, message }), "info");
}

/** Raised above other dialogs only when it opens: moving on to the next
 * prompt must not jump over a dialog opened since. */
function show(root: HTMLElement): void {
  if (!root.classList.contains("dialog-hidden")) return;
  root.classList.remove("dialog-hidden");
  root.setAttribute("aria-hidden", "false");
  // Dialogs share one z-index: the last in the DOM paints on top.
  document.body.appendChild(root);
  pushDialog(root);
}

function hide(root: HTMLElement): void {
  root.classList.add("dialog-hidden");
  root.setAttribute("aria-hidden", "true");
  removeDialog(root);
}

/** The backend times the prompt out from now; failing that, from when it
 * sent it. */
async function markShown(promptId: string): Promise<void> {
  try {
    await markAuthPromptShown(promptId);
  } catch {
    /* the backend times the prompt out on its own */
  }
}

async function deliver(promptId: string, answers: string[] | null): Promise<void> {
  try {
    await respondAuthPrompt(promptId, answers);
  } catch {
    /* the backend times the prompt out on its own */
  }
}
