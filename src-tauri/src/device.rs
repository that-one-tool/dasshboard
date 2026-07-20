//! The `Device` model (SPEC.md §4) and its validation rules.

use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// A saved device. Never carries secret material — passwords/passphrases
/// live in the OS keyring, keyed by `id` (see `crate::secret`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    /// UUIDv4 string. Empty string on input means "not yet assigned" —
    /// `DeviceStore::upsert` generates a fresh id in that case.
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: Auth,
    /// Reconnect automatically on an *unexpected* drop (Phase 5), off by
    /// default. `#[serde(default)]` keeps devices.json written before this field
    /// existed loadable (they read back as `false`).
    #[serde(default)]
    pub auto_reconnect: bool,
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
    /// Validation rules from PLAN.md Phase 1 task 4: non-empty
    /// name/host/username, port in 1..=65535, and `key` auth requires a
    /// non-empty `keyPath`. `port` is already type-bounded to `u16` (max
    /// 65535), so only the lower bound needs an explicit check.
    pub fn validate(&self) -> Result<(), AppError> {
        if self.name.trim().is_empty() {
            return Err(AppError::Validation("name must not be empty".to_string()));
        }
        if self.host.trim().is_empty() {
            return Err(AppError::Validation("host must not be empty".to_string()));
        }
        if self.username.trim().is_empty() {
            return Err(AppError::Validation(
                "username must not be empty".to_string(),
            ));
        }
        if self.port == 0 {
            return Err(AppError::Validation(
                "port must be between 1 and 65535".to_string(),
            ));
        }
        if let Auth::Key { key_path } = &self.auth {
            if key_path.trim().is_empty() {
                return Err(AppError::Validation(
                    "keyPath must not be empty for key auth".to_string(),
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_password_device() -> Device {
        Device {
            id: "11111111-1111-4111-8111-111111111111".to_string(),
            name: "NAS".to_string(),
            host: "192.168.1.10".to_string(),
            port: 22,
            username: "admin".to_string(),
            auth: Auth::Password,
            auto_reconnect: false,
        }
    }

    fn valid_key_device() -> Device {
        Device {
            auth: Auth::Key {
                key_path: "C:/Users/x/.ssh/id_ed25519".to_string(),
            },
            ..valid_password_device()
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
                "host": "192.168.1.10",
                "port": 22,
                "username": "admin",
                "auth": { "method": "password" },
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
        for device in [valid_password_device(), valid_key_device()] {
            let json = serde_json::to_string(&device).expect("serialize");
            let back: Device = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(device, back);
        }
    }

    #[test]
    fn accepts_a_fully_populated_valid_device() {
        assert!(valid_password_device().validate().is_ok());
        assert!(valid_key_device().validate().is_ok());
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
            host: String::new(),
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
            username: String::new(),
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
            port: 0,
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
            port: 65535,
            ..valid_password_device()
        };
        assert!(device.validate().is_ok());
    }

    #[test]
    fn rejects_key_auth_with_empty_key_path() {
        let device = Device {
            auth: Auth::Key {
                key_path: "   ".to_string(),
            },
            ..valid_password_device()
        };
        assert!(matches!(
            device.validate().unwrap_err(),
            AppError::Validation(_)
        ));
    }
}
