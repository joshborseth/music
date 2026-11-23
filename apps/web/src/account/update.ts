import { Match, Option, Redacted, Result } from 'effect'
import { AsyncData, Update } from 'foldkit'
import { modifyFields } from 'foldkit/struct'

import {
  type AccountRole,
  type CreatedInvite,
  type People,
  type Viewer,
} from '@music/shared'

import { Message } from '../message'
import { type Model } from '../model'
import { type PlaybackServices } from '../playback/resource'
import { receiveNotice } from '../playback/update'
import { peopleQuery, viewerQuery } from '../query'
import { type MusicClient } from '../rpc'
import {
  ChangePassword,
  ChangePeople,
  CopyInviteLink,
  CreateInvite,
  FocusResetPasswordInput,
  ResetPassword,
} from './command'
import {
  type AccountFailure,
  type AccountPage,
  type NewInviteForm,
  NewInviteStatus,
  type PasswordField,
  type PasswordForm,
  PasswordFormStatus,
  type PeopleChange,
  type Secret,
  emptyNewInviteForm,
  emptyPasswordForm,
  emptyResetPasswordForm,
  isAdmin,
  newPasswordProblem,
  passwordFormProblem,
} from './domain'

type AccountReturn = Update.Return<
  Model,
  Message,
  MusicClient | PlaybackServices
>
type AccountStep = Update.Step<Model, Message, MusicClient | PlaybackServices>

// QUERIES

export const viewer = viewerQuery.lift<Model, Message>({
  parentField: 'viewer',
  toParentMessage: message => Message.GotViewerMessage({ message }),
})

export const people = peopleQuery.lift<Model, Message>({
  parentField: 'people',
  toParentMessage: message => Message.GotPeopleMessage({ message }),
})

const loadedViewer = (model: Model): Option.Option<Viewer> =>
  AsyncData.getData(viewerQuery.read(model.viewer))

const isAdminViewer = (model: Model): boolean =>
  Option.exists(loadedViewer(model), isAdmin)

/** Takes the people as the server now has them, over any load in flight. */
const withPeople = (model: Model, fresh: People): Model =>
  modifyFields(model, {
    people: query =>
      modifyFields(query, { data: () => AsyncData.succeed(fresh) }),
  })

/**
 * The Account page checks who is using the app, and for an admin already
 * known to be one, the people and invites.
 */
export const loadAccount: AccountStep = Update.combine([
  model => viewer.revalidateOrLoad(model),
  model => (isAdminViewer(model) ? people.revalidateOrLoad(model) : { model }),
])

/** Once an admin is known to be on the Account page, it lists the people. */
export const gotViewerMessage =
  (message: typeof viewerQuery.Message.Type): AccountStep =>
  model =>
    Update.combine([
      (stepModel: Model) => viewer.fold(stepModel, message),
      stepModel =>
        stepModel.route._tag === 'Account' && isAdminViewer(stepModel)
          ? people.loadIfMissing(stepModel)
          : { model: stepModel },
    ])(model)

const mapAccount = (
  model: Model,
  change: (page: AccountPage) => AccountPage,
): Model => modifyFields(model, { account: change })

const showFailure = (model: Model, failure: AccountFailure): AccountReturn =>
  receiveNotice(model, failure.message)

// CHANGE PASSWORD

const mapPasswordForm = (
  model: Model,
  change: (form: PasswordForm) => PasswordForm,
): Model =>
  mapAccount(model, page => modifyFields(page, { passwordForm: change }))

const withPasswordField = (
  form: PasswordForm,
  field: PasswordField,
  value: Secret,
): PasswordForm =>
  Match.value(field).pipe(
    Match.withReturnType<PasswordForm>(),
    Match.when('Current', () => modifyFields(form, { current: () => value })),
    Match.when('New', () => modifyFields(form, { new: () => value })),
    Match.when('Confirm', () => modifyFields(form, { confirm: () => value })),
    Match.exhaustive,
  )

/** Typing again puts away what the last attempt said, unless it is sending. */
export const updatePasswordField = (
  model: Model,
  field: PasswordField,
  value: Secret,
): AccountReturn => ({
  model: mapPasswordForm(model, form =>
    modifyFields(withPasswordField(form, field, value), {
      status: status =>
        status._tag === 'Saving' ? status : PasswordFormStatus.Editing(),
    }),
  ),
})

/** Checks the form first, so only a password the server would take is sent. */
export const submitChangePassword = (model: Model): AccountReturn => {
  const form = model.account.passwordForm
  if (form.status._tag === 'Saving') {
    return { model }
  }
  return Option.match(passwordFormProblem(form), {
    onSome: (message): AccountReturn => ({
      model: mapPasswordForm(model, current =>
        modifyFields(current, {
          status: () => PasswordFormStatus.Rejected({ message }),
        }),
      ),
    }),
    onNone: (): AccountReturn => ({
      model: mapPasswordForm(model, current =>
        modifyFields(current, { status: () => PasswordFormStatus.Saving() }),
      ),
      commands: [
        ChangePassword({
          currentPassword: form.current,
          newPassword: form.new,
        }),
      ],
    }),
  })
}

export const succeedChangePassword = (model: Model): AccountReturn => ({
  model: mapPasswordForm(model, () =>
    emptyPasswordForm(PasswordFormStatus.Saved()),
  ),
})

export const failChangePassword = (
  model: Model,
  failure: AccountFailure,
): AccountReturn => ({
  model: mapPasswordForm(model, form =>
    modifyFields(form, {
      status: () => PasswordFormStatus.Rejected({ message: failure.message }),
    }),
  ),
})

// INVITES

const mapNewInvite = (
  model: Model,
  change: (form: NewInviteForm) => NewInviteForm,
): Model => mapAccount(model, page => modifyFields(page, { newInvite: change }))

/** Invite Someone starts from a blank form, unless a link is being made. */
export const startNewInvite = (model: Model): AccountReturn => ({
  model: mapNewInvite(model, form =>
    form.status._tag === 'Creating' ? form : emptyNewInviteForm(),
  ),
})

/** Changing the form puts away what the last attempt said. */
const editNewInvite = (
  model: Model,
  change: (form: NewInviteForm) => NewInviteForm,
): AccountReturn => ({
  model: mapNewInvite(model, form =>
    form.status._tag === 'Creating'
      ? form
      : modifyFields(change(form), { status: () => NewInviteStatus.Editing() }),
  ),
})

export const updateInviteName = (model: Model, name: string): AccountReturn =>
  editNewInvite(model, form => modifyFields(form, { name: () => name }))

export const selectInviteRole = (
  model: Model,
  role: AccountRole,
): AccountReturn =>
  editNewInvite(model, form => modifyFields(form, { role: () => role }))

export const createInvite = (model: Model): AccountReturn => {
  const form = model.account.newInvite
  return form.status._tag === 'Creating'
    ? { model }
    : {
        model: mapNewInvite(model, current =>
          modifyFields(current, { status: () => NewInviteStatus.Creating() }),
        ),
        commands: [CreateInvite({ name: form.name.trim(), role: form.role })],
      }
}

/** The new invite joins the list, and the form is ready for the next one. */
export const succeedCreateInvite = (
  model: Model,
  created: CreatedInvite,
): AccountReturn => ({
  model: withPeople(mapNewInvite(model, emptyNewInviteForm), created.people),
})

export const failCreateInvite = (
  model: Model,
  failure: AccountFailure,
): AccountReturn => ({
  model: mapNewInvite(model, form =>
    modifyFields(form, {
      status: () => NewInviteStatus.Failed({ message: failure.message }),
    }),
  ),
})

export const copyInviteLink = (model: Model, link: string): AccountReturn => ({
  model,
  commands: [CopyInviteLink({ link })],
})

export const completeCopyInviteLink = (
  model: Model,
  isCopied: boolean,
): AccountReturn =>
  receiveNotice(
    model,
    isCopied ? 'Link copied' : 'Couldn’t copy the link. Select it instead.',
  )

// PEOPLE

export const changePeople = (
  model: Model,
  change: PeopleChange,
): AccountReturn => ({ model, commands: [ChangePeople({ change })] })

export const completeChangePeople = (
  model: Model,
  result: Result.Result<People, AccountFailure>,
): AccountReturn =>
  Result.match(result, {
    onSuccess: (fresh): AccountReturn => ({ model: withPeople(model, fresh) }),
    onFailure: (failure): AccountReturn =>
      Update.combine([
        (stepModel: Model) => showFailure(stepModel, failure),
        stepModel => people.revalidateOrLoad(stepModel),
      ])(model),
  })

// RESET PASSWORD

const withResetPassword = (
  model: Model,
  change: (form: AccountPage['resetPassword']) => AccountPage['resetPassword'],
): Model =>
  mapAccount(model, page => modifyFields(page, { resetPassword: change }))

/** The sheet opens empty, ready to type in. */
export const startResetPassword = (model: Model): AccountReturn => ({
  model: withResetPassword(model, emptyResetPasswordForm),
  commands: [FocusResetPasswordInput()],
})

export const updateResetPasswordInput = (
  model: Model,
  value: Secret,
): AccountReturn => ({
  model: withResetPassword(model, () => ({
    input: value,
    maybeProblem: Option.none(),
  })),
})

/** What stops the new password in the Reset Password sheet, if anything. */
export const resetPasswordProblem = (model: Model): Option.Option<string> =>
  newPasswordProblem(Redacted.value(model.account.resetPassword.input))

export const rejectResetPassword = (
  model: Model,
  problem: string,
): AccountReturn => ({
  model: withResetPassword(model, form =>
    modifyFields(form, { maybeProblem: () => Option.some(problem) }),
  ),
})

export const resetPassword = (
  model: Model,
  userId: string,
  username: string,
): AccountReturn => ({
  model: withResetPassword(model, emptyResetPasswordForm),
  commands: [
    ResetPassword({
      userId,
      username,
      password: model.account.resetPassword.input,
    }),
  ],
})

export const succeedResetPassword = (
  model: Model,
  username: string,
): AccountReturn =>
  receiveNotice(model, `New password set. ${username} was signed out.`)

export const failResetPassword = (
  model: Model,
  failure: AccountFailure,
): AccountReturn => showFailure(model, failure)
