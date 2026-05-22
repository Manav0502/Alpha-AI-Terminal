use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;

pub async fn start_server(port: u16, mut rx: tokio::sync::broadcast::Receiver<String>) {
    let addr = format!("0.0.0.0:{}", port);
    let listener = TcpListener::bind(&addr).await.expect("Failed to bind WebSocket server");
    
    log::info!("Alpha Terminal WebSocket server listening on: {}", addr);

    while let Ok((stream, _)) = listener.accept().await {
        let mut client_rx = rx.resubscribe();
        
        tokio::spawn(async move {
            if let Ok(mut ws_stream) = accept_async(stream).await {
                while let Ok(msg) = client_rx.recv().await {
                    if ws_stream.send(Message::Text(msg)).await.is_err() {
                        break;
                    }
                }
            }
        });
    }
}
