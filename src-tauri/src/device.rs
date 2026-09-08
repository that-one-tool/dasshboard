//! The `Device` model (SPEC.md §4) and its validation rules.
//!
//! A device is one of two connection kinds, discriminated on the wire by a
//! `kind` field flattened onto the device object (`"ssh"` / `"serial"`):
//! - **SSH** — the original target: `host`, `port`, `username`, `auth`.
//! - **Serial/COM** — a local serial port: `portName`, `baudRate`, plus the
//!   standard framing params (`dataBits`, `parity`, `stopBits`, `flowControl`).
//!   A serial device has NO host/username/auth and NO keyring secret.
//!
//! Backward compatibility: a `devices.json` written before serial support (and
//! therefore carrying no `kind`) still loads — `kind` defaults to `"ssh"`, so a
//! legacy record deserializes as an SSH device unchanged (mirrors the
//! `auto_reconnect` `#[serde(default)]` pattern). An older app reading a newer
//! file simply ignores the unknown `kind` field (serde does not deny unknown
//! fields), so the format round-trips in both directions.

use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// A saved device. Never carries secret material — passwords/passphrases live
/// in the OS keyring, keyed by `id` (see `crate::secret`); serial devices have
/// no secret at all.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    /// UUIDv4 string. Empty string on input means "not yet assigned" —
    /// `DeviceStore::upsert` generates a fresh id in that case.
    pub id: String,
    pub name: String,
    /// The connection kind + its kind-specific parameters, flattened onto the
    /// device object so `kind`/`host`/`portName`/… sit at the top level (the
    /// wire shape SSH records have always had).
    #[serde(flatten)]
    pub connection: Connection,
    /// Reconnect automatically on an *unexpected* drop (Phase 5), off by
    /// default. `#[serde(default)]` keeps devices.json written before this field
    /// existed loadable (they read back as `false`).
    #[serde(default)]
    pub auto_reconnect: bool,
}

/// The connection kind and its parameters. Internally tagged by `kind`
/// (`"ssh"` / `"serial"`) so it flattens cleanly onto `Device`.
///
/// `Serialize` is derived (emits the `kind` tag); `Deserialize` is hand-written
/// (see the impl below) so a missing `kind` defaults to `Ssh` for legacy
/// records — serde's derived internally-tagged deserializer would instead
/// reject a record with no tag.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Connection {
    #[serde(rename_all = "camelCase")]
    Ssh {
        host: String,
        port: u16,
        username: String,
        auth: Auth,
    },
    #[serde(rename_all = "camelCase")]
    Serial {
        port_name: String,
        baud_rate: u32,
        data_bits: u8,
        parity: Parity,
        stop_bits: u8,
        flow_control: FlowControl,
    },
}

/// Serial parity bit (default `None`). Serializes to `"none"`/`"odd"`/`"even"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Parity {
    #[default]
    None,
    Odd,
    Even,
}

/// Serial flow control (default `None`). Serializes to
/// `"none"`/`"software"`/`"hardware"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum FlowControl {
    #[default]
    None,
    Software,
    Hardware,
}

/// Default serial framing: 8 data bits, 1 stop bit — the near-universal 8-N-1
/// so a minimal serial device only needs `portName` + `baudRate`.
fn default_data_bits() -> u8 {
    8
}
fn default_stop_bits() -> u8 {
    1
}

/// The connection-kind tag as it appears (or defaults) on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
enum DeviceKind {
    #[default]
    Ssh,
    Serial,
}

/// Flat, all-optional view of a `Connection` used only for deserialization: it
/// lets `kind` default to `Ssh` (legacy records) and then dispatches to the
/// matching variant, reporting a missing required field per kind. Framing
/// params carry their SPEC defaults so a serial record needs only
/// `portName`/`baudRate`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionRaw {
    #[serde(default)]
    kind: DeviceKind,
    host: Option<String>,
    port: Option<u16>,
    username: Option<String>,
    auth: Option<Auth>,
    port_name: Option<String>,
    baud_rate: Option<u32>,
    #[serde(default = "default_data_bits")]
    data_bits: u8,
    #[serde(default)]
    parity: Parity,
    #[serde(default = "default_stop_bits")]
    stop_bits: u8,
    #[serde(default)]
    flow_control: FlowControl,
}

impl ConnectionRaw {
    /// Build the SSH variant, erroring (with the missing field's wire name) if
    /// a required SSH field is absent — preserving the strictness the derived
    /// SSH deserializer had before serial support existed.
    fn into_ssh(self) -> Result<Connection, &'static str> {
        Ok(Connection::Ssh {
            host: self.host.ok_or("host")?,
            port: self.port.ok_or("port")?,
            username: self.username.ok_or("username")?,
            auth: self.auth.ok_or("auth")?,
        })
    }

    /// Build the serial variant, erroring if `portName`/`baudRate` are absent.
    fn into_serial(self) -> Result<Connection, &'static str> {
        Ok(Connection::Serial {
            port_name: self.port_name.ok_or("portName")?,
            baud_rate: self.baud_rate.ok_or("baudRate")?,
            data_bits: self.data_bits,
            parity: self.parity,
            stop_bits: self.stop_bits,
            flow_control: self.flow_control,
        })
    }
}

impl<'de> Deserialize<'de> for Connection {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = ConnectionRaw::deserialize(deserializer)?;
        let built = match raw.kind {
            DeviceKind::Ssh => raw.into_ssh(),
            DeviceKind::Serial => raw.into_serial(),
        };
        built.map_err(<D::Error as serde::de::Error>::missing_field)
    }
}

/// Tagged on the wire by `method`: `{ "method": "password" }` or
/// `{ "method": "key", "keyPath": "..." }` (SPEC.md §4).
///
/// Note: serde's container-level `rename_all` only renames variant names,
/// not the fields of struct variants — each struct variant needs its own
/// `rename_all` (or per-field `rename`) to get `keyPath` instead of
/// `key_path`. Caught by `wire_format_matches_spec_key_example` below.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "camelCase")]
pub enum Auth {
    Password,
    #[serde(rename_all = "camelCase")]
    Key {
        key_path: String,
    },
}

impl Auth {
    /// The wire-level `method` discriminant (`"password"` / `"key"`). Used by
    /// `save_device` to detect an auth-method change so a now-meaningless
    /// secret (a password kept as if it were a key passphrase, or vice versa)
    /// is not left stranded in the keyring (SPEC.md §4/§5).
    pub fn method_name(&self) -> &'static str {
        match self {
            Auth::Password => "password",
            Auth::Key { .. } => "key",
        }
    }
}

impl Device {
    /// The keyring "slot" identity for this device: the SSH auth method
    /// (`"password"`/`"key"`) or `"serial"` for a serial device (which never
    /// stores a secret). `save_device` compares the previous vs incoming value
    /// to clear a now-stale secret when the kind/method changes.
    pub fn secret_method(&self) -> &'static str {
        match &self.connection {
            Connection::Ssh { auth, .. } => auth.method_name(),
            Connection::Serial { .. } => "serial",
        }
    }

    /// True when this device stores no secret at all — serial devices, always.
    /// SSH devices may or may not have a secret; that is the keyring's concern.
    pub fn is_serial(&self) -> bool {
        matches!(self.connection, Connection::Serial { .. })
    }

    /// Validation rules (SPEC.md §4). Common: non-empty `name`. SSH: non-empty
    /// host/username, port in 1..=65535, and `key` auth requires a non-empty
    /// `keyPath`. Serial: non-empty `portName`, `baudRate` > 0. `port` is
    /// type-bounded to `u16`, so only its lower bound needs a check.
    pub fn validate(&self) -> Result<(), AppError> {
        require_non_empty(&self.name, "name must not be empty")?;
        match &self.connection {
            Connection::Ssh {
                host,
                port,
                username,
                auth,
            } => validate_ssh(host, *port, username, auth),
            Connection::Serial {
                port_name,
                baud_rate,
                ..
            } => validate_serial(port_name, *baud_rate),
        }
    }
}

/// SSH validation: non-empty host/username, a non-zero port, and (for `key`
/// auth) a non-empty `keyPath`. The secret itself lives in the keyring.
fn validate_ssh(host: &str, port: u16, username: &str, auth: &Auth) -> Result<(), AppError> {
    require_non_empty(host, "host must not be empty")?;
    require_non_empty(username, "username must not be empty")?;
    if port == 0 {
        return Err(AppError::Validation(
            "port must be between 1 and 65535".to_string(),
        ));
    }
    if let Auth::Key { key_path } = auth {
        require_non_empty(key_path, "keyPath must not be empty for key auth")?;
    }
    Ok(())
}

/// Serial validation: non-empty `portName` and a non-zero `baudRate`.
fn validate_serial(port_name: &str, baud_rate: u32) -> Result<(), AppError> {
    require_non_empty(port_name, "portName must not be empty")?;
    if baud_rate == 0 {
        return Err(AppError::Validation(
            "baudRate must be greater than 0".to_string(),
        ));
    }
    Ok(())
}

/// Returns `AppError::Validation(message)` if `value` is empty once trimmed.
fn require_non_empty(value: &str, message: &str) -> Result<(), AppError> {
    if value.trim().is_empty() {
        return Err(AppError::Validation(message.to_string()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_password_device() -> Device {
        Device {
            id: "11111111-1111-4111-8111-111111111111".to_string(),
            name: "NAS".to_string(),
            connection: Connection::Ssh {
                host: "192.168.1.10".to_string(),
                port: 22,
                username: "admin".to_string(),
                auth: Auth::Password,
            },
            auto_reconnect: false,
        }
    }

    fn valid_key_device() -> Device {
        Device {
            connection: Connection::Ssh {
                host: "192.168.1.10".to_string(),
                port: 22,
                username: "admin".to_string(),
                auth: Auth::Key {
                    key_path: "C:/Users/x/.ssh/id_ed25519".to_string(),
                },
            },
            ..valid_password_device()
        }
    }

    fn valid_serial_device() -> Device {
        Device {
            id: "22222222-2222-4222-8222-222222222222".to_string(),
            name: "Arduino".to_string(),
            connection: Connection::Serial {
                port_name: "COM3".to_string(),
                baud_rate: 115200,
                data_bits: 8,
                parity: Parity::None,
                stop_bits: 1,
                flow_control: FlowControl::None,
            },
            auto_reconnect: false,
        }
    }

    #[test]
    fn wire_format_matches_spec_password_example() {
        let device = valid_password_device();
        let value = serde_json::to_value(&device).expect("serialize");
        assert_eq!(
            value,
            serde_json::json!({
                "id": "11111111-1111-4111-8111-111111111111",
                "name": "NAS",
                "kind": "ssh",
                "host": "192.168.1.10",
                "port": 22,
                "username": "admin",
                "auth": { "method": "password" },
                "autoReconnect": false,
            })
        );
    }

    #[test]
    fn wire_format_matches_spec_serial_example() {
        let device = valid_serial_device();
        let value = serde_json::to_value(&device).expect("serialize");
        assert_eq!(
            value,
            serde_json::json!({
                "id": "22222222-2222-4222-8222-222222222222",
                "name": "Arduino",
                "kind": "serial",
                "portName": "COM3",
                "baudRate": 115200,
                "dataBits": 8,
                "parity": "none",
                "stopBits": 1,
                "flowControl": "none",
                "autoReconnect": false,
            })
        );
    }

    #[test]
    fn auto_reconnect_round_trips_and_defaults_to_false_when_absent() {
        // Present + true survives a round trip.
        let device = Device {
            auto_reconnect: true,
            ..valid_password_device()
        };
        let json = serde_json::to_string(&device).unwrap();
        assert!(json.contains("\"autoReconnect\":true"));
        let back: Device = serde_json::from_str(&json).unwrap();
        assert!(back.auto_reconnect);

        // A devices.json written before the field existed still loads (→ false).
        let legacy = r#"{ "id": "x", "name": "n", "host": "h", "port": 22, "username": "u", "auth": { "method": "password" } }"#;
        let parsed: Device = serde_json::from_str(legacy).unwrap();
        assert!(!parsed.auto_reconnect);
    }

    #[test]
    fn legacy_record_without_kind_loads_as_ssh() {
        // A pre-serial devices.json record carries no `kind`; it must still load
        // as an SSH device unchanged (kind defaults to "ssh").
        let legacy = r#"{ "id": "x", "name": "NAS", "host": "192.168.1.10", "port": 22, "username": "admin", "auth": { "method": "password" }, "autoReconnect": true }"#;
        let parsed: Device = serde_json::from_str(legacy).unwrap();
        assert_eq!(
            parsed.connection,
            Connection::Ssh {
                host: "192.168.1.10".to_string(),
                port: 22,
                username: "admin".to_string(),
                auth: Auth::Password,
            }
        );
        assert!(parsed.auto_reconnect);
    }

    #[test]
    fn serial_record_loads_with_framing_defaults() {
        // A minimal serial record (only portName + baudRate) fills in 8-N-1.
        let minimal = r#"{ "id": "s1", "name": "Arduino", "kind": "serial", "portName": "/dev/ttyUSB0", "baudRate": 9600 }"#;
        let parsed: Device = serde_json::from_str(minimal).unwrap();
        assert_eq!(
            parsed.connection,
            Connection::Serial {
                port_name: "/dev/ttyUSB0".to_string(),
                baud_rate: 9600,
                data_bits: 8,
                parity: Parity::None,
                stop_bits: 1,
                flow_control: FlowControl::None,
            }
        );
    }

    #[test]
    fn wire_format_matches_spec_key_example() {
        let device = valid_key_device();
        let value = serde_json::to_value(&device).expect("serialize");
        assert_eq!(
            value["auth"],
            serde_json::json!({ "method": "key", "keyPath": "C:/Users/x/.ssh/id_ed25519" })
        );
    }

    #[test]
    fn round_trips_through_json() {
        for device in [
            valid_password_device(),
            valid_key_device(),
            valid_serial_device(),
        ] {
            let json = serde_json::to_string(&device).expect("serialize");
            let back: Device = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(device, back);
        }
    }

    #[test]
    fn accepts_a_fully_populated_valid_device() {
        assert!(valid_password_device().validate().is_ok());
        assert!(valid_key_device().validate().is_ok());
        assert!(valid_serial_device().validate().is_ok());
    }

    #[test]
    fn secret_method_reflects_kind_and_auth() {
        assert_eq!(valid_password_device().secret_method(), "password");
        assert_eq!(valid_key_device().secret_method(), "key");
        assert_eq!(valid_serial_device().secret_method(), "serial");
        assert!(valid_serial_device().is_serial());
        assert!(!valid_password_device().is_serial());
    }

    #[test]
    fn rejects_empty_name() {
        let device = Device {
            name: "  ".to_string(),
            ..valid_password_device()
        };
        let err = device.validate().unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn rejects_empty_host() {
        let device = Device {
            connection: Connection::Ssh {
                host: String::new(),
                port: 22,
                username: "admin".to_string(),
                auth: Auth::Password,
            },
            ..valid_password_device()
        };
        assert!(matches!(
            device.validate().unwrap_err(),
            AppError::Validation(_)
        ));
    }

    #[test]
    fn rejects_empty_username() {
        let device = Device {
            connection: Connection::Ssh {
                host: "192.168.1.10".to_string(),
                port: 22,
                username: String::new(),
                auth: Auth::Password,
            },
            ..valid_password_device()
        };
        assert!(matches!(
            device.validate().unwrap_err(),
            AppError::Validation(_)
        ));
    }

    #[test]
    fn rejects_zero_port() {
        let device = Device {
            connection: Connection::Ssh {
                host: "192.168.1.10".to_string(),
                port: 0,
                username: "admin".to_string(),
                auth: Auth::Password,
            },
            ..valid_password_device()
        };
        assert!(matches!(
            device.validate().unwrap_err(),
            AppError::Validation(_)
        ));
    }

    #[test]
    fn accepts_max_port() {
        let device = Device {
            connection: Connection::Ssh {
                host: "192.168.1.10".to_string(),
                port: 65535,
                username: "admin".to_string(),
                auth: Auth::Password,
            },
            ..valid_password_device()
        };
        assert!(device.validate().is_ok());
    }

    #[test]
    fn rejects_key_auth_with_empty_key_path() {
        let device = Device {
            connection: Connection::Ssh {
                host: "192.168.1.10".to_string(),
                port: 22,
                username: "admin".to_string(),
                auth: Auth::Key {
                    key_path: "   ".to_string(),
                },
            },
            ..valid_password_device()
        };
        assert!(matches!(
            device.validate().unwrap_err(),
            AppError::Validation(_)
        ));
    }

    #[test]
    fn rejects_serial_with_empty_port_name() {
        let device = Device {
            connection: Connection::Serial {
                port_name: "  ".to_string(),
                baud_rate: 9600,
                data_bits: 8,
                parity: Parity::None,
                stop_bits: 1,
                flow_control: FlowControl::None,
            },
            ..valid_serial_device()
        };
        assert!(matches!(
            device.validate().unwrap_err(),
            AppError::Validation(_)
        ));
    }

    #[test]
    fn rejects_serial_with_zero_baud_rate() {
        let device = Device {
            connection: Connection::Serial {
                port_name: "COM3".to_string(),
                baud_rate: 0,
                data_bits: 8,
                parity: Parity::None,
                stop_bits: 1,
                flow_control: FlowControl::None,
            },
            ..valid_serial_device()
        };
        assert!(matches!(
            device.validate().unwrap_err(),
            AppError::Validation(_)
        ));
    }
}
