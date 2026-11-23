import { Effect, Redacted, Schema } from 'effect'
import { Command, Dom } from 'foldkit'

import { AccountRole } from '@music/shared'

import { Message } from '../message'
import { MusicClient } from '../rpc'
import {
  PeopleChange,
  RESET_PASSWORD_INPUT_ID,
  Secret,
  toAccountFailure,
} from './domain'

export const ChangePassword = Command.define('ChangePassword', {
  args: { currentPassword: Secret, newPassword: Secret },
  messages: [Message.SucceededChangePassword, Message.FailedChangePassword],
  execute: ({ currentPassword, newPassword }) =>
    MusicClient.use(client =>
      client.changePassword({
        currentPassword: Redacted.value(currentPassword),
        newPassword: Redacted.value(newPassword),
      }),
    ).pipe(
      Effect.as(Message.SucceededChangePassword()),
      Effect.catch(failure =>
        Effect.succeed(
          Message.FailedChangePassword({ failure: toAccountFailure(failure) }),
        ),
      ),
    ),
})

export const CreateInvite = Command.define('CreateInvite', {
  args: { role: AccountRole },
  messages: [Message.SucceededCreateInvite, Message.FailedCreateInvite],
  execute: ({ role }) =>
    MusicClient.use(client => client.createInvite({ role })).pipe(
      Effect.map(created => Message.SucceededCreateInvite({ created })),
      Effect.catch(failure =>
        Effect.succeed(
          Message.FailedCreateInvite({ failure: toAccountFailure(failure) }),
        ),
      ),
    ),
})

/** Sends one change to the people or invites; the server answers with all. */
export const ChangePeople = Command.define('ChangePeople', {
  args: { change: PeopleChange },
  messages: [Message.CompletedChangePeople],
  execute: ({ change }) =>
    MusicClient.use(client =>
      PeopleChange.match(change, {
        RevokeInvite: ({ inviteId }) => client.revokeInvite({ inviteId }),
        SetRole: ({ userId, role }) => client.setRole({ userId, role }),
        RemovePerson: ({ userId }) => client.removePerson({ userId }),
      }),
    ).pipe(
      Effect.mapError(toAccountFailure),
      Effect.result,
      Effect.map(result => Message.CompletedChangePeople({ change, result })),
    ),
})

export const ResetPassword = Command.define('ResetPassword', {
  args: {
    userId: Schema.String,
    username: Schema.String,
    password: Secret,
  },
  messages: [Message.SucceededResetPassword, Message.FailedResetPassword],
  execute: ({ userId, username, password }) =>
    MusicClient.use(client =>
      client.resetPassword({ userId, password: Redacted.value(password) }),
    ).pipe(
      Effect.as(Message.SucceededResetPassword({ username })),
      Effect.catch(failure =>
        Effect.succeed(
          Message.FailedResetPassword({ failure: toAccountFailure(failure) }),
        ),
      ),
    ),
})

/** Puts an invite link on the clipboard. */
export const CopyInviteLink = Command.define('CopyInviteLink', {
  args: { link: Schema.String },
  messages: [Message.CompletedCopyInviteLink],
  execute: ({ link }) =>
    Effect.tryPromise(() =>
      globalThis.navigator.clipboard.writeText(link),
    ).pipe(
      Effect.as(Message.CompletedCopyInviteLink({ isCopied: true })),
      Effect.catch(() =>
        Effect.succeed(Message.CompletedCopyInviteLink({ isCopied: false })),
      ),
    ),
})

export const FocusResetPasswordInput = Command.define(
  'FocusResetPasswordInput',
  {
    messages: [Message.CompletedFocusResetPasswordInput],
    execute: Dom.focus(`#${RESET_PASSWORD_INPUT_ID}`).pipe(
      Effect.ignore,
      Effect.as(Message.CompletedFocusResetPasswordInput()),
    ),
  },
)
