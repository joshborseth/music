import { Schema } from 'effect'
import { Rpc } from 'effect/rpc'

/*
 * Accounts: each person signs in with a username and a password, and has
 * their own library and their own queue. Nobody signs up alone: an admin
 * makes an invite link, and opening it is the only way to make an account.
 *
 * On the home network the app also opens without signing in, as a guest of
 * the owner's session (the TV's), so the TV's QR code keeps working.
 */

/** What an account may do. Admins also manage people and invites. */
export const AccountRole = Schema.Literals(['Admin', 'Member'])
export type AccountRole = typeof AccountRole.Type

/** Who is using the app: a signed-in account, or a guest on the home network. */
export const Viewer = Schema.TaggedUnion({
  SignedIn: {
    id: Schema.String,
    username: Schema.String,
    role: AccountRole,
    /** The first admin, whose library and session the TV shares. */
    isOwner: Schema.Boolean,
  },
  /** On the home network without signing in: the owner's session, no admin. */
  Guest: {},
})
export type Viewer = typeof Viewer.Type

/** Someone with an account, as the admin page lists them. */
export const Person = Schema.Struct({
  id: Schema.String,
  username: Schema.String,
  role: AccountRole,
  isOwner: Schema.Boolean,
  /** Epoch ms. */
  createdAt: Schema.Number,
  /** When they last used the app (epoch ms), if ever after signing up. */
  lastActiveAt: Schema.NullOr(Schema.Number),
})
export type Person = typeof Person.Type

/** An invite link not used yet. Its code is shown only once, when made. */
export const Invite = Schema.Struct({
  id: Schema.String,
  /** The role the account made from it gets. */
  role: AccountRole,
  /** The admin who made it. */
  createdBy: Schema.String,
  /** Epoch ms. */
  createdAt: Schema.Number,
  /** Epoch ms. */
  expiresAt: Schema.Number,
})
export type Invite = typeof Invite.Type

export const People = Schema.Struct({
  people: Schema.Array(Person),
  invites: Schema.Array(Invite),
})
export type People = typeof People.Type

export const CreatedInvite = Schema.Struct({
  invite: Invite,
  /** The link to send: opening it is the only way to make an account. */
  link: Schema.String,
  people: People,
})
export type CreatedInvite = typeof CreatedInvite.Type

/** The shortest password an account may have. */
export const MIN_PASSWORD_LENGTH = 8
/** The longest password an account may have. */
export const MAX_PASSWORD_LENGTH = 128

/** A username: 3 to 30 letters, digits, dots, and underscores. */
export const USERNAME_PATTERN = /^[a-zA-Z0-9_.]{3,30}$/

export class AccountError extends Schema.TaggedError<AccountError>()(
  'AccountError',
  {
    reason: Schema.Literals([
      /** Not signed in, or not an admin. */
      'NotAllowed',
      'NotFound',
      'WrongPassword',
      'WeakPassword',
      /** The owner can't be demoted or removed. */
      'Owner',
      'Failed',
    ]),
    message: Schema.String,
  },
) {}

/** Who is using the app. */
export const getViewerRpc = Rpc.make('getViewer', {
  success: Viewer,
  error: AccountError,
})

/** Everyone with an account, and the invites not used yet. Admins only. */
export const getPeopleRpc = Rpc.make('getPeople', {
  success: People,
  error: AccountError,
})

/** A new invite link, good for one account for a week. Admins only. */
export const createInviteRpc = Rpc.make('createInvite', {
  payload: Schema.Struct({ role: AccountRole }),
  success: CreatedInvite,
  error: AccountError,
})

export const revokeInviteRpc = Rpc.make('revokeInvite', {
  payload: Schema.Struct({ inviteId: Schema.String }),
  success: People,
  error: AccountError,
})

/** Make someone an admin, or a member again. Admins only; not the owner. */
export const setRoleRpc = Rpc.make('setRole', {
  payload: Schema.Struct({ userId: Schema.String, role: AccountRole }),
  success: People,
  error: AccountError,
})

/**
 * Give someone a new password, and sign out all their devices. Admins only:
 * the app sends no email, so a forgotten password comes back this way.
 */
export const resetPasswordRpc = Rpc.make('resetPassword', {
  payload: Schema.Struct({ userId: Schema.String, password: Schema.String }),
  success: Schema.Void,
  error: AccountError,
})

/** Delete someone's account, library, and queue. Admins only; not the owner. */
export const removePersonRpc = Rpc.make('removePerson', {
  payload: Schema.Struct({ userId: Schema.String }),
  success: People,
  error: AccountError,
})

/** Change your own password. Other devices stay signed in. */
export const changePasswordRpc = Rpc.make('changePassword', {
  payload: Schema.Struct({
    currentPassword: Schema.String,
    newPassword: Schema.String,
  }),
  success: Schema.Void,
  error: AccountError,
})

/** Sign-in pages and form posts the server answers outside the RPCs. */
export const SIGN_IN_PATH = '/sign-in'
export const JOIN_PATH = '/join'
/** `POST` signs this device out, then goes to the sign-in page. */
export const SIGN_OUT_PATH = '/sign-out'
