/**
 * A chmod dialog: a 3×3 grid of read/write/execute checkboxes for
 * owner/group/other, prefilled from `mode`, with a live octal readout. Resolves
 * the new mode (the edited rwx bits merged with the original's special bits, so
 * setuid/setgid/sticky are preserved), or `null` on cancel / overlay / Escape.
 */

import { t } from "../i18n";
import { cancelOnEscape, createDialogRoot, focusAction, setText, showModal } from "./modalDialog";

const SPECIAL_BITS = 0o7000;
const PERMISSION_BITS = [
  { bit: 4, letter: "r" },
  { bit: 2, letter: "w" },
  { bit: 1, letter: "x" },
];

export function choosePermissions(name: string, mode: number): Promise<number | null> {
  const root = createDialogRoot("perms-dialog", permissionsHtml());
  setText(root, ".perms-title", t("sftp.perms.title"));
  setText(root, ".perms-name", name);
  root.querySelector(".perms-body")?.append(...permissionClasses().map((c) => createClassRow(c, mode)));
  const refreshOctal = (): void => setText(root, ".perms-octal", octalOf(readMode(root, mode)));
  refreshOctal();
  root.addEventListener("change", refreshOctal);
  return showModal<number | null>(root, {
    cancelValue: null,
    actions: { ok: () => readMode(root, mode) },
    keyResult: cancelOnEscape(null),
    focus: focusAction("ok"),
  });
}

function permissionsHtml(): string {
  return `
      <div class="dialog-overlay"></div>
      <div class="dialog-content perms-content">
        <div class="dialog-header"><h2 class="perms-title"></h2></div>
        <p class="perms-name"></p>
        <table class="perms-grid">
          ${permissionsHeadHtml()}
          <tbody class="perms-body"></tbody>
        </table>
        <p class="perms-octal" aria-live="polite"></p>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" data-action="cancel">${t("common.cancel")}</button>
          <button type="button" class="btn btn-primary" data-action="ok">${t("common.ok")}</button>
        </div>
      </div>
    `;
}

function permissionsHeadHtml(): string {
  return `<thead>
            <tr>
              <th></th>
              <th>${t("sftp.perms.read")}</th>
              <th>${t("sftp.perms.write")}</th>
              <th>${t("sftp.perms.exec")}</th>
            </tr>
          </thead>`;
}

interface PermissionClass {
  label: string;
  shift: number;
}

function permissionClasses(): PermissionClass[] {
  return [
    { label: t("sftp.perms.owner"), shift: 6 },
    { label: t("sftp.perms.group"), shift: 3 },
    { label: t("sftp.perms.other"), shift: 0 },
  ];
}

function createClassRow({ label, shift }: PermissionClass, mode: number): HTMLTableRowElement {
  const row = document.createElement("tr");
  const header = document.createElement("th");
  header.scope = "row";
  header.textContent = label;
  row.appendChild(header);
  for (const { bit, letter } of PERMISSION_BITS) {
    row.appendChild(createBitCell(`${label} ${letter}`, bit << shift, mode));
  }
  return row;
}

function createBitCell(ariaLabel: string, value: number, mode: number): HTMLTableCellElement {
  const cell = document.createElement("td");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = (mode & value) !== 0;
  box.dataset.value = String(value);
  box.setAttribute("aria-label", ariaLabel);
  cell.appendChild(box);
  return cell;
}

/** The edited rwx bits merged with the original special bits. */
function readMode(root: HTMLElement, mode: number): number {
  const boxes = root.querySelectorAll<HTMLInputElement>('.perms-body input[type="checkbox"]');
  return [...boxes].filter((box) => box.checked).reduce((bits, box) => bits | Number(box.dataset.value), mode & SPECIAL_BITS);
}

function octalOf(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(3, "0");
}
