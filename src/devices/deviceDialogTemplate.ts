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
 */
export function deviceManagerMarkup(): string {
  return `
      <div class="device-manager">
        <div class="device-list-header">
          <h2>Devices</h2>
          <button class="btn btn-primary device-add-btn" title="Add device">
            +
          </button>
        </div>
        <div class="section-actions">
          <button
            class="btn btn-small device-export-btn"
            data-action="export"
            title="Export devices to a JSON file"
          >
            Export
          </button>
          <button
            class="btn btn-small device-import-btn"
            data-action="import"
            title="Import devices from a JSON file"
          >
            Import
          </button>
          <button
            class="btn btn-small device-import-ssh-btn"
            data-action="import-ssh-config"
            title="Import devices from an OpenSSH config (~/.ssh/config)"
          >
            Import SSH config
          </button>
        </div>
        <div class="device-list-items"></div>
      </div>
      <div id="device-dialog" class="dialog dialog-hidden" aria-hidden="true">
        <div class="dialog-overlay" data-close-dialog></div>
        <div class="dialog-content">
          <div class="dialog-header">
            <h2 id="device-dialog-title">Add Device</h2>
            <button class="dialog-close-btn" data-close-dialog aria-label="Close">
              &times;
            </button>
          </div>
          <form id="device-form" class="device-form">
            <div class="form-group">
              <label for="device-name">Name</label>
              <input id="device-name" type="text" placeholder="My Server" />
              <span class="error-text"></span>
            </div>

            <div class="form-group">
              <label for="device-kind">Connection type</label>
              <select id="device-kind">
                <option value="ssh" selected>SSH</option>
                <option value="serial">Serial (COM port)</option>
              </select>
            </div>

            <div id="ssh-fields">
            <div class="form-group">
              <label for="device-host">Host</label>
              <input id="device-host" type="text" placeholder="192.168.1.10" />
              <span class="error-text"></span>
            </div>

            <div class="form-group">
              <label for="device-port">Port</label>
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
              <label for="device-username">Username</label>
              <input
                id="device-username"
                type="text"
                placeholder="admin"
                autocomplete="off"
              />
              <span class="error-text"></span>
            </div>

            <fieldset class="form-fieldset">
              <legend>Authentication</legend>
              <div class="form-group">
                <label>
                  <input
                    type="radio"
                    name="auth-method"
                    value="password"
                    checked
                  />
                  Password
                </label>
                <label>
                  <input type="radio" name="auth-method" value="key" />
                  Key
                </label>
              </div>
            </fieldset>

            <div id="auth-password" class="auth-method-section">
              <div class="form-group">
                <label for="device-secret">Secret</label>
                <input
                  id="device-secret"
                  type="password"
                  placeholder="unchanged"
                />
                <span class="error-text"></span>
              </div>
            </div>

            <div id="auth-key" class="auth-method-section auth-method-hidden">
              <div class="form-group">
                <label for="device-key-path">Key Path</label>
                <input id="device-key-path" type="text" placeholder="" />
                <span class="error-text"></span>
              </div>
              <div class="form-group">
                <label for="device-passphrase">Passphrase (optional)</label>
                <input id="device-passphrase" type="password" placeholder="" />
                <span class="error-text"></span>
              </div>
            </div>

            <div id="device-forwards" class="forwards-section"></div>
            <div class="form-group form-group-checkbox">
              <label for="device-tunnel-autostart">
                <input id="device-tunnel-autostart" type="checkbox" />
                Start tunnel automatically on app launch
              </label>
            </div>
            </div>

            <div id="serial-fields" class="device-kind-hidden">
              <div class="form-group">
                <label for="device-port-name">Port name</label>
                <input
                  id="device-port-name"
                  type="text"
                  placeholder="COM3 or /dev/ttyUSB0"
                  autocomplete="off"
                />
                <span class="error-text"></span>
              </div>
              <div class="form-group">
                <label for="device-baud-rate">Baud rate</label>
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
                <legend>Framing (advanced)</legend>
                <div class="form-group">
                  <label for="device-data-bits">Data bits</label>
                  <select id="device-data-bits">
                    <option value="8" selected>8</option>
                    <option value="7">7</option>
                    <option value="6">6</option>
                    <option value="5">5</option>
                  </select>
                </div>
                <div class="form-group">
                  <label for="device-parity">Parity</label>
                  <select id="device-parity">
                    <option value="none" selected>None</option>
                    <option value="odd">Odd</option>
                    <option value="even">Even</option>
                  </select>
                </div>
                <div class="form-group">
                  <label for="device-stop-bits">Stop bits</label>
                  <select id="device-stop-bits">
                    <option value="1" selected>1</option>
                    <option value="2">2</option>
                  </select>
                </div>
                <div class="form-group">
                  <label for="device-flow-control">Flow control</label>
                  <select id="device-flow-control">
                    <option value="none" selected>None</option>
                    <option value="software">Software (XON/XOFF)</option>
                    <option value="hardware">Hardware (RTS/CTS)</option>
                  </select>
                </div>
              </fieldset>
            </div>

            <div class="form-group form-group-checkbox">
              <label for="device-auto-reconnect">
                <input id="device-auto-reconnect" type="checkbox" />
                Auto-reconnect on unexpected disconnect
              </label>
            </div>

            <div class="form-actions">
              <button
                type="button"
                class="btn btn-secondary btn-test-connection"
              >
                Test connection
              </button>
              <button type="submit" class="btn btn-primary">Save</button>
              <button type="button" class="btn btn-secondary" data-close-dialog>
                Cancel
              </button>
            </div>
          </form>
        </div>
      </div>
    `;
}
