import { Option } from 'effect'

import {
  type Invite,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  SIGN_IN_PATH,
} from '@music/shared'

import { type JoinProblem, MACHINE_INVITER } from './accounts.ts'

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
    'This invite link was already used, has expired, or was revoked. Ask whoever sent it for a new one.',
  UsernameInvalid:
    'Use 3 to 30 letters, numbers, dots, or underscores for your username.',
  UsernameTaken: 'Someone already has that username. Try another.',
  PasswordInvalid: `Use ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters for your password.`,
  PasswordsDiffer: 'The two passwords don’t match.',
  TooManyTries: 'Too many tries. Wait a few minutes and try again.',
}

const notice = (text: string): string =>
  text === '' ? '' : `<p class="notice" role="alert">${escapeHtml(text)}</p>`

const DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
})

/**
 * The username an invite's name suggests (`Sam Lee` → `samlee`), when it
 * makes a valid one.
 */
export const suggestedUsername = (name: string): string => {
  const username = name
    .toLowerCase()
    .replace(/[^a-z0-9_.]/g, '')
    .slice(0, 30)
  return username.length >= 3 ? username : ''
}

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
  main { width: 100%; max-width: 360px; display: grid; gap: 24px; }
  header { display: grid; gap: 8px; }
  .logo { width: 56px; height: 56px; margin-bottom: 8px; }
  h1 { margin: 0; font-size: 28px; line-height: 1.15; font-weight: 700; letter-spacing: -0.02em; }
  p { margin: 0; color: #9aa3b2; }
  b { color: #f2f4f7; font-weight: 600; }
  form { display: grid; gap: 16px; }
  .field { display: grid; gap: 6px; }
  label { font-size: 14px; font-weight: 500; color: #c4cad4; }
  input {
    width: 100%; padding: 14px 16px; border-radius: 12px; border: 1px solid #2a2f3a;
    background: #151922; color: inherit; font-family: inherit; font-size: 17px; line-height: 1.2;
  }
  input:focus { outline: 2px solid #22d46f; outline-offset: 1px; border-color: transparent; }
  .button {
    display: block; width: 100%; padding: 15px 16px; border: 0; border-radius: 999px;
    background: #22d46f; color: #0b0d12; text-align: center; text-decoration: none;
    font-family: inherit; font-size: 17px; font-weight: 700; line-height: 1; cursor: pointer;
  }
  .button.secondary { background: #1b202b; color: #22d46f; }
  .button:active { transform: scale(0.98); }
  a { color: #22d46f; text-decoration: none; font-weight: 600; }
  .notice { color: #ff8a80; font-size: 15px; }
  .hint { font-size: 13px; }
  .footer { display: grid; gap: 4px; font-size: 14px; text-align: center; }
  .perks { display: grid; gap: 10px; margin: 0; padding: 14px 16px; list-style: none; border-radius: 14px; background: #151922; }
  .perks li { display: flex; gap: 10px; align-items: baseline; color: #c4cad4; font-size: 15px; }
  .perks li::before { content: ""; flex: none; width: 6px; height: 6px; border-radius: 50%; background: #22d46f; transform: translateY(-2px); }
</style>
</head>
<body>
<main>
  ${body}
</main>
</body>
</html>
`

const logo = '<img class="logo" src="/favicon.svg" alt="">'

export const signInPage = (username: string, notice_: SignInNotice): string =>
  shell(
    'Sign in',
    `<header>
    ${logo}
    <h1>Sign in to Joshify</h1>
  </header>
  <form method="post" action="${SIGN_IN_PATH}">
    <div class="field">
      <label for="username">Username</label>
      <input id="username" name="username" value="${escapeHtml(username)}"
        autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false"
        required autofocus>
    </div>
    <div class="field">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
    </div>
    ${notice(SIGN_IN_NOTICE[notice_])}
    <button class="button" type="submit">Sign In</button>
  </form>
  <p class="footer">No account? Ask whoever runs Joshify for an invite link.</p>`,
  )

const joinForm = (
  invite: Invite,
  code: string,
  username: string,
  notice_: JoinNotice,
): string => {
  const greeting =
    invite.name === ''
      ? 'You’re invited to Joshify'
      : `${escapeHtml(invite.name)}, you’re invited`
  const prefill = username === '' ? suggestedUsername(invite.name) : username
  return `<header>
    ${logo}
    <h1>${greeting}</h1>
    <p>${invite.createdBy === MACHINE_INVITER ? '' : `<b>${escapeHtml(invite.createdBy)}</b> invited you to Joshify. `}Pick a username and a password to make your account.</p>
  </header>
  <ul class="perks">
    <li>Your own library, playlists, and liked songs</li>
    <li>Your own queue, on any of your devices</li>
    ${invite.role === 'Admin' ? '<li>You’re an admin, so you can invite people too</li>' : ''}
  </ul>
  <form method="post" action="/join">
    <input type="hidden" name="code" value="${escapeHtml(code)}">
    <div class="field">
      <label for="username">Username</label>
      <input id="username" name="username" value="${escapeHtml(prefill)}"
        autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false"
        minlength="3" maxlength="30" pattern="[a-zA-Z0-9_.]{3,30}" required autofocus
        aria-describedby="username-hint">
      <p class="hint" id="username-hint">What you sign in with. Letters, numbers, dots, or underscores.</p>
    </div>
    <div class="field">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="new-password"
        minlength="${MIN_PASSWORD_LENGTH}" maxlength="${MAX_PASSWORD_LENGTH}" required
        aria-describedby="password-hint">
      <p class="hint" id="password-hint">At least ${MIN_PASSWORD_LENGTH} characters.</p>
    </div>
    <div class="field">
      <label for="confirm">Confirm password</label>
      <input id="confirm" name="confirm" type="password" autocomplete="new-password"
        minlength="${MIN_PASSWORD_LENGTH}" maxlength="${MAX_PASSWORD_LENGTH}" required>
    </div>
    ${notice(JOIN_NOTICE[notice_])}
    <button class="button" type="submit">Create Account</button>
  </form>
  <div class="footer">
    <p>This invite works once, until ${DATE_FORMAT.format(invite.expiresAt)}.</p>
    <p>Already have an account? <a href="${SIGN_IN_PATH}">Sign in</a></p>
  </div>`
}

const inviteGone = (notice_: JoinNotice): string =>
  `<header>
    ${logo}
    <h1>This invite can’t be used</h1>
    ${
      notice_ === 'TooManyTries'
        ? notice(JOIN_NOTICE.TooManyTries)
        : '<p>It was already used, it expired, or it was revoked. Ask whoever sent it for a new link.</p>'
    }
  </header>
  <a class="button secondary" href="${SIGN_IN_PATH}">Sign In Instead</a>`

/** The page an invite link opens: the form, or why it can't be used. */
export const joinPage = (
  maybeInvite: Option.Option<Invite>,
  code: string,
  username: string,
  notice_: JoinNotice,
): string =>
  Option.match(maybeInvite, {
    onNone: () => shell('Invite', inviteGone(notice_)),
    onSome: invite =>
      notice_ === 'TooManyTries'
        ? shell('Invite', inviteGone(notice_))
        : shell('Make your account', joinForm(invite, code, username, notice_)),
  })
