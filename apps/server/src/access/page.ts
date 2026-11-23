import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '@music/shared'

import type { JoinProblem } from './accounts.ts'

/*
 * The sign-in and invite pages, served by the gate itself (`gate.ts`), so
 * they need nothing behind it: their style is inline and their logo is the
 * public favicon. They follow the app's look: the page color, Joshify
 * green, and no blur or fades.
 */

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

export type SignInNotice = 'None' | 'WrongPassword' | 'TooManyTries'

const SIGN_IN_NOTICE: Readonly<Record<SignInNotice, string>> = {
  None: '',
  WrongPassword: 'That username or password isn’t right.',
  TooManyTries: 'Too many tries. Wait a few minutes and try again.',
}

export type JoinNotice = 'None' | JoinProblem | 'TooManyTries'

const JOIN_NOTICE: Readonly<Record<JoinNotice, string>> = {
  None: '',
  InviteGone:
    'This invite link has been used, has expired, or isn’t right. Ask for a new one.',
  UsernameInvalid:
    'Use 3 to 30 letters, numbers, dots, or underscores for your username.',
  UsernameTaken: 'Someone already has that username. Try another.',
  PasswordInvalid: `Use ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters for your password.`,
  PasswordsDiffer: 'The two passwords don’t match.',
  TooManyTries: 'Too many tries. Wait a few minutes and try again.',
}

const notice = (text: string): string =>
  text === '' ? '' : `<p class="notice" role="alert">${escapeHtml(text)}</p>`

const shell = (title: string, body: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b0d12">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · Joshify</title>
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
    background: #151922; color: inherit; font: 17px/1.2 inherit; font-family: inherit;
  }
  input:focus { outline: 2px solid #22d46f; outline-offset: 1px; border-color: transparent; }
  button {
    margin-top: 4px; padding: 14px 16px; border: 0; border-radius: 999px; background: #22d46f;
    color: #0b0d12; font: 700 17px/1 inherit; font-family: inherit; cursor: pointer;
  }
  button:active { transform: scale(0.98); }
  .notice { color: #ff8a80; font-size: 15px; }
  .hint { font-size: 14px; }
</style>
</head>
<body>
<main>
  <img src="/favicon.svg" alt="">
  ${body}
</main>
</body>
</html>
`

export const signInPage = (username: string, notice_: SignInNotice): string =>
  shell(
    'Sign in',
    `<h1>Joshify</h1>
  <p>Sign in to your account.</p>
  <form method="post" action="/sign-in">
    <label for="username">Username</label>
    <input id="username" name="username" value="${escapeHtml(username)}"
      autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false"
      required autofocus>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    ${notice(SIGN_IN_NOTICE[notice_])}
    <button type="submit">Sign in</button>
  </form>
  <p class="hint">No account? Ask whoever runs Joshify for an invite link.</p>`,
  )

export const joinPage = (
  code: string,
  username: string,
  notice_: JoinNotice,
  isUsable: boolean,
): string =>
  shell(
    'Make your account',
    isUsable
      ? `<h1>Welcome to Joshify</h1>
  <p>Choose a username and a password for your account.</p>
  <form method="post" action="/join">
    <input type="hidden" name="code" value="${escapeHtml(code)}">
    <label for="username">Username</label>
    <input id="username" name="username" value="${escapeHtml(username)}"
      autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false"
      minlength="3" maxlength="30" pattern="[a-zA-Z0-9_.]{3,30}" required autofocus>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="new-password"
      minlength="${MIN_PASSWORD_LENGTH}" maxlength="${MAX_PASSWORD_LENGTH}" required>
    <label for="confirm">Password again</label>
    <input id="confirm" name="confirm" type="password" autocomplete="new-password"
      minlength="${MIN_PASSWORD_LENGTH}" maxlength="${MAX_PASSWORD_LENGTH}" required>
    ${notice(JOIN_NOTICE[notice_])}
    <button type="submit">Make my account</button>
  </form>`
      : `<h1>Joshify</h1>
  ${notice(JOIN_NOTICE[notice_ === 'None' ? 'InviteGone' : notice_])}
  <p class="hint">Already have an account? <a href="/sign-in" style="color:#22d46f">Sign in</a>.</p>`,
  )
