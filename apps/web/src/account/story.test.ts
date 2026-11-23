import { Option, Redacted, Result } from 'effect'
import { AsyncData } from 'foldkit'
import { Command, given, message, model, story } from 'foldkit/story'
import { modifyFields } from 'foldkit/struct'
import { fromString } from 'foldkit/url'
import { describe, expect, test } from 'vitest'

import { type People, type Person, type Viewer } from '@music/shared'

import { Message } from '../message'
import { type Model } from '../model'
import { WaitBeforeHideNotice } from '../playback/command'
import { peopleQuery, viewerQuery } from '../query'
import { AppRoute } from '../route'
import { initialModel, update } from '../update'
import { ChangePeople } from './command'
import {
  PasswordFormStatus,
  emptyPasswordForm,
  newPasswordProblem,
  passwordFormProblem,
} from './domain'

const FIRST_REQUEST_GENERATION = 1

const josh: Person = {
  id: 'u-josh',
  username: 'josh',
  role: 'Admin',
  isOwner: true,
  createdAt: 1,
  lastActiveAt: 2,
}

const sam: Person = {
  id: 'u-sam',
  username: 'sam',
  role: 'Member',
  isOwner: false,
  createdAt: 1,
  lastActiveAt: null,
}

const everyone: People = { people: [josh, sam], invites: [] }

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

const urlOrThrow = (raw: string) =>
  Option.getOrThrowWith(
    fromString(raw),
    () => new Error(`Failed to parse url: ${raw}`),
  )

const openAccount = message(
  Message.ChangedUrl({ url: urlOrThrow('http://localhost/account') }),
)

const viewerAnswers = (viewer: Viewer) =>
  Command.resolve(
    viewerQuery.Fetch,
    viewerQuery.Message.CompletedFetch({
      generation: FIRST_REQUEST_GENERATION,
      result: Result.succeed(viewer),
    }),
  )

const libraryModel = initialModel(AppRoute.Library(), '/library')

const loadedPeople = (current: Model): Option.Option<People> =>
  AsyncData.getData(peopleQuery.read(current.people))

const form = (current: string, next: string, confirm: string) => ({
  ...emptyPasswordForm(PasswordFormStatus.Editing()),
  current: Redacted.make(current),
  new: Redacted.make(next),
  confirm: Redacted.make(confirm),
})

describe('password checks', () => {
  test('a new password must fit the length the server allows', () => {
    expect(newPasswordProblem('1234567')).toStrictEqual(
      Option.some('The new password needs at least 8 characters.'),
    )
    expect(newPasswordProblem('12345678')).toStrictEqual(Option.none())
    expect(newPasswordProblem('x'.repeat(128))).toStrictEqual(Option.none())
    expect(newPasswordProblem('x'.repeat(129))).toStrictEqual(
      Option.some('The new password can have at most 128 characters.'),
    )
  })

  test('the form needs the current password and two matching new ones', () => {
    expect(
      passwordFormProblem(form('', 'long-enough', 'long-enough')),
    ).toStrictEqual(Option.some('Enter your current password.'))
    expect(passwordFormProblem(form('old', 'short', 'short'))).toStrictEqual(
      Option.some('The new password needs at least 8 characters.'),
    )
    expect(
      passwordFormProblem(form('old', 'long-enough', 'long-enougH')),
    ).toStrictEqual(Option.some('The new passwords don’t match.'))
    expect(
      passwordFormProblem(form('old', 'long-enough', 'long-enough')),
    ).toStrictEqual(Option.none())
  })
})

describe('loading the Account page', () => {
  test('an admin’s page goes on to load the people and invites', () => {
    story(
      update,
      given(libraryModel),
      openAccount,
      Command.expectExact(
        viewerQuery.Fetch({ generation: FIRST_REQUEST_GENERATION }),
      ),
      viewerAnswers(joshViewer),
      Command.expectExact(
        peopleQuery.Fetch({ generation: FIRST_REQUEST_GENERATION }),
      ),
      Command.resolve(
        peopleQuery.Fetch,
        peopleQuery.Message.CompletedFetch({
          generation: FIRST_REQUEST_GENERATION,
          result: Result.succeed(everyone),
        }),
      ),
      model(current => {
        expect(loadedPeople(current)).toStrictEqual(Option.some(everyone))
      }),
    )
  })

  test('a member’s page never asks for the people', () => {
    story(
      update,
      given(libraryModel),
      openAccount,
      viewerAnswers(samViewer),
      Command.expectNone(),
      model(current => {
        expect(AsyncData.isIdle(peopleQuery.read(current.people))).toBe(true)
      }),
    )
  })

  test('a guest’s page never asks for the people', () => {
    story(
      update,
      given(libraryModel),
      openAccount,
      viewerAnswers({ _tag: 'Guest' }),
      Command.expectNone(),
    )
  })
})

describe('changing people', () => {
  const adminPage = modifyFields(initialModel(AppRoute.Account(), '/account'), {
    viewer: query =>
      modifyFields(query, { data: () => AsyncData.succeed(joshViewer) }),
    people: query =>
      modifyFields(query, { data: () => AsyncData.succeed(everyone) }),
  })

  test('a refusal says why, and checks the list again', () => {
    story(
      update,
      given(adminPage),
      message(Message.ConfirmedRemovePerson({ userId: josh.id })),
      Command.expectExact(
        ChangePeople({ change: { _tag: 'RemovePerson', userId: josh.id } }),
      ),
      Command.resolve(
        ChangePeople,
        Message.CompletedChangePeople({
          change: { _tag: 'RemovePerson', userId: josh.id },
          result: Result.fail({
            reason: 'Owner',
            message: 'The owner can’t be removed.',
          }),
        }),
      ),
      model(current => {
        expect(current.maybeNotice).toStrictEqual(
          Option.some('The owner can’t be removed.'),
        )
        expect(loadedPeople(current)).toStrictEqual(Option.some(everyone))
      }),
      Command.expectExact(
        WaitBeforeHideNotice({ message: 'The owner can’t be removed.' }),
        peopleQuery.Fetch({ generation: FIRST_REQUEST_GENERATION }),
      ),
      Command.resolve(
        WaitBeforeHideNotice,
        Message.CompletedWaitBeforeHideNotice({
          message: 'The owner can’t be removed.',
        }),
      ),
      Command.resolve(
        peopleQuery.Fetch,
        peopleQuery.Message.CompletedFetch({
          generation: FIRST_REQUEST_GENERATION,
          result: Result.succeed(everyone),
        }),
      ),
    )
  })
})
