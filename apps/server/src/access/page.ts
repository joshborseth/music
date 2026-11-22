/*
 * The sign-in page, served by the gate itself (`gate.ts`), so it needs
 * nothing behind the gate: its style is inline and its logo is the public
 * favicon. It follows the app's look: the page color, Joshify green, and no
 * blur or fades.
 */

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

export type Notice = 'None' | 'WrongCode' | 'TooManyTries'

const NOTICE_TEXT: Readonly<Record<Notice, string>> = {
  None: '',
  WrongCode: 'That code isn’t right. Check it and try again.',
  TooManyTries: 'Too many tries. Wait a few minutes and try again.',
}

export const signInPage = (
  code: string,
  notice: Notice,
): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b0d12">
<meta name="robots" content="noindex">
<title>Sign in · Joshify</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; background: #0b0d12; color: #f2f4f7; }
  body {
    font: 16px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    display: grid; place-items: center; min-height: 100dvh;
    padding: max(24px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom));
  }
  main { width: 100%; max-width: 360px; display: grid; gap: 20px; }
  img { width: 64px; height: 64px; }
  h1 { margin: 0; font-size: 28px; font-weight: 700; letter-spacing: -0.02em; }
  p { margin: 0; color: #9aa3b2; }
  form { display: grid; gap: 12px; }
  label { font-size: 14px; color: #9aa3b2; }
  input {
    width: 100%; padding: 14px 16px; border-radius: 12px; border: 1px solid #2a2f3a;
    background: #151922; color: inherit; font: 600 20px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: 0.08em; text-transform: uppercase;
  }
  input:focus { outline: 2px solid #22d46f; outline-offset: 1px; border-color: transparent; }
  button {
    padding: 14px 16px; border: 0; border-radius: 999px; background: #22d46f; color: #0b0d12;
    font: 700 17px/1 inherit; font-family: inherit; cursor: pointer;
  }
  button:active { transform: scale(0.98); }
  .notice { color: #ff8a80; font-size: 15px; }
</style>
</head>
<body>
<main>
  <img src="/favicon.svg" alt="">
  <h1>Joshify</h1>
  <p>Enter the invite code you were given.</p>
  <form method="post" action="/sign-in">
    <label for="code">Invite code</label>
    <input id="code" name="code" value="${escapeHtml(code)}" placeholder="XXXX-XXXX-XX"
      autocomplete="one-time-code" autocapitalize="characters" autocorrect="off" spellcheck="false"
      required autofocus>
    ${notice === 'None' ? '' : `<p class="notice" role="alert">${NOTICE_TEXT[notice]}</p>`}
    <button type="submit">Sign in</button>
  </form>
</main>
</body>
</html>
`
