// ws_server.rs — WebSocket broadcast server for real-time decision push.
//
// Master Phase 1 → Power Phase 1.5 → Subphase 44.
//
// Binds a `TcpListener` on `0.0.0.0:{port}`, accepts incoming connections,
// upgrades them to WebSocket via `tokio_tungstenite::accept_async`, and
// broadcasts JSON-serialised `AggregatedDecision` strings to every connected
// client using a `tokio::sync::broadcast` channel.
//
// The Next.js frontend connects here to receive live decision updates
// without polling — true push-based real-time.

use futures_util::SinkExt;
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::Message;

/// Starts the WebSocket broadcast server.
///
/// Binds to `0.0.0.0:{port}` and accepts incoming TCP connections. Each
/// connection is upgraded to a WebSocket and placed in a spawned task that
/// listens to the broadcast channel for JSON decision strings.
///
/// When a new decision arrives on the broadcast `rx`, it is sent as a
/// `Text` message over the WebSocket. If the WebSocket send fails (client
/// disconnected), the task exits cleanly.
///
/// # Arguments
/// * `port` — The TCP port to listen on (e.g. "8080").
/// * `rx` — A broadcast receiver carrying JSON decision strings from the
///   main consumer loop. Each spawned connection task subscribes independently
///   via `rx.resubscribe()`.
pub async fn start_server(port: &str, rx: broadcast::Receiver<String>) {
    let addr = format!("0.0.0.0:{}", port);

    let listener = TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("WebSocket server failed to bind to {}: {}", addr, e));

    log::info!("WebSocket server listening on ws://{}", addr);

    // We hold onto the original `rx` so we can `.resubscribe()` for each client.
    // `broadcast::Receiver` is not `Clone`, but `.resubscribe()` creates a new
    // receiver from the same `Sender`'s tail position.
    loop {
        match listener.accept().await {
            Ok((stream, peer_addr)) => {
                log::info!("[WS] New connection from: {}", peer_addr);

                // Each client gets its own receiver clone from the broadcast channel.
                let mut client_rx = rx.resubscribe();

                tokio::spawn(async move {
                    // Upgrade raw TCP stream to WebSocket.
                    let ws_stream = match tokio_tungstenite::accept_async(stream).await {
                        Ok(ws) => ws,
                        Err(e) => {
                            log::warn!(
                                "[WS] Handshake failed for {}: {}",
                                peer_addr, e
                            );
                            return;
                        }
                    };

                    log::info!("[WS] Handshake complete for {}", peer_addr);

                    // Split to get only the write half — we don't read from clients.
                    let (mut write, _read) = futures_util::StreamExt::split(ws_stream);

                    // Forward broadcast messages to this WebSocket client.
                    loop {
                        match client_rx.recv().await {
                            Ok(json_string) => {
                                if let Err(e) = write.send(Message::Text(json_string)).await {
                                    log::warn!(
                                        "[WS] Send failed for {} — disconnecting: {}",
                                        peer_addr, e
                                    );
                                    break;
                                }
                            }
                            Err(broadcast::error::RecvError::Lagged(n)) => {
                                log::warn!(
                                    "[WS] Client {} lagged — skipped {} messages",
                                    peer_addr, n
                                );
                                // Continue; client will catch up from the next message.
                            }
                            Err(broadcast::error::RecvError::Closed) => {
                                log::info!(
                                    "[WS] Broadcast channel closed — disconnecting {}",
                                    peer_addr
                                );
                                break;
                            }
                        }
                    }

                    log::info!("[WS] Connection closed for {}", peer_addr);
                });
            }
            Err(e) => {
                log::error!("[WS] Failed to accept TCP connection: {}", e);
            }
        }
    }
}
