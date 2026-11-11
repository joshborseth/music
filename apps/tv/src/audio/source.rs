//! A song's bytes, downloaded in the background and readable while they arrive.
//!
//! The decoder reads through [`StreamingSource`], which blocks until the bytes
//! it wants have arrived. Songs are 3–6 MB of AAC and the server is on the
//! LAN, so the whole file usually lands in well under a second.

use std::io::{self, Read, Seek, SeekFrom};
use std::sync::{Arc, Condvar, Mutex};

use futures_util::StreamExt;
use symphonia::core::io::MediaSource;

#[derive(Default)]
struct Inner {
    bytes: Vec<u8>,
    total: Option<u64>,
    done: bool,
    error: Option<String>,
    cancelled: bool,
}

/// The bytes of one song, shared between its download and its readers.
#[derive(Default)]
pub struct TrackData {
    inner: Mutex<Inner>,
    arrived: Condvar,
}

impl TrackData {
    fn update(&self, change: impl FnOnce(&mut Inner)) {
        let mut inner = self.inner.lock().unwrap();
        change(&mut inner);
        self.arrived.notify_all();
    }

    /// Stop the download and wake any blocked reader with an error.
    pub fn cancel(&self) {
        self.update(|inner| inner.cancelled = true);
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.lock().unwrap().cancelled
    }

    pub fn failed(&self) -> Option<String> {
        self.inner.lock().unwrap().error.clone()
    }

    /// Fill this from `url` until done, failed, or cancelled.
    pub async fn download(self: Arc<Self>, client: reqwest::Client, url: String) {
        let result = async {
            let response = client.get(&url).send().await?.error_for_status()?;
            let total = response.content_length();
            self.update(|inner| {
                inner.total = total;
                if let Some(total) = total {
                    inner.bytes.reserve_exact(total as usize);
                }
            });
            let mut chunks = response.bytes_stream();
            while let Some(chunk) = chunks.next().await {
                let chunk = chunk?;
                if self.is_cancelled() {
                    return Ok(());
                }
                self.update(|inner| inner.bytes.extend_from_slice(&chunk));
            }
            Ok::<_, reqwest::Error>(())
        }
        .await;
        self.update(|inner| {
            match result {
                Ok(()) => {
                    inner.total.get_or_insert(inner.bytes.len() as u64);
                }
                Err(error) => inner.error = Some(error.to_string()),
            }
            inner.done = true;
        });
    }

    /// Copy bytes at `position` into `buffer`, waiting for them if needed.
    /// Returns 0 at the end of the song.
    fn read_at(&self, position: u64, buffer: &mut [u8]) -> io::Result<usize> {
        let mut inner = self.inner.lock().unwrap();
        loop {
            if inner.cancelled {
                return Err(io::Error::new(io::ErrorKind::Interrupted, "cancelled"));
            }
            let available = inner.bytes.len() as u64;
            if position < available {
                let start = position as usize;
                let count = buffer.len().min(inner.bytes.len() - start);
                buffer[..count].copy_from_slice(&inner.bytes[start..start + count]);
                return Ok(count);
            }
            if let Some(error) = &inner.error {
                return Err(io::Error::other(error.clone()));
            }
            if inner.done {
                return Ok(0);
            }
            inner = self.arrived.wait(inner).unwrap();
        }
    }

    /// The song's size, waiting for the response headers if needed.
    fn total(&self) -> Option<u64> {
        let mut inner = self.inner.lock().unwrap();
        loop {
            if inner.total.is_some() || inner.done || inner.cancelled {
                return inner.total;
            }
            inner = self.arrived.wait(inner).unwrap();
        }
    }
}

/// A reader over [`TrackData`] for the decoder.
pub struct StreamingSource {
    data: Arc<TrackData>,
    position: u64,
}

impl StreamingSource {
    pub fn new(data: Arc<TrackData>) -> Self {
        Self { data, position: 0 }
    }
}

impl Read for StreamingSource {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let count = self.data.read_at(self.position, buffer)?;
        self.position += count as u64;
        Ok(count)
    }
}

impl Seek for StreamingSource {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        let target = match to {
            SeekFrom::Start(offset) => Some(offset),
            SeekFrom::Current(delta) => self.position.checked_add_signed(delta),
            SeekFrom::End(delta) => self
                .data
                .total()
                .and_then(|total| total.checked_add_signed(delta)),
        };
        let target =
            target.ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "bad seek"))?;
        self.position = target;
        Ok(target)
    }
}

impl MediaSource for StreamingSource {
    fn is_seekable(&self) -> bool {
        true
    }

    fn byte_len(&self) -> Option<u64> {
        self.data.total()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn reader_waits_for_bytes_then_sees_the_end() {
        let data = Arc::new(TrackData::default());
        let writer = data.clone();
        let handle = thread::spawn(move || {
            thread::sleep(Duration::from_millis(20));
            writer.update(|inner| inner.bytes.extend_from_slice(b"hello"));
            thread::sleep(Duration::from_millis(20));
            writer.update(|inner| {
                inner.bytes.extend_from_slice(b" world");
                inner.total = Some(11);
                inner.done = true;
            });
        });
        let mut source = StreamingSource::new(data);
        let mut text = String::new();
        source.read_to_string(&mut text).unwrap();
        handle.join().unwrap();
        assert_eq!(text, "hello world");
        assert_eq!(source.seek(SeekFrom::End(-5)).unwrap(), 6);
    }

    #[test]
    fn cancel_unblocks_a_waiting_reader() {
        let data = Arc::new(TrackData::default());
        let canceller = data.clone();
        let handle = thread::spawn(move || {
            thread::sleep(Duration::from_millis(20));
            canceller.cancel();
        });
        let mut buffer = [0u8; 4];
        let error = StreamingSource::new(data).read(&mut buffer).unwrap_err();
        handle.join().unwrap();
        assert_eq!(error.kind(), io::ErrorKind::Interrupted);
    }
}
