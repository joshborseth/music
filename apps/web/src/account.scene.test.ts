import { Redacted, Result } from 'effect'
import { AsyncData } from 'foldkit'
import {
  Command,
  Mount,
  all,
  click,
  expect,
  given,
  inside,
  label,
  nth,
  role,
  scene,
  text,
  type,
} from 'foldkit/scene'
import { modifyFields } from 'foldkit/struct'
import { describe, test } from 'vitest'

import {
  type CreatedInvite,
  type Invite,
  type People,
  type Person,
  type Viewer,
} from '@music/shared'

import {
  ChangePassword,
  ChangePeople,
  CopyInviteLink,
  CreateInvite,
  FocusResetPasswordInput,
  ResetPassword,
} from './account/command'
import { LoadExternal, LockScroll, ShareLink, UnlockScroll } from './command'
import { Message } from './message'
import { type Model } from './model'
import { DragToDismiss, RestoreScroll, SyncTitleBarReveal } from './mount'
import { WaitBeforeHideNotice } from './playback/command'
import { AppRoute } from './route'
import { initialModel, update } from './update'
import { view } from './view'

const pageScrolled = Mount.resolve(
  RestoreScroll,
  Message.CompletedRestoreScroll(),
)

const titleBarFollowsScroll = Mount.resolve(
  SyncTitleBarReveal,
  Message.CompletedSyncTitleBarReveal(),
)

const sheetFollowsDrags = Mount.resolve(
  DragToDismiss,
  Message.CompletedFollowSheetDrags(),
)

const NOON = Date.UTC(2026, 10, 20, 12)

const josh: Person = {
  id: 'u-josh',
  username: 'josh',
  role: 'Admin',
  isOwner: true,
  createdAt: NOON,
  lastActiveAt: NOON,
}

const alex: Person = {
  id: 'u-alex',
  username: 'alex',
  role: 'Admin',
  isOwner: false,
  createdAt: NOON,
  lastActiveAt: NOON,
}

const sam: Person = {
  id: 'u-sam',
  username: 'sam',
  role: 'Member',
  isOwner: false,
  createdAt: NOON,
  lastActiveAt: null,
}

const memberInvite: Invite = {
  id: 'inv-member',
  name: 'Riley',
  role: 'Member',
  link: 'https://joshify.example/join?code=riley1',
  createdBy: josh.id,
  createdAt: NOON,
  expiresAt: NOON + 7 * 24 * 60 * 60 * 1000,
}

const everyone: People = { people: [josh, alex, sam], invites: [memberInvite] }

const joshViewer: Viewer = {
  _tag: 'SignedIn',
  id: josh.id,
  username: josh.username,
  role: 'Admin',
  isOwner: true,
}

const samViewer: Viewer = {
  _tag: 'SignedIn',
  id: sam.id,
  username: sam.username,
  role: 'Member',
  isOwner: false,
}

const accountModel = (viewer: Viewer, people?: People): Model =>
  modifyFields(initialModel(AppRoute.Account(), '/account'), {
    viewer: query =>
      modifyFields(query, { data: () => AsyncData.succeed(viewer) }),
    people: query =>
      people === undefined
        ? query
        : modifyFields(query, { data: () => AsyncData.succeed(people) }),
  })

const pageShown = [pageScrolled, titleBarFollowsScroll] as const

describe('account page', () => {
  test('a guest learns whose session they share, and signs in on the server’s page', () => {
    scene(
      { update, view },
      given(accountModel({ _tag: 'Guest' })),
      ...pageShown,
      expect(text('You’re a guest')).toExist(),
      expect(text(/shares the TV’s session/)).toExist(),
      expect(role('heading', { name: 'Change Password' })).toBeAbsent(),
      expect(role('button', { name: 'Sign Out' })).toBeAbsent(),
      click(role('button', { name: 'Sign In' })),
      Command.expectExact(LoadExternal({ href: '/sign-in' })),
      Command.resolve(LoadExternal, Message.CompletedLoadExternal()),
    )
  })

  test('a member sees who they are and can sign out, but no People', () => {
    scene(
      { update, view },
      given(accountModel(samViewer)),
      ...pageShown,
      expect(text('sam')).toExist(),
      expect(text('Member')).toExist(),
      expect(role('heading', { name: 'Change Password' })).toExist(),
      expect(role('button', { name: 'Sign Out' })).toHaveAttr('type', 'submit'),
      expect(role('heading', { name: 'People' })).toBeAbsent(),
      expect(role('button', { name: 'Invite Someone' })).toBeAbsent(),
    )
  })

  test('the Library opens the Account page from its title bar', () => {
    scene(
      { update, view },
      given(initialModel(AppRoute.Library(), '/library')),
      pageScrolled,
      expect(role('link', { name: 'Account' })).toHaveAttr('href', '/account'),
    )
  })
})

describe('change password', () => {
  test('checks the length and the match before sending, then shows the server’s answer', () => {
    scene(
      { update, view },
      given(accountModel(samViewer)),
      ...pageShown,
      click(role('button', { name: 'Change Password' })),
      expect(role('alert')).toHaveText('Enter your current password.'),
      type(label('Current password'), 'old-password'),
      expect(role('alert')).toBeAbsent(),
      type(label('New password'), 'short'),
      type(label('Confirm new password'), 'short'),
      click(role('button', { name: 'Change Password' })),
      expect(role('alert')).toHaveText(
        'The new password needs at least 8 characters.',
      ),
      Command.expectNone(),
      type(label('New password'), 'long-enough-1'),
      type(label('Confirm new password'), 'long-enough-2'),
      click(role('button', { name: 'Change Password' })),
      expect(role('alert')).toHaveText('The new passwords don’t match.'),
      Command.expectNone(),
      type(label('Confirm new password'), 'long-enough-1'),
      click(role('button', { name: 'Change Password' })),
      Command.expectExact(
        ChangePassword({
          currentPassword: Redacted.make('old-password'),
          newPassword: Redacted.make('long-enough-1'),
        }),
      ),
      expect(role('button', { name: 'Changing…' })).toExist(),
      Command.resolve(
        ChangePassword,
        Message.FailedChangePassword({
          failure: {
            reason: 'WrongPassword',
            message: 'That isn’t your current password.',
          },
        }),
      ),
      expect(role('alert')).toHaveText('That isn’t your current password.'),
      type(label('Current password'), 'right-password'),
      click(role('button', { name: 'Change Password' })),
      Command.resolve(ChangePassword, Message.SucceededChangePassword()),
      expect(role('status')).toHaveText(
        'Password changed. Your other devices stay signed in.',
      ),
      expect(label('Current password')).toHaveValue(''),
      expect(label('New password')).toHaveValue(''),
      expect(label('Confirm new password')).toHaveValue(''),
    )
  })
})

const peopleRows = all.role('listitem')

describe('people, for admins', () => {
  test('lists everyone with their role, and offers actions only where they’re safe', () => {
    scene(
      { update, view },
      given(accountModel(joshViewer, everyone)),
      ...pageShown,
      expect(text('Admin · Owner')).toExist(),
      inside(
        role('list', { name: 'People' }),
        expect(nth(peopleRows, 0)).toHaveText(/josh.*Admin.*Owner.*You/),
        expect(nth(peopleRows, 1)).toHaveText(/alex.*Admin.*Last active/),
        expect(nth(peopleRows, 2)).toHaveText(/sam.*Not active yet/),
        expect(nth(peopleRows, 2)).not.toHaveText(/Admin/),
      ),
      expect(role('button', { name: 'Options for josh' })).toBeAbsent(),
      expect(role('button', { name: 'Options for alex' })).toExist(),
      expect(role('button', { name: 'Options for sam' })).toExist(),
      inside(
        role('list', { name: 'People' }),
        expect(nth(peopleRows, 3)).toHaveText(/Riley.*Invited.*Link expires/),
        expect(nth(peopleRows, 3)).not.toHaveText(/Admin/),
        expect(nth(peopleRows, 4)).toHaveText('Invite Someone'),
      ),
    )
  })

  test('makes someone an admin from their options, and shows the server’s list', () => {
    scene(
      { update, view },
      given(accountModel(joshViewer, everyone)),
      ...pageShown,
      click(role('button', { name: 'Options for sam' })),
      Command.resolve(LockScroll, Message.CompletedLockScroll()),
      sheetFollowsDrags,
      expect(role('dialog', { name: 'sam' })).toExist(),
      expect(role('button', { name: 'Make Member' })).toBeAbsent(),
      click(role('button', { name: 'Make Admin' })),
      Command.expectExact(
        UnlockScroll(),
        ChangePeople({
          change: { _tag: 'SetRole', userId: sam.id, role: 'Admin' },
        }),
      ),
      Command.resolve(UnlockScroll, Message.CompletedUnlockScroll()),
      Command.resolve(
        ChangePeople,
        Message.CompletedChangePeople({
          change: { _tag: 'SetRole', userId: sam.id, role: 'Admin' },
          result: Result.succeed({
            ...everyone,
            people: [josh, alex, { ...sam, role: 'Admin' }],
          }),
        }),
      ),
      inside(
        role('list', { name: 'People' }),
        expect(nth(peopleRows, 2)).toHaveText(/sam.*Admin/),
      ),
    )
  })

  test('removes someone only after confirming', () => {
    scene(
      { update, view },
      given(accountModel(joshViewer, everyone)),
      ...pageShown,
      click(role('button', { name: 'Options for sam' })),
      Command.resolve(LockScroll, Message.CompletedLockScroll()),
      sheetFollowsDrags,
      click(role('button', { name: 'Remove' })),
      Command.expectNone(),
      expect(role('dialog', { name: 'Remove Person' })).toExist(),
      expect(text('Remove sam?')).toExist(),
      click(role('button', { name: 'Remove' })),
      Command.expectExact(
        UnlockScroll(),
        ChangePeople({ change: { _tag: 'RemovePerson', userId: sam.id } }),
      ),
      Command.resolve(UnlockScroll, Message.CompletedUnlockScroll()),
      Command.resolve(
        ChangePeople,
        Message.CompletedChangePeople({
          change: { _tag: 'RemovePerson', userId: sam.id },
          result: Result.succeed({ ...everyone, people: [josh, alex] }),
        }),
      ),
      expect(role('button', { name: 'Options for sam' })).toBeAbsent(),
    )
  })

  test('resets a password once it is long enough', () => {
    scene(
      { update, view },
      given(accountModel(joshViewer, everyone)),
      ...pageShown,
      click(role('button', { name: 'Options for sam' })),
      Command.resolve(LockScroll, Message.CompletedLockScroll()),
      sheetFollowsDrags,
      click(role('button', { name: 'Reset Password' })),
      Command.resolve(
        FocusResetPasswordInput,
        Message.CompletedFocusResetPasswordInput(),
      ),
      expect(text('New Password for sam')).toExist(),
      type(label('New password for sam'), 'short'),
      click(role('button', { name: 'Set Password' })),
      expect(role('alert')).toHaveText(
        'The new password needs at least 8 characters.',
      ),
      Command.expectNone(),
      type(label('New password for sam'), 'a-new-start'),
      click(role('button', { name: 'Set Password' })),
      Command.expectExact(
        ResetPassword({
          userId: sam.id,
          username: sam.username,
          password: Redacted.make('a-new-start'),
        }),
        UnlockScroll(),
      ),
      Command.resolve(UnlockScroll, Message.CompletedUnlockScroll()),
      Command.resolve(
        ResetPassword,
        Message.SucceededResetPassword({ username: sam.username }),
      ),
      Command.resolve(
        WaitBeforeHideNotice,
        Message.CompletedWaitBeforeHideNotice({
          message: 'New password set. sam was signed out.',
        }),
      ),
    )
  })
})

describe('inviting someone', () => {
  const link = 'https://joshify.example/join?code=abc123'
  const morganInvite: Invite = {
    id: 'inv-morgan',
    name: 'Morgan',
    role: 'Admin',
    link,
    createdBy: josh.id,
    createdAt: NOON,
    expiresAt: NOON + 7 * 24 * 60 * 60 * 1000,
  }
  const created: CreatedInvite = {
    invite: morganInvite,
    people: { ...everyone, invites: [memberInvite, morganInvite] },
  }

  const openInviteSomeone = [
    click(role('button', { name: 'Invite Someone' })),
    Command.resolve(LockScroll, Message.CompletedLockScroll()),
    sheetFollowsDrags,
  ] as const

  test('names who it’s for, picks a role, and hands over the link to share', () => {
    scene(
      { update, view },
      given(accountModel(joshViewer, everyone)),
      ...pageShown,
      ...openInviteSomeone,
      expect(role('dialog', { name: 'Invite Someone' })).toExist(),
      expect(role('radio', { name: /^Member/ })).toHaveAttr(
        'aria-checked',
        'true',
      ),
      type(label('Who’s it for?'), 'Morgan'),
      click(role('radio', { name: /^Admin/ })),
      expect(role('radio', { name: /^Admin/ })).toHaveAttr(
        'aria-checked',
        'true',
      ),
      click(role('button', { name: 'Create Link' })),
      Command.expectExact(CreateInvite({ name: 'Morgan', role: 'Admin' })),
      expect(role('button', { name: 'Creating…' })).toExist(),
      Command.resolve(CreateInvite, Message.SucceededCreateInvite({ created })),
      expect(role('dialog', { name: 'Invite Link Ready' })).toExist(),
      expect(text('Invite for Morgan is ready')).toExist(),
      expect(text(/one admin account/)).toExist(),
      expect(label('Invite link')).toHaveText(
        'joshify.example/join?code=abc123',
      ),
      inside(
        role('list', { name: 'People' }),
        expect(nth(peopleRows, 4)).toHaveText(/Morgan.*Admin.*Invited/),
      ),
      click(role('button', { name: 'Copy Link' })),
      Command.expectExact(CopyInviteLink({ link })),
      Command.resolve(
        CopyInviteLink,
        Message.CompletedCopyInviteLink({ isCopied: true }),
      ),
      Command.resolve(
        WaitBeforeHideNotice,
        Message.CompletedWaitBeforeHideNotice({ message: 'Link copied' }),
      ),
      click(role('button', { name: 'Share' })),
      Command.expectExact(
        UnlockScroll(),
        ShareLink({ title: 'Morgan, join me on Joshify', href: link }),
      ),
      Command.resolve(UnlockScroll, Message.CompletedUnlockScroll()),
      Command.resolve(
        ShareLink,
        Message.CompletedShareLink({ isCopied: false }),
      ),
    )
  })

  test('starts each invite from a blank form', () => {
    scene(
      { update, view },
      given(accountModel(joshViewer, everyone)),
      ...pageShown,
      ...openInviteSomeone,
      type(label('Who’s it for?'), 'Morgan'),
      click(role('radio', { name: /^Admin/ })),
      click(role('button', { name: 'Cancel' })),
      Command.resolve(UnlockScroll, Message.CompletedUnlockScroll()),
      // NOTE: the sheet stays in the page, so it doesn't mount again.
      click(role('button', { name: 'Invite Someone' })),
      Command.resolve(LockScroll, Message.CompletedLockScroll()),
      expect(label('Who’s it for?')).toHaveValue(''),
      expect(role('radio', { name: /^Member/ })).toHaveAttr(
        'aria-checked',
        'true',
      ),
    )
  })

  test('says why a link could not be made', () => {
    scene(
      { update, view },
      given(accountModel(joshViewer, everyone)),
      ...pageShown,
      ...openInviteSomeone,
      click(role('button', { name: 'Create Link' })),
      Command.expectExact(CreateInvite({ name: '', role: 'Member' })),
      Command.resolve(
        CreateInvite,
        Message.FailedCreateInvite({
          failure: { reason: 'NotAllowed', message: 'Only admins can invite.' },
        }),
      ),
      expect(role('alert')).toHaveText('Only admins can invite.'),
      expect(role('button', { name: 'Create Link' })).toExist(),
    )
  })

  test('sends a pending invite’s link again, or revokes it', () => {
    scene(
      { update, view },
      given(accountModel(joshViewer, everyone)),
      ...pageShown,
      click(role('button', { name: 'Invite for Riley, not used yet' })),
      Command.resolve(LockScroll, Message.CompletedLockScroll()),
      sheetFollowsDrags,
      expect(role('dialog', { name: 'Invite Link' })).toExist(),
      expect(text(/Invited as a member/)).toExist(),
      expect(label('Invite link')).toHaveText(
        'joshify.example/join?code=riley1',
      ),
      click(role('button', { name: 'Revoke Invite' })),
      Command.expectExact(
        UnlockScroll(),
        ChangePeople({
          change: { _tag: 'RevokeInvite', inviteId: memberInvite.id },
        }),
      ),
      Command.resolve(UnlockScroll, Message.CompletedUnlockScroll()),
      Command.resolve(
        ChangePeople,
        Message.CompletedChangePeople({
          change: { _tag: 'RevokeInvite', inviteId: memberInvite.id },
          result: Result.succeed({ ...everyone, invites: [] }),
        }),
      ),
      expect(text('Riley')).toBeAbsent(),
    )
  })

  test('an invite from before links were kept can only be revoked', () => {
    const oldInvite: Invite = {
      ...memberInvite,
      id: 'inv-old',
      name: '',
      link: null,
    }
    scene(
      { update, view },
      given(accountModel(joshViewer, { ...everyone, invites: [oldInvite] })),
      ...pageShown,
      click(role('button', { name: 'Unnamed invite, not used yet' })),
      Command.resolve(LockScroll, Message.CompletedLockScroll()),
      sheetFollowsDrags,
      expect(text(/can’t be shown again/)).toExist(),
      expect(label('Invite link')).toBeAbsent(),
      expect(role('button', { name: 'Revoke Invite' })).toExist(),
    )
  })
})
