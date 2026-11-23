import { Match, Option, Redacted, Schema } from 'effect'
import { type RpcClientError } from 'effect/rpc'
import { defineTaggedUnion } from 'foldkit/schema'

import {
  type AccountError,
  AccountRole,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  type Viewer,
} from '@music/shared'

/*
 * The Account page: who is signed in, changing your own password, and for
 * admins, the people with accounts and the invite links that make new ones.
 * The server renders the sign-in and invite pages itself; the app only links
 * to them.
 */

// FAILURE

/** Why an account request failed, as the page tells it. */
export const AccountFailure = Schema.Struct({
  reason: Schema.Literals([
    'NotAllowed',
    'NotFound',
    'WrongPassword',
    'WeakPassword',
    'Owner',
    'Failed',
    'ServerUnreachable',
  ]),
  /** What to show: the server's own words, or that it can't be reached. */
  message: Schema.String,
})
export type AccountFailure = typeof AccountFailure.Type

export const SERVER_UNREACHABLE_MESSAGE =
  'Could not reach the music server. Check your connection.'

export const toAccountFailure = (
  failure: AccountError | RpcClientError.RpcClientError,
): AccountFailure =>
  Match.valueTags(failure, {
    AccountError: ({ reason, message }): AccountFailure => ({
      reason,
      message,
    }),
    RpcClientError: (): AccountFailure => ({
      reason: 'ServerUnreachable',
      message: SERVER_UNREACHABLE_MESSAGE,
    }),
  })

// PASSWORDS

/**
 * A password while it is typed and sent. Redacted, so the Model, Messages,
 * and Commands never show it in logs or the devtools.
 */
const SECRET_LABEL = 'password'

export const Secret = Schema.Redacted(Schema.String, {
  label: SECRET_LABEL,
  disallowJsonEncode: true,
})
export type Secret = typeof Secret.Type

export const makeSecret = (value: string): Secret =>
  Redacted.make(value, { label: SECRET_LABEL })

export const emptySecret = (): Secret => makeSecret('')

/** Which box of the Change Password form was typed in. */
export const PasswordField = Schema.Literals(['Current', 'New', 'Confirm'])
export type PasswordField = typeof PasswordField.Type

/** Where a Change Password attempt stands. */
export const PasswordFormStatus = defineTaggedUnion({
  Editing: {},
  Saving: {},
  Saved: {},
  /** Turned down, by the form's own checks or by the server. */
  Rejected: { message: Schema.String },
})
export type PasswordFormStatus = typeof PasswordFormStatus.Type

export const PasswordForm = Schema.Struct({
  current: Secret,
  new: Secret,
  confirm: Secret,
  status: PasswordFormStatus,
})
export type PasswordForm = typeof PasswordForm.Type

export const emptyPasswordForm = (
  status: PasswordFormStatus,
): PasswordForm => ({
  current: emptySecret(),
  new: emptySecret(),
  confirm: emptySecret(),
  status,
})

/** What is wrong with a new password's length, if anything. */
export const newPasswordProblem = (password: string): Option.Option<string> => {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return Option.some(
      `The new password needs at least ${MIN_PASSWORD_LENGTH} characters.`,
    )
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return Option.some(
      `The new password can have at most ${MAX_PASSWORD_LENGTH} characters.`,
    )
  }
  return Option.none()
}

/** What stops the Change Password form from being sent, if anything. */
export const passwordFormProblem = (
  form: PasswordForm,
): Option.Option<string> => {
  const newPassword = Redacted.value(form.new)
  if (Redacted.value(form.current).length === 0) {
    return Option.some('Enter your current password.')
  }
  return Option.orElse(newPasswordProblem(newPassword), () =>
    newPassword === Redacted.value(form.confirm)
      ? Option.none()
      : Option.some('The new passwords don’t match.'),
  )
}

/** The new password an admin is typing for someone else. */
export const ResetPasswordForm = Schema.Struct({
  input: Secret,
  maybeProblem: Schema.Option(Schema.String),
})
export type ResetPasswordForm = typeof ResetPasswordForm.Type

export const RESET_PASSWORD_INPUT_ID = 'reset-password-input'

// INVITES

/** Where making an invite link stands, in the Invite Someone sheet. */
export const NewInviteStatus = defineTaggedUnion({
  Editing: {},
  Creating: {},
  Failed: { message: Schema.String },
})
export type NewInviteStatus = typeof NewInviteStatus.Type

/** The Invite Someone sheet: who the link is for, and what they may do. */
export const NewInviteForm = Schema.Struct({
  name: Schema.String,
  role: AccountRole,
  status: NewInviteStatus,
})
export type NewInviteForm = typeof NewInviteForm.Type

export const emptyNewInviteForm = (): NewInviteForm => ({
  name: '',
  role: 'Member',
  status: NewInviteStatus.Editing(),
})

export const NEW_INVITE_NAME_INPUT_ID = 'new-invite-name'

// PEOPLE

/** A change to the people or invites, each answered with the fresh list. */
export const PeopleChange = defineTaggedUnion({
  RevokeInvite: { inviteId: Schema.String },
  SetRole: { userId: Schema.String, role: AccountRole },
  RemovePerson: { userId: Schema.String },
})
export type PeopleChange = typeof PeopleChange.Type

// MODEL

export const AccountPage = Schema.Struct({
  passwordForm: PasswordForm,
  newInvite: NewInviteForm,
  resetPassword: ResetPasswordForm,
})
export type AccountPage = typeof AccountPage.Type

export const emptyResetPasswordForm = (): ResetPasswordForm => ({
  input: emptySecret(),
  maybeProblem: Option.none(),
})

export const initialAccountPage = (): AccountPage => ({
  passwordForm: emptyPasswordForm(PasswordFormStatus.Editing()),
  newInvite: emptyNewInviteForm(),
  resetPassword: emptyResetPasswordForm(),
})

/** Admins also manage people and invites. */
export const isAdmin = (viewer: Viewer): boolean =>
  viewer._tag === 'SignedIn' && viewer.role === 'Admin'
