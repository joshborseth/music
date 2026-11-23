import { Array, Match, Option, Redacted } from 'effect'
import { AsyncData } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import {
  CircleAlert,
  CircleUserRound,
  Copy,
  Ellipsis,
  Share,
  Wifi,
} from 'lucide'

import { icon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  type AccountRole,
  type Invite,
  MIN_PASSWORD_LENGTH,
  type People,
  type Person,
  SIGN_OUT_PATH,
  type Viewer,
} from '@music/shared'

import {
  type AccountFailure,
  type AccountPage,
  InviteState,
  type PasswordField,
  type PasswordForm,
  PasswordFormStatus,
  type Secret,
  makeSecret,
} from '../account/domain'
import { Message } from '../message'
import { SyncTitleBarReveal } from '../mount'
import { peopleQuery, viewerQuery } from '../query'
import { accountRouter } from '../route'
import { type PageModel } from './page'
import { loadingRows, section } from './shared'

// FORMATTING

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})

/** Epoch ms → `Nov 22, 2026`, in the phone's own language. */
const formatDate = (epochMs: number): string => DATE_FORMAT.format(epochMs)

const roleName = (role: AccountRole): string =>
  role === 'Admin' ? 'Admin' : 'Member'

const lastActiveText = (person: Person): string =>
  Option.match(Option.fromNullishOr(person.lastActiveAt), {
    onNone: () => 'Not active yet',
    onSome: at => `Last active ${formatDate(at)}`,
  })

const initial = (username: string): string => username.slice(0, 1).toUpperCase()

// ENTRY POINT

/** The person button beside the Library's title, which opens Account. */
export const accountButton = (h: HtmlBuilder<Message>): Html =>
  h.a(
    [
      h.Href(accountRouter()),
      h.AriaLabel('Account'),
      h.Class(
        'text-primary mb-1 flex size-9 items-center justify-center rounded-full active:opacity-50',
      ),
    ],
    [icon(h, CircleUserRound, 'size-[26px]')],
  )

// SHARED PIECES

const cardClass = 'bg-secondary mx-4 flex flex-col rounded-xl'

const primaryButtonClass =
  'pressable bg-primary text-primary-foreground flex h-12 w-full items-center justify-center rounded-xl text-[17px] font-semibold disabled:opacity-60'

const secondaryButtonClass =
  'pressable bg-secondary text-primary flex h-12 flex-1 items-center justify-center gap-2 rounded-xl text-[17px] font-semibold'

const inputClass =
  'bg-muted placeholder:text-muted-foreground h-12 w-full rounded-xl px-4 text-[17px] outline-none'

const avatar = (
  username: string,
  className: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.span(
    [
      h.AriaHidden(true),
      h.Class(
        cn(
          'bg-primary/15 text-primary flex shrink-0 items-center justify-center rounded-full font-semibold',
          className,
        ),
      ),
    ],
    [initial(username)],
  )

const adminBadge = (h: HtmlBuilder<Message>): Html =>
  h.span(
    [
      h.Class(
        'bg-primary/15 text-primary shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold',
      ),
    ],
    ['Admin'],
  )

const quietBadge = (label: string, h: HtmlBuilder<Message>): Html =>
  h.span(
    [
      h.Class(
        'border-border text-muted-foreground shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold',
      ),
    ],
    [label],
  )

const errorText = (message: string, h: HtmlBuilder<Message>): Html =>
  h.p([h.Role('alert'), h.Class('text-destructive text-[15px]')], [message])

/** The page's own error, with Retry, when it can't tell who is signed in. */
const failureAlert = (failure: AccountFailure, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Role('alert'),
      h.Class('flex flex-col items-center gap-3 px-8 py-16 text-center'),
    ],
    [
      h.span(
        [
          h.Class(
            'bg-muted text-muted-foreground flex size-14 items-center justify-center rounded-full',
          ),
        ],
        [icon(h, CircleAlert, 'size-6')],
      ),
      h.p([h.Class('text-lg font-semibold')], ['Something went wrong']),
      h.p([h.Class('text-muted-foreground text-[15px]')], [failure.message]),
      h.button(
        [
          h.Type('button'),
          h.OnClick(Message.ClickedRetry()),
          h.Class(
            'pressable bg-secondary text-primary mt-2 flex h-10 items-center rounded-full px-5 text-[15px] font-semibold',
          ),
        ],
        ['Retry'],
      ),
    ],
  )

// GUEST

const guestContent = (h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex flex-col items-center gap-2 px-10 py-12 text-center')],
    [
      h.span(
        [
          h.Class(
            'bg-muted text-muted-foreground mb-2 flex size-16 items-center justify-center rounded-full',
          ),
        ],
        [icon(h, Wifi, 'size-7')],
      ),
      h.p(
        [h.Class('text-xl font-semibold tracking-tight')],
        ['You’re a guest'],
      ),
      h.p(
        [h.Class('text-muted-foreground text-[15px] leading-relaxed')],
        [
          'On the home Wi-Fi, Joshify opens without signing in and shares the TV’s session: its queue and its library. Sign in to use your own.',
        ],
      ),
      h.button(
        [
          h.Type('button'),
          h.OnClick(Message.ClickedSignIn()),
          h.Class(cn(primaryButtonClass, 'mt-4 max-w-xs')),
        ],
        ['Sign In'],
      ),
    ],
  )

// PROFILE

const profile = (
  username: string,
  role: AccountRole,
  isOwner: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex items-center gap-4 px-4')],
    [
      avatar(username, 'size-16 text-[28px]', h),
      h.div(
        [h.Class('flex min-w-0 flex-col')],
        [
          h.p(
            [h.Class('truncate text-[22px] font-bold tracking-tight')],
            [username],
          ),
          h.p(
            [h.Class('text-muted-foreground text-[15px]')],
            [isOwner ? `${roleName(role)} · Owner` : roleName(role)],
          ),
        ],
      ),
    ],
  )

// CHANGE PASSWORD

const passwordInput = (
  config: Readonly<{
    field: PasswordField
    label: string
    autocomplete: string
    value: Secret
  }>,
  h: HtmlBuilder<Message>,
): Html => {
  const id = `password-${config.field.toLowerCase()}`
  return h.div(
    [h.Class('flex flex-col gap-1.5')],
    [
      h.label(
        [h.For(id), h.Class('text-muted-foreground text-[13px] font-medium')],
        [config.label],
      ),
      h.input([
        h.Id(id),
        h.Type('password'),
        h.Name(id),
        h.Value(Redacted.value(config.value)),
        h.Autocomplete(config.autocomplete),
        h.Attribute('autocapitalize', 'off'),
        h.Spellcheck(false),
        h.OnInput(value =>
          Message.UpdatedPasswordField({
            field: config.field,
            value: makeSecret(value),
          }),
        ),
        h.Class(inputClass),
      ]),
    ],
  )
}

const passwordStatus = (
  status: PasswordFormStatus,
  h: HtmlBuilder<Message>,
): Html =>
  PasswordFormStatus.match(status, {
    Editing: () => h.empty,
    Saving: () => h.empty,
    Saved: () =>
      h.p(
        [h.Role('status'), h.Class('text-primary text-[15px]')],
        ['Password changed. Your other devices stay signed in.'],
      ),
    Rejected: ({ message }) => errorText(message, h),
  })

const changePasswordForm = (
  username: string,
  form: PasswordForm,
  h: HtmlBuilder<Message>,
): Html => {
  const isSaving = form.status._tag === 'Saving'
  return section(
    'Change Password',
    [
      h.form(
        [
          h.OnSubmit(Message.SubmittedChangePassword()),
          h.AriaLabel('Change Password'),
          h.Class('flex flex-col gap-3 px-4'),
        ],
        [
          h.input([
            h.Type('text'),
            h.Name('username'),
            h.Value(username),
            h.Autocomplete('username'),
            h.Readonly(true),
            h.Tabindex(-1),
            h.AriaHidden(true),
            h.Class('hidden'),
          ]),
          passwordInput(
            {
              field: 'Current',
              label: 'Current password',
              autocomplete: 'current-password',
              value: form.current,
            },
            h,
          ),
          passwordInput(
            {
              field: 'New',
              label: 'New password',
              autocomplete: 'new-password',
              value: form.new,
            },
            h,
          ),
          passwordInput(
            {
              field: 'Confirm',
              label: 'Confirm new password',
              autocomplete: 'new-password',
              value: form.confirm,
            },
            h,
          ),
          h.p(
            [h.Class('text-muted-foreground text-[13px]')],
            [`At least ${MIN_PASSWORD_LENGTH} characters.`],
          ),
          passwordStatus(form.status, h),
          h.button(
            [
              h.Type('submit'),
              h.Disabled(isSaving),
              h.Class(primaryButtonClass),
            ],
            [isSaving ? 'Changing…' : 'Change Password'],
          ),
        ],
      ),
    ],
    h,
  )
}

// SIGN OUT

/** A real form post: the server clears the cookie and opens sign-in. */
const signOutForm = (h: HtmlBuilder<Message>): Html =>
  h.form(
    [h.Method('post'), h.Action(SIGN_OUT_PATH), h.Class('px-4')],
    [
      h.button(
        [
          h.Type('submit'),
          h.Class(
            'pressable bg-secondary text-destructive flex h-12 w-full items-center justify-center rounded-xl text-[17px] font-semibold',
          ),
        ],
        ['Sign Out'],
      ),
    ],
  )

// PEOPLE

const personRow = (
  person: Person,
  viewerId: string,
  h: HtmlBuilder<Message>,
): Html => {
  const isYou = person.id === viewerId
  const canManage = !person.isOwner && !isYou
  return h.keyed('li')(
    person.id,
    [h.Class('flex items-center gap-3 py-2.5 pr-2 pl-4')],
    [
      avatar(person.username, 'size-10 text-[17px]', h),
      h.div(
        [h.Class('flex min-w-0 flex-1 flex-col')],
        [
          h.div(
            [h.Class('flex min-w-0 items-center gap-1.5')],
            [
              h.span(
                [h.Class('truncate text-[17px] font-medium')],
                [person.username],
              ),
              person.role === 'Admin' ? adminBadge(h) : h.empty,
              person.isOwner ? quietBadge('Owner', h) : h.empty,
              isYou ? quietBadge('You', h) : h.empty,
            ],
          ),
          h.span(
            [h.Class('text-muted-foreground text-[13px]')],
            [lastActiveText(person)],
          ),
        ],
      ),
      canManage
        ? h.button(
            [
              h.Type('button'),
              h.OnClick(Message.ClickedPersonActions({ person })),
              h.AriaLabel(`Options for ${person.username}`),
              h.Class(
                'text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-full active:opacity-50',
              ),
            ],
            [icon(h, Ellipsis, 'size-5')],
          )
        : h.empty,
    ],
  )
}

const peopleList = (
  people: People,
  viewerId: string,
  h: HtmlBuilder<Message>,
): Html =>
  section(
    'People',
    [
      h.ul(
        [
          h.AriaLabel('People'),
          h.Class(cn(cardClass, 'divide-border divide-y')),
        ],
        Array.map(people.people, person => personRow(person, viewerId, h)),
      ),
    ],
    h,
  )

const inviteRow = (invite: Invite, h: HtmlBuilder<Message>): Html =>
  h.keyed('li')(
    invite.id,
    [h.Class('flex items-center gap-3 py-2.5 pr-2 pl-4')],
    [
      h.div(
        [h.Class('flex min-w-0 flex-1 flex-col')],
        [
          h.span(
            [h.Class('text-[17px] font-medium')],
            [`${roleName(invite.role)} invite`],
          ),
          h.span(
            [h.Class('text-muted-foreground text-[13px]')],
            [
              `Made ${formatDate(invite.createdAt)} · Expires ${formatDate(invite.expiresAt)}`,
            ],
          ),
        ],
      ),
      h.button(
        [
          h.Type('button'),
          h.OnClick(Message.ClickedRevokeInvite({ inviteId: invite.id })),
          h.AriaLabel(
            `Revoke ${roleName(invite.role)} invite made ${formatDate(invite.createdAt)}`,
          ),
          h.Class(
            'text-destructive h-10 shrink-0 rounded-full px-3 text-[15px] font-semibold active:opacity-50',
          ),
        ],
        ['Revoke'],
      ),
    ],
  )

const pendingInvites = (
  invites: ReadonlyArray<Invite>,
  h: HtmlBuilder<Message>,
): Html =>
  Array.match(invites, {
    onEmpty: () => h.empty,
    onNonEmpty: nonEmpty =>
      section(
        'Pending Invites',
        [
          h.ul(
            [
              h.AriaLabel('Pending Invites'),
              h.Class(cn(cardClass, 'divide-border divide-y')),
            ],
            Array.map(nonEmpty, invite => inviteRow(invite, h)),
          ),
        ],
        h,
      ),
  })

// INVITE SOMEONE

const ROLE_HINTS: Readonly<Record<AccountRole, string>> = {
  Member: 'Their own library and queue.',
  Admin: 'Their own library and queue, and they can invite and manage people.',
}

const roleOption = (
  role: AccountRole,
  selected: AccountRole,
  h: HtmlBuilder<Message>,
): Html => {
  const isSelected = role === selected
  return h.button(
    [
      h.Type('button'),
      h.AriaPressed(isSelected ? 'true' : 'false'),
      h.OnClick(Message.SelectedInviteRole({ role })),
      h.Class(
        cn(
          'h-9 flex-1 rounded-lg text-[15px] font-semibold transition-colors',
          isSelected
            ? 'bg-background text-foreground shadow-sm'
            : 'text-muted-foreground',
        ),
      ),
    ],
    [roleName(role)],
  )
}

const inviteForm = (account: AccountPage, h: HtmlBuilder<Message>): Html => {
  const isCreating = account.invite._tag === 'Creating'
  return h.div(
    [h.Class('flex flex-col gap-3 px-4')],
    [
      h.div(
        [
          h.Role('group'),
          h.AriaLabel('Role'),
          h.Class('bg-muted flex gap-1 rounded-xl p-1'),
        ],
        [
          roleOption('Member', account.inviteRole, h),
          roleOption('Admin', account.inviteRole, h),
        ],
      ),
      h.p(
        [h.Class('text-muted-foreground text-[13px]')],
        [ROLE_HINTS[account.inviteRole]],
      ),
      account.invite._tag === 'Failed'
        ? errorText(account.invite.message, h)
        : h.empty,
      h.button(
        [
          h.Type('button'),
          h.Disabled(isCreating),
          h.OnClick(Message.ClickedCreateInvite()),
          h.Class(primaryButtonClass),
        ],
        [isCreating ? 'Creating…' : 'Create Invite Link'],
      ),
    ],
  )
}

/** The new link, shown until Done, since its code can't be shown again. */
const createdInvite = (
  invite: Invite,
  link: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class(cn(cardClass, 'gap-3 p-4'))],
    [
      h.p(
        [h.Class('text-[17px] font-semibold')],
        [`Invite link for a new ${roleName(invite.role).toLowerCase()}`],
      ),
      h.p(
        [
          h.AriaLabel('Invite link'),
          h.Class(
            'bg-background font-mono rounded-lg px-3 py-2 text-[14px] break-all select-all',
          ),
        ],
        [link],
      ),
      h.div(
        [h.Class('flex gap-3')],
        [
          h.button(
            [
              h.Type('button'),
              h.OnClick(Message.ClickedCopyInviteLink({ link })),
              h.Class(cn(secondaryButtonClass, 'bg-background')),
            ],
            [icon(h, Copy, 'size-5'), 'Copy'],
          ),
          h.button(
            [
              h.Type('button'),
              h.OnClick(
                Message.ClickedShare({ title: 'Join Joshify', href: link }),
              ),
              h.Class(cn(secondaryButtonClass, 'bg-background')),
            ],
            [icon(h, Share, 'size-5'), 'Share'],
          ),
        ],
      ),
      h.p(
        [h.Class('text-muted-foreground text-[13px]')],
        [
          'The link works once and expires in a week. It can’t be shown again, so send it now.',
        ],
      ),
      h.button(
        [
          h.Type('button'),
          h.OnClick(Message.ClickedDismissInvite()),
          h.Class(primaryButtonClass),
        ],
        ['Done'],
      ),
    ],
  )

const inviteSection = (account: AccountPage, h: HtmlBuilder<Message>): Html =>
  section(
    'Invite Someone',
    [
      InviteState.match(account.invite, {
        Idle: () => inviteForm(account, h),
        Creating: () => inviteForm(account, h),
        Failed: () => inviteForm(account, h),
        Created: ({ invite, link }) => createdInvite(invite, link, h),
      }),
    ],
    h,
  )

/** For admins: the people with accounts, inviting someone, and open invites. */
const adminContent = (
  model: PageModel,
  viewerId: string,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => [
  AsyncData.matchData(peopleQuery.read(model.people), {
    onEmpty: () => section('People', [loadingRows(h)], h),
    onFailure: failure =>
      section(
        'People',
        [h.div([h.Class('px-4')], [errorText(failure.message, h)])],
        h,
      ),
    onData: people => peopleList(people, viewerId, h),
  }),
  inviteSection(model.account, h),
  Option.match(AsyncData.getData(peopleQuery.read(model.people)), {
    onNone: () => h.empty,
    onSome: ({ invites }) => pendingInvites(invites, h),
  }),
]

// PAGE

const signedInContent = (
  model: PageModel,
  viewer: Extract<Viewer, { _tag: 'SignedIn' }>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex flex-col gap-8')],
    [
      profile(viewer.username, viewer.role, viewer.isOwner, h),
      changePasswordForm(viewer.username, model.account.passwordForm, h),
      ...(viewer.role === 'Admin' ? adminContent(model, viewer.id, h) : []),
      signOutForm(h),
    ],
  )

const viewerContent = (
  model: PageModel,
  viewer: Viewer,
  h: HtmlBuilder<Message>,
): Html =>
  Match.valueTags(viewer, {
    SignedIn: signedIn => signedInContent(model, signedIn, h),
    Guest: () => guestContent(h),
  })

/**
 * Account: who is signed in, with Change Password and Sign Out, and for
 * admins, the people with accounts and their invites. A guest on the home
 * Wi-Fi learns whose session they share, and where to sign in.
 */
export const accountView = (model: PageModel, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex flex-col gap-6 pb-6')],
    [
      h.header(
        [h.Class('px-4 pt-[calc(var(--safe-top)+3.75rem)]')],
        [
          h.h1(
            [
              h.OnMount(SyncTitleBarReveal()),
              h.Class('text-[34px] leading-tight font-bold tracking-tight'),
            ],
            ['Account'],
          ),
        ],
      ),
      AsyncData.matchData(viewerQuery.read(model.viewer), {
        onEmpty: () => loadingRows(h),
        onFailure: failure => failureAlert(failure, h),
        onData: viewer => viewerContent(model, viewer, h),
      }),
    ],
  )
