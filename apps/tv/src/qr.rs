//! The QR code on screen: the music server's address on the home network,
//! so anyone on the Wi-Fi can open the app on their phone and play music.

use qrcodegen::{QrCode, QrCodeEcc};

/// One pixel per module, black on white. The screen scales it up without
/// smoothing and draws the quiet zone around it.
pub fn pixels(text: &str) -> Option<(u32, Vec<u8>)> {
    let code = QrCode::encode_text(text, QrCodeEcc::Medium).ok()?;
    let size = code.size();
    let mut rgba = Vec::with_capacity((size * size * 4) as usize);
    for y in 0..size {
        for x in 0..size {
            let shade = if code.get_module(x, y) { 0x12 } else { 0xff };
            rgba.extend_from_slice(&[shade, shade, shade, 0xff]);
        }
    }
    Some((size as u32, rgba))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_the_server_address() {
        let (size, rgba) = pixels("http://192.168.1.67:4310/").unwrap();
        assert_eq!(size, 25);
        assert_eq!(rgba.len(), (size * size * 4) as usize);
        // The top-left finder pattern starts dark.
        assert_eq!(rgba[0], 0x12);
    }
}
