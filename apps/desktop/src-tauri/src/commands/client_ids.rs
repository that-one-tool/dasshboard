//! Session and tunnel ids, chosen by the frontend.

use uuid::Uuid;

use crate::error::AppError;
use crate::state::AppState;

/// Validate a session/tunnel id chosen by the frontend. The frontend picks it
/// (rather than receiving it from the command) so its status listener knows the
/// id before the first event — which can be emitted before the command returns.
///
/// A reused id is refused: the registries key their maps by it, so a second
/// spawn would replace the live entry and cut that session off.
pub(super) fn client_chosen_id(
    id: String,
    in_use: impl Fn(&str) -> bool,
) -> Result<String, AppError> {
    if Uuid::parse_str(&id).is_err() {
        return Err(AppError::Validation(
            "session id must be a UUID".to_string(),
        ));
    }
    if in_use(&id) {
        return Err(AppError::Validation(
            "session id is already in use".to_string(),
        ));
    }
    Ok(id)
}

/// Whether any session or tunnel manager already tracks `id`.
pub(super) fn id_in_use(state: &AppState, id: &str) -> bool {
    state.sessions.owns(id) || state.tunnel_manager.owns(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::*;
    use crate::session_registry::NewSession;
    use crate::session_sink::testing::RecordingSink;
    use crate::session_sink::SessionStatus;
    use std::sync::Arc;
    use tempfile::tempdir;

    #[test]
    fn client_chosen_id_accepts_a_fresh_uuid_and_rejects_anything_else() {
        let id = Uuid::new_v4().to_string();
        assert_eq!(client_chosen_id(id.clone(), |_| false).unwrap(), id);
        assert!(matches!(
            client_chosen_id("s1".to_string(), |_| false),
            Err(AppError::Validation(_))
        ));
    }

    #[test]
    fn client_chosen_id_rejects_an_id_already_in_use() {
        let id = Uuid::new_v4().to_string();
        let err = client_chosen_id(id.clone(), |candidate| candidate == id).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn a_fresh_state_tracks_no_ids() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        assert!(!id_in_use(&state, &Uuid::new_v4().to_string()));
    }

    #[tokio::test]
    async fn an_id_held_by_a_session_in_the_registry_is_in_use() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let id = Uuid::new_v4().to_string();
        let session = NewSession {
            id: id.clone(),
            sink: Arc::new(RecordingSink::default()),
        };
        state.sessions.spawn(session, |_controls, _sink| {
            std::future::pending::<Result<SessionStatus, AppError>>()
        });

        assert!(id_in_use(&state, &id));
    }
}
