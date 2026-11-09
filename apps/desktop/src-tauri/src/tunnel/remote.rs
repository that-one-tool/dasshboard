//! Remote forwards (`ssh -R`): the server's listens, and the requests about
//! them, made in order on their own task.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use russh::client;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::remote_forward::RemoteRoutes;
use crate::ssh::handler::SshHandler;

/// How long the server gets to answer a remote forward's listen (or cancel)
/// request before the forward is reported unbound.
const SERVER_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// A remote forward's listen on the server, on `address:port`, and its route
/// (owned by forward `owner`), released when this is dropped.
pub(super) struct ServerListen {
    pub(super) address: String,
    pub(super) port: u16,
    pub(super) owner: String,
    pub(super) routes: Arc<RemoteRoutes>,
}

impl ServerListen {
    /// Stop routing (dropping `self`), so open connections close right away;
    /// then, given `requests` (none when the whole connection is closing, which
    /// ends every listen anyway), queue the request to stop listening.
    pub(super) fn release(self, requests: Option<&ServerRequests>) {
        if let Some(requests) = requests {
            requests.cancel(self.address.clone(), self.port);
        }
    }
}

impl Drop for ServerListen {
    fn drop(&mut self) {
        self.routes.release(self.port, &self.owner);
    }
}

/// A remote forward's listen request, numbered so its answer finds the very
/// entry that asked (not a later one for the same forward).
pub(super) struct ListenRequest {
    pub(super) attempt: u64,
    pub(super) address: String,
    pub(super) port: u16,
}

enum ServerRequest {
    Listen(ListenRequest),
    Cancel { address: String, port: u16 },
}

/// The server's answer to listen request `attempt`.
pub(super) struct ListenReply {
    pub(super) attempt: u64,
    pub(super) granted: bool,
}

/// A tunnel's requests to the server about remote forwards, made one at a
/// time on their own task so the serve loop never waits on the server. Order
/// matters (a cancel must follow the listen it undoes), and the server
/// answers them in order anyway.
pub(super) struct ServerRequests {
    queue: mpsc::UnboundedSender<ServerRequest>,
    pub(super) replies: mpsc::UnboundedReceiver<ListenReply>,
    worker: JoinHandle<()>,
}

impl ServerRequests {
    pub(super) fn start(handle: Arc<client::Handle<SshHandler>>) -> Self {
        let (queue, requests) = mpsc::unbounded_channel();
        let (reply_tx, replies) = mpsc::unbounded_channel();
        let worker = RequestWorker {
            handle,
            replies: reply_tx,
            cancels: HashMap::new(),
        };
        let worker = tokio::spawn(worker.run(requests));
        ServerRequests {
            queue,
            replies,
            worker,
        }
    }

    pub(super) fn listen(&self, request: ListenRequest) {
        let _ = self.queue.send(ServerRequest::Listen(request));
    }

    pub(super) fn cancel(&self, address: String, port: u16) {
        let _ = self.queue.send(ServerRequest::Cancel { address, port });
    }
}

impl Drop for ServerRequests {
    fn drop(&mut self) {
        self.worker.abort();
    }
}

impl ServerRequest {
    fn port(&self) -> u16 {
        match self {
            ServerRequest::Listen(listen) => listen.port,
            ServerRequest::Cancel { port, .. } => *port,
        }
    }
}

/// The task behind [`ServerRequests`].
struct RequestWorker {
    handle: Arc<client::Handle<SshHandler>>,
    replies: mpsc::UnboundedSender<ListenReply>,
    /// Cancels sent after a listen timed out, by port: only a later request
    /// for the same port has to wait for one (it must reach the server after).
    cancels: HashMap<u16, JoinHandle<()>>,
}

impl RequestWorker {
    async fn run(mut self, mut requests: mpsc::UnboundedReceiver<ServerRequest>) {
        while let Some(request) = requests.recv().await {
            if let Some(cancel) = self.cancels.remove(&request.port()) {
                let _ = cancel.await;
            }
            match request {
                ServerRequest::Listen(listen) => self.listen(listen).await,
                ServerRequest::Cancel { address, port } => {
                    request_cancel(&self.handle, address, port).await
                }
            }
        }
    }

    /// Ask the server to listen and report its answer; a request that timed
    /// out is then cancelled in the background, as its grant may still arrive.
    async fn listen(&mut self, listen: ListenRequest) {
        let request = self
            .handle
            .tcpip_forward(listen.address.clone(), u32::from(listen.port));
        let reply = tokio::time::timeout(SERVER_REQUEST_TIMEOUT, request).await;
        let granted = matches!(reply, Ok(Ok(_)));
        let _ = self.replies.send(ListenReply {
            attempt: listen.attempt,
            granted,
        });
        if reply.is_err() {
            let handle = Arc::clone(&self.handle);
            let cancel = async move { request_cancel(&handle, listen.address, listen.port).await };
            self.cancels.insert(listen.port, tokio::spawn(cancel));
        }
    }
}

async fn request_cancel(handle: &client::Handle<SshHandler>, address: String, port: u16) {
    let cancel = handle.cancel_tcpip_forward(address, u32::from(port));
    let _ = tokio::time::timeout(SERVER_REQUEST_TIMEOUT, cancel).await;
}
