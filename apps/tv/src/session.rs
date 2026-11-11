//! Keeps one WebSocket open to the server's `/session`, reconnecting forever.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tokio_tungstenite::tungstenite::Message;

use crate::protocol::{ClientMessage, ServerMessage};

#[derive(Debug)]
pub enum Inbound {
    Connected,
    Disconnected,
    Message(ServerMessage),
}

const MIN_BACKOFF: Duration = Duration::from_millis(500);
const MAX_BACKOFF: Duration = Duration::from_secs(5);

/// Start the connection. Messages sent while disconnected are dropped: the
/// server sends the whole state again on reconnect, so nothing is lost.
pub fn spawn(
    runtime: &tokio::runtime::Handle,
    url: String,
    hello: ClientMessage,
    inbound: UnboundedSender<Inbound>,
) -> UnboundedSender<ClientMessage> {
    let (outbound, mut outgoing) = unbounded_channel::<ClientMessage>();
    runtime.spawn(async move {
        let mut backoff = MIN_BACKOFF;
        loop {
            match tokio_tungstenite::connect_async(&url).await {
                Ok((socket, _)) => {
                    backoff = MIN_BACKOFF;
                    let _ = inbound.send(Inbound::Connected);
                    if let Err(error) = run(socket, &hello, &mut outgoing, &inbound).await {
                        log::warn!("session connection lost: {error}");
                    }
                    let _ = inbound.send(Inbound::Disconnected);
                }
                Err(error) => log::info!("cannot reach the server at {url}: {error}"),
            }
            if inbound.is_closed() {
                return;
            }
            while outgoing.try_recv().is_ok() {}
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(MAX_BACKOFF);
        }
    });
    outbound
}

async fn run<S>(
    socket: tokio_tungstenite::WebSocketStream<S>,
    hello: &ClientMessage,
    outgoing: &mut UnboundedReceiver<ClientMessage>,
    inbound: &UnboundedSender<Inbound>,
) -> Result<(), String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (mut sink, mut stream) = socket.split();
    let encode = |message: &ClientMessage| {
        Message::text(serde_json::to_string(message).expect("client messages serialize"))
    };
    sink.send(encode(hello))
        .await
        .map_err(|error| error.to_string())?;
    loop {
        tokio::select! {
            frame = stream.next() => match frame {
                Some(Ok(Message::Text(text))) => match serde_json::from_str::<ServerMessage>(&text) {
                    Ok(message) => {
                        let _ = inbound.send(Inbound::Message(message));
                    }
                    Err(error) => log::warn!("unreadable server message: {error}"),
                },
                Some(Ok(Message::Close(_))) | None => return Ok(()),
                Some(Ok(_)) => {}
                Some(Err(error)) => return Err(error.to_string()),
            },
            message = outgoing.recv() => match message {
                Some(message) => sink.send(encode(&message)).await.map_err(|error| error.to_string())?,
                None => return Ok(()),
            },
        }
    }
}
