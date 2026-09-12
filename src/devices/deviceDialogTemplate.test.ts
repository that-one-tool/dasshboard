/**
 * @vitest-environment happy-dom
 *
 * The device manager markup is queried by the controller and the form helpers
 * via a fixed set of ids/classes; these assert those anchors exist, so an
 * accidental rename/removal in the template fails here rather than as a runtime
 * "element not found" deep in a click handler.
 */
import { describe, it, expect } from "vitest";
import { deviceManagerMarkup } from "./deviceDialogTemplate";

describe("deviceManagerMarkup", () => {
  const root = document.createElement("div");
  root.innerHTML = deviceManagerMarkup();

  const requiredSelectors = [
    ".device-add-btn",
    ".device-export-btn",
    ".device-import-btn",
    ".device-list-items",
    "#device-dialog",
    "#device-form",
    "#device-dialog-title",
    "#device-kind",
    "#ssh-fields",
    "#serial-fields",
    "#device-name",
    "#device-host",
    "#device-port",
    "#device-username",
    "#device-secret",
    "#device-passphrase",
    "#device-key-path",
    "#device-forwards",
    "#device-tunnel-autostart",
    "#device-auto-reconnect",
    "#device-port-name",
    "#device-baud-rate",
    "#device-data-bits",
    "#device-parity",
    "#device-stop-bits",
    "#device-flow-control",
    ".btn-test-connection",
    'input[name="auth-method"][value="password"]',
    'input[name="auth-method"][value="key"]',
  ];

  for (const selector of requiredSelectors) {
    it(`contains ${selector}`, () => {
      expect(root.querySelector(selector)).not.toBeNull();
    });
  }

  it("hides the serial field group by default", () => {
    expect(
      root.querySelector("#serial-fields")?.classList.contains("device-kind-hidden"),
    ).toBe(true);
  });
});
