//! The prompts a connection may raise while it is established — host-key
//! trust and keyboard-interactive authentication — their event payloads, and
//! the registries of prompts awaiting the user's answer.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tokio::sync::oneshot;
use zeroize::Zeroizing;

/// Payload of the `host_key_prompt` event (SPEC.md §5). `camelCase` on the
/// wire. Carries no secret material.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyPromptPayload {
    pub prompt_id: String,
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub changed: bool,
    /// No record to compare with because the trusted hosts were reset after
    /// a damaged file: the key may have changed (see `Verdict::Unverifiable`).
    pub trust_reset: bool,
}

/// Payload of the `auth_prompt` event: one keyboard-interactive round. The
/// texts are the server's own, so the frontend shows them as plain text.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthPromptPayload {
    pub prompt_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub name: String,
    pub instructions: String,
    pub fields: Vec<AuthPromptField>,
}

/// One answer the server asks for; `echo: false` is a hidden input.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthPromptField {
    pub label: String,
    pub echo: bool,
}

/// The user's answers to an auth prompt, one per field; `None` = cancelled.
pub type AuthAnswers = Option<Zeroizing<Vec<String>>>;

/// Where a handshake's prompts go — the only thing a connection surfaces to
/// the frontend while it is established. Object-safe
/// (`Arc<dyn ConnectPrompter>`); the shell and tunnel sinks extend it, and an
/// SFTP connection needs nothing more.
pub trait ConnectPrompter: Send + Sync {
    /// An unknown/changed host key needs the user's decision →
    /// `host_key_prompt` event.
    fn on_host_key_prompt(&self, payload: HostKeyPromptPayload);
    /// The backend stopped waiting on a prompt (answered, timed out, or its
    /// connection was torn down) → `host_key_prompt_closed` event, so the
    /// dialog can drop a prompt that can no longer be answered.
    fn on_host_key_prompt_closed(&self, _prompt_id: &str) {}
    /// The server asks the user something (a 2FA code…) → `auth_prompt` event.
    fn on_auth_prompt(&self, payload: AuthPromptPayload);
    /// Like `on_host_key_prompt_closed`, for an auth prompt.
    fn on_auth_prompt_closed(&self, _prompt_id: &str) {}
}

/// Registry of in-flight prompts: `promptId -> oneshot::Sender`. Shared (via
/// `Arc`) between the connecting tasks (which register + await) and the
/// `respond_*` commands (which resolve).
pub struct PromptRegistry<T> {
    pending: Mutex<HashMap<String, oneshot::Sender<T>>>,
}

impl<T> Default for PromptRegistry<T> {
    fn default() -> Self {
        PromptRegistry {
            pending: Mutex::new(HashMap::new()),
        }
    }
}

/// A manager's prompt registries, answered by the `respond_host_key` and
/// `respond_auth_prompt` commands; `auth_on_screen` hears from
/// `auth_prompt_shown` when the dialog shows an auth prompt.
#[derive(Default)]
pub struct ConnectPrompts {
    pub(super) host_keys: Arc<PromptRegistry<bool>>,
    pub(super) auth: Arc<PromptRegistry<AuthAnswers>>,
    pub(super) auth_on_screen: Arc<PromptRegistry<()>>,
}

impl ConnectPrompts {
    /// Resolve a pending host-key prompt; `false` if none had that id.
    pub fn respond_host_key(&self, prompt_id: &str, accept: bool) -> bool {
        self.host_keys.respond(prompt_id, accept)
    }

    /// Resolve a pending auth prompt; `false` if none had that id.
    pub fn respond_auth(&self, prompt_id: &str, answers: AuthAnswers) -> bool {
        self.auth.respond(prompt_id, answers)
    }

    /// The dialog shows an auth prompt: its answer time starts; `false` if
    /// none had that id.
    pub fn mark_auth_shown(&self, prompt_id: &str) -> bool {
        self.auth_on_screen.respond(prompt_id, ())
    }
}

/// RAII cleanup for a registered prompt. Removing on drop guarantees the
/// registry entry never outlives the awaiting task, no matter how that task
/// ends (reply, timeout, or being dropped mid-prompt when the session is torn
/// down). Removing an already-resolved entry is a harmless no-op.
pub(super) struct PromptGuard<T> {
    registry: Arc<PromptRegistry<T>>,
    prompt_id: String,
}

impl<T> Drop for PromptGuard<T> {
    fn drop(&mut self) {
        self.registry.remove(&self.prompt_id);
    }
}

#[derive(Clone, Copy)]
enum PromptKind {
    HostKey,
    Auth,
}

/// Announces a prompt as closed when dropped — on every exit path of the wait,
/// including the handshake future being dropped mid-prompt.
pub(super) struct PromptClosedNotice {
    prompter: Arc<dyn ConnectPrompter>,
    prompt_id: String,
    kind: PromptKind,
}

impl PromptClosedNotice {
    pub(super) fn host_key(prompter: Arc<dyn ConnectPrompter>, prompt_id: String) -> Self {
        PromptClosedNotice {
            prompter,
            prompt_id,
            kind: PromptKind::HostKey,
        }
    }

    pub(super) fn auth(prompter: Arc<dyn ConnectPrompter>, prompt_id: String) -> Self {
        PromptClosedNotice {
            prompter,
            prompt_id,
            kind: PromptKind::Auth,
        }
    }
}

impl Drop for PromptClosedNotice {
    fn drop(&mut self) {
        match self.kind {
            PromptKind::HostKey => self.prompter.on_host_key_prompt_closed(&self.prompt_id),
            PromptKind::Auth => self.prompter.on_auth_prompt_closed(&self.prompt_id),
        }
    }
}

impl<T> PromptRegistry<T> {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, oneshot::Sender<T>>> {
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Register a prompt, returning the receiver to await and a guard that
    /// cleans up the entry on drop. Locks only to insert; never across await.
    pub(super) fn register(
        self: &Arc<Self>,
        prompt_id: String,
    ) -> (oneshot::Receiver<T>, PromptGuard<T>) {
        let (tx, rx) = oneshot::channel();
        self.lock().insert(prompt_id.clone(), tx);
        let guard = PromptGuard {
            registry: Arc::clone(self),
            prompt_id,
        };
        (rx, guard)
    }

    /// Resolve a pending prompt. Returns `true` if a prompt with that id was
    /// waiting (so the command can distinguish a stale/duplicate response).
    pub fn respond(&self, prompt_id: &str, answer: T) -> bool {
        let Some(tx) = self.lock().remove(prompt_id) else {
            return false;
        };
        // Err only if the awaiting task already went away — harmless.
        let _ = tx.send(answer);
        true
    }

    fn remove(&self, prompt_id: &str) {
        self.lock().remove(prompt_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_key_prompt_payload_is_camel_case() {
        let payload = HostKeyPromptPayload {
            prompt_id: "p1".into(),
            host: "h".into(),
            port: 22,
            key_type: "ssh-ed25519".into(),
            fingerprint: "SHA256:abc".into(),
            changed: true,
            trust_reset: false,
        };
        let value = serde_json::to_value(&payload).unwrap();
        assert_eq!(value["promptId"], "p1");
        assert_eq!(value["keyType"], "ssh-ed25519");
        assert_eq!(value["fingerprint"], "SHA256:abc");
        assert_eq!(value["changed"], true);
        assert_eq!(value["trustReset"], false);
    }

    #[test]
    fn auth_prompt_payload_is_camel_case() {
        let payload = AuthPromptPayload {
            prompt_id: "p1".into(),
            host: "h".into(),
            port: 22,
            username: "u".into(),
            name: "n".into(),
            instructions: "i".into(),
            fields: vec![AuthPromptField {
                label: "Code:".into(),
                echo: false,
            }],
        };
        let value = serde_json::to_value(&payload).unwrap();
        assert_eq!(value["promptId"], "p1");
        assert_eq!(value["fields"][0]["label"], "Code:");
        assert_eq!(value["fields"][0]["echo"], false);
    }

    /// Records which prompts were announced closed, by kind.
    #[derive(Default)]
    struct ClosedPrompts(Mutex<Vec<String>>);

    impl ConnectPrompter for ClosedPrompts {
        fn on_host_key_prompt(&self, _payload: HostKeyPromptPayload) {}
        fn on_host_key_prompt_closed(&self, prompt_id: &str) {
            self.0.lock().unwrap().push(format!("host:{prompt_id}"));
        }
        fn on_auth_prompt(&self, _payload: AuthPromptPayload) {}
        fn on_auth_prompt_closed(&self, prompt_id: &str) {
            self.0.lock().unwrap().push(format!("auth:{prompt_id}"));
        }
    }

    #[test]
    fn a_dropped_prompt_notice_announces_its_own_kind() {
        let prompter = Arc::new(ClosedPrompts::default());
        drop(PromptClosedNotice::host_key(
            Arc::clone(&prompter) as Arc<dyn ConnectPrompter>,
            "p1".into(),
        ));
        drop(PromptClosedNotice::auth(
            Arc::clone(&prompter) as Arc<dyn ConnectPrompter>,
            "p2".into(),
        ));
        assert_eq!(*prompter.0.lock().unwrap(), vec!["host:p1", "auth:p2"]);
    }

    #[test]
    fn prompt_registry_respond_resolves_receiver() {
        let registry = Arc::new(PromptRegistry::<bool>::default());
        let (rx, _guard) = registry.register("p1".into());
        assert!(registry.respond("p1", true));
        assert_eq!(rx.blocking_recv().ok(), Some(true));
        // A second response finds nothing pending.
        assert!(!registry.respond("p1", true));
    }

    #[test]
    fn prompt_guard_removes_entry_on_drop() {
        let registry = Arc::new(PromptRegistry::<bool>::default());
        {
            let (_rx, _guard) = registry.register("p1".into());
            assert_eq!(registry.lock().len(), 1);
        }
        assert_eq!(registry.lock().len(), 0, "guard must clean up on drop");
    }

    #[test]
    fn respond_to_unknown_prompt_is_false() {
        let registry = Arc::new(PromptRegistry::<bool>::default());
        assert!(!registry.respond("nope", true));
    }

    #[test]
    fn connect_prompts_route_each_answer_to_its_own_registry() {
        let prompts = ConnectPrompts::default();
        let (host_rx, _host_guard) = prompts.host_keys.register("h1".into());
        let (auth_rx, _auth_guard) = prompts.auth.register("a1".into());

        assert!(
            !prompts.respond_auth("h1", None),
            "a host-key id is no auth prompt"
        );
        assert!(prompts.respond_host_key("h1", true));
        assert!(prompts.respond_auth("a1", Some(Zeroizing::new(vec!["123456".into()]))));

        let (shown_rx, _shown_guard) = prompts.auth_on_screen.register("a1".into());
        assert!(prompts.mark_auth_shown("a1"));
        assert!(!prompts.mark_auth_shown("h1"));
        assert_eq!(shown_rx.blocking_recv().ok(), Some(()));

        assert_eq!(host_rx.blocking_recv().ok(), Some(true));
        let answers = auth_rx.blocking_recv().unwrap().unwrap();
        assert_eq!(answers.as_slice(), ["123456".to_string()]);
    }
}
