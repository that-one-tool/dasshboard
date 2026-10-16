//! The host-key trust prompt: its event payload, and the registry of prompts
//! awaiting the user's answer.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tokio::sync::oneshot;

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

/// Where a handshake's host-key prompts go — the only thing `SshHandler`
/// surfaces to the frontend. Object-safe (`Arc<dyn HostKeyPrompter>`); the
/// shell and tunnel sinks extend it, and an SFTP connection needs nothing more.
pub trait HostKeyPrompter: Send + Sync {
    /// An unknown/changed host key needs the user's decision →
    /// `host_key_prompt` event.
    fn on_host_key_prompt(&self, payload: HostKeyPromptPayload);
    /// The backend stopped waiting on a prompt (answered, timed out, or its
    /// connection was torn down) → `host_key_prompt_closed` event, so the
    /// dialog can drop a prompt that can no longer be answered.
    fn on_host_key_prompt_closed(&self, _prompt_id: &str) {}
}

/// Registry of in-flight host-key prompts: `promptId -> oneshot::Sender`.
/// Shared (via `Arc`) between the session tasks (which register + await) and
/// the `respond_host_key` command (which resolves).
#[derive(Default)]
pub struct PromptRegistry {
    pending: Mutex<HashMap<String, oneshot::Sender<bool>>>,
}

/// RAII cleanup for a registered prompt. Removing on drop guarantees the
/// registry entry never outlives the awaiting task, no matter how that task
/// ends (reply, timeout, or being dropped mid-prompt when the session is torn
/// down). Removing an already-resolved entry is a harmless no-op.
pub(super) struct PromptGuard {
    registry: Arc<PromptRegistry>,
    prompt_id: String,
}

impl Drop for PromptGuard {
    fn drop(&mut self) {
        self.registry.remove(&self.prompt_id);
    }
}

/// Announces a prompt as closed when dropped — on every exit path of the wait,
/// including the handshake future being dropped mid-prompt.
pub(super) struct PromptClosedNotice {
    pub(super) prompter: Arc<dyn HostKeyPrompter>,
    pub(super) prompt_id: String,
}

impl Drop for PromptClosedNotice {
    fn drop(&mut self) {
        self.prompter.on_host_key_prompt_closed(&self.prompt_id);
    }
}

impl PromptRegistry {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, oneshot::Sender<bool>>> {
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Register a prompt, returning the receiver to await and a guard that
    /// cleans up the entry on drop. Locks only to insert; never across await.
    pub(super) fn register(
        self: &Arc<Self>,
        prompt_id: String,
    ) -> (oneshot::Receiver<bool>, PromptGuard) {
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
    pub fn respond(&self, prompt_id: &str, accept: bool) -> bool {
        let sender = self.lock().remove(prompt_id);
        match sender {
            Some(tx) => {
                // Err only if the awaiting task already went away — harmless.
                let _ = tx.send(accept);
                true
            }
            None => false,
        }
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

    /// A prompter that only knows about host-key prompts — all a handshake needs.
    #[derive(Default)]
    struct ClosedPrompts(Mutex<Vec<String>>);

    impl HostKeyPrompter for ClosedPrompts {
        fn on_host_key_prompt(&self, _payload: HostKeyPromptPayload) {}
        fn on_host_key_prompt_closed(&self, prompt_id: &str) {
            self.0.lock().unwrap().push(prompt_id.to_string());
        }
    }

    #[test]
    fn a_dropped_prompt_notice_tells_a_prompt_only_prompter() {
        let prompter = Arc::new(ClosedPrompts::default());
        drop(PromptClosedNotice {
            prompter: Arc::clone(&prompter) as Arc<dyn HostKeyPrompter>,
            prompt_id: "p1".into(),
        });
        assert_eq!(*prompter.0.lock().unwrap(), vec!["p1".to_string()]);
    }

    #[test]
    fn prompt_registry_respond_resolves_receiver() {
        let registry = Arc::new(PromptRegistry::default());
        let (rx, _guard) = registry.register("p1".into());
        assert!(registry.respond("p1", true));
        assert_eq!(rx.blocking_recv().ok(), Some(true));
        // A second response finds nothing pending.
        assert!(!registry.respond("p1", true));
    }

    #[test]
    fn prompt_guard_removes_entry_on_drop() {
        let registry = Arc::new(PromptRegistry::default());
        {
            let (_rx, _guard) = registry.register("p1".into());
            assert_eq!(registry.lock().len(), 1);
        }
        assert_eq!(registry.lock().len(), 0, "guard must clean up on drop");
    }

    #[test]
    fn respond_to_unknown_prompt_is_false() {
        let registry = Arc::new(PromptRegistry::default());
        assert!(!registry.respond("nope", true));
    }
}
