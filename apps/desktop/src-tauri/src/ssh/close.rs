//! Closing an SSH connection without waiting on a stuck server: russh's
//! disconnect only queues behind whatever the connection could not send yet.

use std::future::Future;
use std::time::Duration;

use russh::client;
use tokio::sync::watch;
use tokio::time::timeout;

use super::establish::JumpConnection;
use super::handler::SshHandler;

/// How long each goodbye (a channel close, the SSH disconnect of the target,
/// closing the jump host) may take before the connection is just dropped: a
/// stalled server must not hold up app quit (`disconnect_all` waits ~1 s).
pub(crate) const CLOSE_GRACE: Duration = Duration::from_millis(300);
/// How long closing a jump host waits for the target riding it to get its
/// own disconnect through first.
const TARGET_CLOSE_GRACE: Duration = Duration::from_millis(250);

/// Send the target, then the jump host, an SSH disconnect, so neither sees a
/// dropped socket; each hop within `CLOSE_GRACE`.
pub(super) async fn close_connection(
    handle: &client::Handle<SshHandler>,
    jump: Option<&JumpConnection>,
) {
    let goodbye = handle.disconnect(russh::Disconnect::ByApplication, "", "");
    let jump_goodbye = jump.map(|jump| {
        let goodbye = jump
            .handle
            .disconnect(russh::Disconnect::ByApplication, "", "");
        (jump.target_done.clone(), goodbye)
    });
    say_goodbyes(goodbye, jump_goodbye).await;
}

/// Say `goodbye` to the target, then to the jump host, if any, once the
/// target riding it is done.
async fn say_goodbyes(
    goodbye: impl Future,
    jump_goodbye: Option<(watch::Receiver<()>, impl Future)>,
) {
    let _ = timeout(CLOSE_GRACE, goodbye).await;
    let Some((target_done, jump_goodbye)) = jump_goodbye else {
        return;
    };
    close_after_target(target_done, jump_goodbye).await;
}

/// Close the jump host's connection once the target riding it is done, all
/// within one `CLOSE_GRACE`.
async fn close_after_target(mut target_done: watch::Receiver<()>, goodbye: impl Future) {
    let close = async {
        let _ = timeout(TARGET_CLOSE_GRACE, target_done.changed()).await;
        goodbye.await;
    };
    let _ = timeout(CLOSE_GRACE, close).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::{pending, Pending};
    use std::time::Instant;

    const MARGIN: Duration = Duration::from_millis(100);

    #[tokio::test]
    async fn a_stuck_target_and_jump_are_dropped_within_one_grace() {
        let (_target_running, target_done) = watch::channel(());
        let started = Instant::now();

        close_after_target(target_done, pending::<()>()).await;

        assert!(
            started.elapsed() < CLOSE_GRACE + MARGIN,
            "closing the jump took {:?}, past one CLOSE_GRACE: a jumped session \
             (channel, target, jump) must close within disconnect_all's ~1 s",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn the_jump_is_closed_as_soon_as_the_target_is_done() {
        let (target_running, target_done) = watch::channel(());
        drop(target_running);
        let started = Instant::now();
        let said_at = std::sync::Mutex::new(None);

        close_after_target(target_done, async {
            *said_at.lock().unwrap() = Some(Instant::now())
        })
        .await;

        let said_at = said_at.lock().unwrap().expect("the jump got its goodbye");
        assert!(said_at - started < TARGET_CLOSE_GRACE / 2);
    }

    #[tokio::test]
    async fn a_stuck_target_without_a_jump_is_dropped_after_one_grace() {
        let started = Instant::now();

        say_goodbyes(pending::<()>(), None::<(watch::Receiver<()>, Pending<()>)>).await;

        let took = started.elapsed();
        assert!(
            took >= CLOSE_GRACE && took < CLOSE_GRACE + MARGIN,
            "took {took:?}"
        );
    }

    #[tokio::test]
    async fn a_stuck_target_and_jump_are_dropped_after_one_grace_each() {
        let (_target_running, target_done) = watch::channel(());
        let started = Instant::now();

        say_goodbyes(pending::<()>(), Some((target_done, pending::<()>()))).await;

        let took = started.elapsed();
        let two_graces = 2 * CLOSE_GRACE;
        assert!(
            took >= two_graces && took < two_graces + MARGIN,
            "took {took:?}"
        );
    }
}
