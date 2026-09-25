/**
 * Static markup for the device manager: the sidebar (device list header,
 * export/import actions, list container) and the add/edit device dialog (SSH
 * and serial field groups, auth sections, forwards placeholder, actions).
 *
 * Kept as a single template string separate from the controller so the ~200
 * lines of markup don't drown the event-wiring and backend logic in
 * `deviceManager.ts`. The controller sets this as the container's `innerHTML`
 * once, then queries the ids/classes below; a change here must keep those
 * selectors (`#device-form`, `#device-kind`, `#ssh-fields`, `#serial-fields`,
 * `#device-secret`, `.device-add-btn`, …) intact.
 *
 * User-facing copy is localized via `t()` at build time; the markup is rebuilt
 * (and so re-translated) on a language change (see `deviceManager.renderUI`).
 */

import { t } from "../i18n";
import { exportFileIcon, exportIcon, importFileIcon, importIcon, plusIcon } from "../ui/icons";

export function deviceManagerMarkup(): string {
  return `
      <div class="device-manager">
        <div class="device-list-header">
          <h2>${t("devices.title")}</h2>
          <div class="device-header-actions">
            <button
              class="btn btn-icon device-export-btn"
              data-action="export"
              title="${t("devices.export.title")}"
              aria-label="${t("common.export")}"
            >
              ${exportIcon}
            </button>
            <button
              class="btn btn-icon device-import-btn"
              data-action="import"
              title="${t("devices.import.title")}"
              aria-label="${t("common.import")}"
            >
              ${importIcon}
            </button>
            <button
              class="btn btn-icon device-import-ssh-btn"
              data-action="import-ssh-config"
              title="${t("devices.importSsh.title")}"
              aria-label="${t("devices.importSsh")}"
            >
              ${importFileIcon}
            </button>
            <button
              class="btn btn-icon device-export-ssh-btn"
              data-action="export-ssh-config"
              title="${t("devices.exportSsh.title")}"
              aria-label="${t("devices.exportSsh")}"
            >
              ${exportFileIcon}
            </button>
            <button
              class="btn btn-icon btn-primary device-add-btn"
              title="${t("devices.add.title")}"
              aria-label="${t("devices.add.title")}"
            >
              ${plusIcon}
            </button>
          </div>
        </div>
        <div class="device-search-wrap">
          <input
            type="search"
            class="device-search"
            placeholder="${t("devices.search.placeholder")}"
            aria-label="${t("devices.search.aria")}"
            autocomplete="off"
          />
        </div>
        <div class="device-list-items"></div>
      </div>
      <div id="device-dialog" class="dialog dialog-hidden" aria-hidden="true">
        <div class="dialog-overlay" data-close-dialog></div>
        <div class="dialog-content">
          <div class="dialog-header">
            <h2 id="device-dialog-title">${t("devices.dialog.addTitle")}</h2>
            <button class="dialog-close-btn" data-close-dialog aria-label="${t("common.close")}">
              &times;
            </button>
          </div>
          <form id="device-form" class="device-form">
            <div class="form-group">
              <label for="device-name">${t("devices.field.name")}</label>
              <input id="device-name" type="text" placeholder="${t("devices.field.name.placeholder")}" />
              <span class="error-text"></span>
            </div>

            <div class="form-group">
              <label for="device-tags">${t("devices.field.tags")}</label>
              <input
                id="device-tags"
                type="text"
                placeholder="${t("devices.field.tags.placeholder")}"
                autocomplete="off"
              />
              <span class="error-text"></span>
            </div>

            <div class="form-group">
              <label for="device-kind">${t("devices.field.kind")}</label>
              <select id="device-kind">
                <option value="ssh" selected>${t("devices.kind.ssh")}</option>
                <option value="serial">${t("devices.kind.serial")}</option>
                <option value="localShell">${t("devices.kind.localShell")}</option>
              </select>
            </div>

            <div id="ssh-fields">
            <div class="form-group">
              <label for="device-host">${t("devices.field.host")}</label>
              <input id="device-host" type="text" placeholder="${t("devices.field.host.placeholder")}" />
              <span class="error-text"></span>
            </div>

            <div class="form-group">
              <label for="device-port">${t("devices.field.port")}</label>
              <input
                id="device-port"
                type="number"
                placeholder="22"
                min="1"
                max="65535"
              />
              <span class="error-text"></span>
            </div>

            <div class="form-group">
              <label for="device-username">${t("devices.field.username")}</label>
              <input
                id="device-username"
                type="text"
                placeholder="${t("devices.field.username.placeholder")}"
                autocomplete="off"
              />
              <span class="error-text"></span>
            </div>

            <fieldset class="form-fieldset">
              <legend>${t("devices.auth.legend")}</legend>
              <div class="form-group">
                <label>
                  <input
                    type="radio"
                    name="auth-method"
                    value="password"
                    checked
                  />
                  ${t("devices.auth.password")}
                </label>
                <label>
                  <input type="radio" name="auth-method" value="key" />
                  ${t("devices.auth.key")}
                </label>
                <label>
                  <input type="radio" name="auth-method" value="agent" />
                  ${t("devices.auth.agent")}
                </label>
              </div>
            </fieldset>

            <div id="auth-password" class="auth-method-section">
              <div class="form-group">
                <label for="device-secret">${t("devices.field.secret")}</label>
                <input
                  id="device-secret"
                  type="password"
                  placeholder="${t("devices.field.secret.placeholder")}"
                />
                <span class="error-text"></span>
              </div>
            </div>

            <div id="auth-key" class="auth-method-section auth-method-hidden">
              <div class="form-group">
                <label for="device-key-path">${t("devices.field.keyPath")}</label>
                <input id="device-key-path" type="text" placeholder="" />
                <span class="error-text"></span>
              </div>
              <div class="form-group">
                <label for="device-passphrase">${t("devices.field.passphrase")}</label>
                <input id="device-passphrase" type="password" placeholder="" />
                <span class="error-text"></span>
              </div>
            </div>

            <div id="auth-agent" class="auth-method-section auth-method-hidden">
              <div class="form-group">
                <label for="device-agent-identity">${t("devices.field.agentIdentity")}</label>
                <div class="agent-identity-row">
                  <select id="device-agent-identity"></select>
                  <button
                    type="button"
                    id="device-agent-refresh"
                    class="btn btn-small"
                  >
                    ${t("devices.agent.refresh")}
                  </button>
                </div>
                <span id="device-agent-status" class="form-hint"></span>
                <span class="error-text"></span>
              </div>
            </div>

            <div class="form-group">
              <label for="device-proxy-jump">${t("devices.field.proxyJump")}</label>
              <select id="device-proxy-jump">
                <option value="">${t("devices.proxyJump.none")}</option>
              </select>
            </div>

            <div id="device-forwards" class="forwards-section"></div>
            <div class="form-group form-group-checkbox">
              <label for="device-tunnel-autostart">
                <input id="device-tunnel-autostart" type="checkbox" />
                ${t("devices.tunnelAutostart")}
              </label>
            </div>
            <div class="form-group form-group-checkbox">
              <label for="device-forward-agent">
                <input id="device-forward-agent" type="checkbox" />
                ${t("devices.forwardAgent")}
              </label>
              <span class="form-hint">${t("devices.forwardAgent.hint")}</span>
              <span class="form-hint form-hint-warn device-agent-unavailable" hidden>
                ${t("devices.forwardAgent.unavailable")}
              </span>
            </div>
            </div>

            <div id="serial-fields" class="device-kind-hidden">
              <div class="form-group">
                <label for="device-port-name">${t("devices.field.portName")}</label>
                <input
                  id="device-port-name"
                  type="text"
                  placeholder="${t("devices.field.portName.placeholder")}"
                  autocomplete="off"
                />
                <span class="error-text"></span>
              </div>
              <div class="form-group">
                <label for="device-baud-rate">${t("devices.field.baudRate")}</label>
                <select id="device-baud-rate">
                  <option value="300">300</option>
                  <option value="1200">1200</option>
                  <option value="2400">2400</option>
                  <option value="4800">4800</option>
                  <option value="9600">9600</option>
                  <option value="19200">19200</option>
                  <option value="38400">38400</option>
                  <option value="57600">57600</option>
                  <option value="74880">74880</option>
                  <option value="115200" selected>115200</option>
                  <option value="230400">230400</option>
                  <option value="250000">250000</option>
                  <option value="500000">500000</option>
                  <option value="1000000">1000000</option>
                  <option value="2000000">2000000</option>
                </select>
                <span class="error-text"></span>
              </div>
              <fieldset class="form-fieldset">
                <legend>${t("devices.framing.legend")}</legend>
                <div class="form-group">
                  <label for="device-data-bits">${t("devices.field.dataBits")}</label>
                  <select id="device-data-bits">
                    <option value="8" selected>8</option>
                    <option value="7">7</option>
                    <option value="6">6</option>
                    <option value="5">5</option>
                  </select>
                </div>
                <div class="form-group">
                  <label for="device-parity">${t("devices.field.parity")}</label>
                  <select id="device-parity">
                    <option value="none" selected>${t("devices.parity.none")}</option>
                    <option value="odd">${t("devices.parity.odd")}</option>
                    <option value="even">${t("devices.parity.even")}</option>
                  </select>
                </div>
                <div class="form-group">
                  <label for="device-stop-bits">${t("devices.field.stopBits")}</label>
                  <select id="device-stop-bits">
                    <option value="1" selected>1</option>
                    <option value="2">2</option>
                  </select>
                </div>
                <div class="form-group">
                  <label for="device-flow-control">${t("devices.field.flowControl")}</label>
                  <select id="device-flow-control">
                    <option value="none" selected>${t("devices.flow.none")}</option>
                    <option value="software">${t("devices.flow.software")}</option>
                    <option value="hardware">${t("devices.flow.hardware")}</option>
                  </select>
                </div>
              </fieldset>
            </div>

            <div id="local-shell-fields" class="device-kind-hidden">
              <div class="form-group">
                <label for="device-shell">${t("devices.field.shell")}</label>
                <input
                  id="device-shell"
                  type="text"
                  placeholder="${t("devices.field.shell.placeholder")}"
                  autocomplete="off"
                />
                <span class="error-text"></span>
              </div>
              <div class="form-group">
                <label for="device-cwd">${t("devices.field.cwd")}</label>
                <input
                  id="device-cwd"
                  type="text"
                  placeholder="${t("devices.field.cwd.placeholder")}"
                  autocomplete="off"
                />
                <span class="error-text"></span>
              </div>
            </div>

            <div class="form-group">
              <label for="device-connect-snippet">${t("devices.field.connectSnippet")}</label>
              <textarea
                id="device-connect-snippet"
                rows="3"
                placeholder="${t("devices.field.connectSnippet.placeholder")}"
                autocomplete="off"
                spellcheck="false"
              ></textarea>
              <span class="form-hint">${t("devices.field.connectSnippet.hint")}</span>
              <span class="error-text"></span>
            </div>

            <div class="form-group form-group-checkbox">
              <label for="device-auto-reconnect">
                <input id="device-auto-reconnect" type="checkbox" />
                ${t("devices.autoReconnect")}
              </label>
            </div>

            <div class="form-actions">
              <button
                type="button"
                class="btn btn-secondary btn-test-connection"
              >
                ${t("devices.test")}
              </button>
              <button type="submit" class="btn btn-primary">${t("common.save")}</button>
              <button type="button" class="btn btn-secondary" data-close-dialog>
                ${t("common.cancel")}
              </button>
            </div>
          </form>
        </div>
      </div>
    `;
}
