import { describe, it, expect } from "vitest";
import {
  validateDevice,
  hasFieldError,
  getFieldError,
  type DeviceFormValues,
} from "./validation";

describe("validateDevice", () => {
  it("accepts a valid password device", () => {
    const device: DeviceFormValues = {
      name: "Test Device",
      host: "192.168.1.1",
      port: 22,
      username: "user",
      auth: { method: "password" },
    };
    const errors = validateDevice(device);
    expect(errors).toHaveLength(0);
  });

  it("accepts a valid key device with keyPath", () => {
    const device: DeviceFormValues = {
      name: "Test Device",
      host: "192.168.1.1",
      port: 22,
      username: "user",
      auth: { method: "key", keyPath: "/home/user/.ssh/id_ed25519" },
    };
    const errors = validateDevice(device);
    expect(errors).toHaveLength(0);
  });

  it("rejects empty name", () => {
    const device: DeviceFormValues = {
      name: "",
      host: "192.168.1.1",
      port: 22,
      username: "user",
      auth: { method: "password" },
    };
    const errors = validateDevice(device);
    expect(errors.some((e) => e.field === "name")).toBe(true);
  });

  it("rejects whitespace-only name", () => {
    const device: DeviceFormValues = {
      name: "   ",
      host: "192.168.1.1",
      port: 22,
      username: "user",
      auth: { method: "password" },
    };
    const errors = validateDevice(device);
    expect(errors.some((e) => e.field === "name")).toBe(true);
  });

  it("rejects empty host", () => {
    const device: DeviceFormValues = {
      name: "Test",
      host: "",
      port: 22,
      username: "user",
      auth: { method: "password" },
    };
    const errors = validateDevice(device);
    expect(errors.some((e) => e.field === "host")).toBe(true);
  });

  it("rejects empty username", () => {
    const device: DeviceFormValues = {
      name: "Test",
      host: "192.168.1.1",
      port: 22,
      username: "",
      auth: { method: "password" },
    };
    const errors = validateDevice(device);
    expect(errors.some((e) => e.field === "username")).toBe(true);
  });

  describe("port validation", () => {
    it("accepts port 1", () => {
      const device: DeviceFormValues = {
        name: "Test",
        host: "192.168.1.1",
        port: 1,
        username: "user",
        auth: { method: "password" },
      };
      const errors = validateDevice(device);
      expect(errors.some((e) => e.field === "port")).toBe(false);
    });

    it("accepts port 65535", () => {
      const device: DeviceFormValues = {
        name: "Test",
        host: "192.168.1.1",
        port: 65535,
        username: "user",
        auth: { method: "password" },
      };
      const errors = validateDevice(device);
      expect(errors.some((e) => e.field === "port")).toBe(false);
    });

    it("rejects port 0", () => {
      const device: DeviceFormValues = {
        name: "Test",
        host: "192.168.1.1",
        port: 0,
        username: "user",
        auth: { method: "password" },
      };
      const errors = validateDevice(device);
      expect(errors.some((e) => e.field === "port")).toBe(true);
    });

    it("rejects port > 65535", () => {
      const device: DeviceFormValues = {
        name: "Test",
        host: "192.168.1.1",
        port: 65536,
        username: "user",
        auth: { method: "password" },
      };
      const errors = validateDevice(device);
      expect(errors.some((e) => e.field === "port")).toBe(true);
    });

    it("rejects negative port", () => {
      const device: DeviceFormValues = {
        name: "Test",
        host: "192.168.1.1",
        port: -1,
        username: "user",
        auth: { method: "password" },
      };
      const errors = validateDevice(device);
      expect(errors.some((e) => e.field === "port")).toBe(true);
    });

    it("rejects undefined port", () => {
      const device: DeviceFormValues = {
        name: "Test",
        host: "192.168.1.1",
        username: "user",
        auth: { method: "password" },
      };
      const errors = validateDevice(device);
      expect(errors.some((e) => e.field === "port")).toBe(true);
    });

    it("rejects non-integer port", () => {
      const device: DeviceFormValues = {
        name: "Test",
        host: "192.168.1.1",
        port: 22.5,
        username: "user",
        auth: { method: "password" } as const,
      };
      const errors = validateDevice(device);
      expect(errors.some((e) => e.field === "port")).toBe(true);
    });
  });

  describe("key auth validation", () => {
    it("rejects key device with empty keyPath", () => {
      const device: DeviceFormValues = {
        name: "Test",
        host: "192.168.1.1",
        port: 22,
        username: "user",
        auth: { method: "key", keyPath: "" },
      };
      const errors = validateDevice(device);
      expect(errors.some((e) => e.field === "keyPath")).toBe(true);
    });

    it("rejects key device with whitespace-only keyPath", () => {
      const device: DeviceFormValues = {
        name: "Test",
        host: "192.168.1.1",
        port: 22,
        username: "user",
        auth: { method: "key", keyPath: "   " },
      };
      const errors = validateDevice(device);
      expect(errors.some((e) => e.field === "keyPath")).toBe(true);
    });

    it("does not validate keyPath when method is password", () => {
      const device: DeviceFormValues = {
        name: "Test",
        host: "192.168.1.1",
        port: 22,
        username: "user",
        auth: { method: "password" },
      };
      const errors = validateDevice(device);
      expect(errors.some((e) => e.field === "keyPath")).toBe(false);
    });
  });

  describe("serial validation", () => {
    it("accepts a valid serial device (port + baud)", () => {
      const device: DeviceFormValues = {
        kind: "serial",
        name: "Arduino",
        portName: "COM3",
        baudRate: 115200,
      };
      expect(validateDevice(device)).toHaveLength(0);
    });

    it("rejects a serial device with an empty portName", () => {
      const device: DeviceFormValues = {
        kind: "serial",
        name: "Arduino",
        portName: "",
        baudRate: 9600,
      };
      const errors = validateDevice(device);
      expect(errors.some((e) => e.field === "portName")).toBe(true);
    });

    it("rejects a serial device with a zero baud rate", () => {
      const device: DeviceFormValues = {
        kind: "serial",
        name: "Arduino",
        portName: "COM3",
        baudRate: 0,
      };
      const errors = validateDevice(device);
      expect(errors.some((e) => e.field === "baudRate")).toBe(true);
    });

    it("does not require host/username/port for a serial device", () => {
      const device: DeviceFormValues = {
        kind: "serial",
        name: "Arduino",
        portName: "/dev/ttyUSB0",
        baudRate: 9600,
      };
      const errors = validateDevice(device);
      expect(errors.some((e) => e.field === "host")).toBe(false);
      expect(errors.some((e) => e.field === "port")).toBe(false);
      expect(errors.some((e) => e.field === "username")).toBe(false);
    });
  });

  describe("hasFieldError", () => {
    it("returns true if field has an error", () => {
      const errors = [{ field: "name", message: "Required" }];
      expect(hasFieldError(errors, "name")).toBe(true);
    });

    it("returns false if field has no error", () => {
      const errors = [{ field: "name", message: "Required" }];
      expect(hasFieldError(errors, "host")).toBe(false);
    });

    it("returns false for empty errors array", () => {
      const errors: typeof validateDevice.prototype[] = [];
      expect(hasFieldError(errors, "name")).toBe(false);
    });
  });

  describe("getFieldError", () => {
    it("returns error message for a field", () => {
      const errors = [
        { field: "name", message: "Name is required" },
        { field: "port", message: "Invalid port" },
      ];
      expect(getFieldError(errors, "name")).toBe("Name is required");
    });

    it("returns empty string if field has no error", () => {
      const errors = [{ field: "name", message: "Required" }];
      expect(getFieldError(errors, "host")).toBe("");
    });

    it("returns empty string for empty errors array", () => {
      const errors: typeof validateDevice.prototype[] = [];
      expect(getFieldError(errors, "name")).toBe("");
    });
  });
});
