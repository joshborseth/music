import { Database } from 'bun:sqlite'
import { Effect, Option } from 'effect'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { JOIN_PATH } from '@music/shared'

import { INVITE_DAYS, makeAccounts } from './accounts.ts'

/*
 * Invites from this machine, for when nobody can sign in yet (the first
 * account) or the admin page is out of reach:
 *
 *   bun run access invite           a link for one new member's account
 *   bun run access invite --admin   a link for one new admin's account
 *   bun run access list             who has an account, and open invites
 *
 * The first account ever made becomes the owner, an admin, whatever its
 * invite said. Run it from apps/server. It opens the same file as the
 * server (`AUTH_DB_PATH`) and builds links on `PUBLIC_ORIGIN`.
 */

const DEFAULT_ORIGIN = 'https://joshify.tail76a394.ts.net'

const dataDir = join(homedir(), '.local', 'share', 'music')
const file = process.env['AUTH_DB_PATH'] ?? join(dataDir, 'auth.sqlite')
const origin = process.env['PUBLIC_ORIGIN'] ?? DEFAULT_ORIGIN

const usage = (): never => {
  console.error('Usage: bun run access invite [--admin] | list')
  process.exit(2)
}

const date = (time: number) => new Date(time).toISOString().slice(0, 16)

const [command, ...flags] = process.argv.slice(2)
const db = new Database(file, { create: true })
db.run('PRAGMA journal_mode = WAL')

const program = Effect.gen(function* () {
  // NOTE: invites and the account list need no session secret.
  const accounts = yield* makeAccounts(db, {
    secret: 'unused-by-this-command-unused-by-this-command',
    origin,
  })
  switch (command) {
    case 'invite': {
      const role = flags.includes('--admin') ? 'Admin' : 'Member'
      const isFirst = Option.isNone(accounts.ownerId())
      const { code } = yield* accounts.createInvite('this machine', role)
      console.log(
        isFirst
          ? 'An invite for the first account, which becomes the owner (an admin):'
          : `An invite for one ${role === 'Admin' ? 'admin' : 'member'}:`,
      )
      console.log(`  ${origin}${JOIN_PATH}?code=${code}`)
      console.log(`It works once, for ${INVITE_DAYS} days.`)
      break
    }
    case 'list': {
      const people = accounts.listAll()
      if (people.people.length === 0) console.log('Nobody has an account yet.')
      for (const person of people.people) {
        const seen =
          person.lastActiveAt === null
            ? 'never signed in'
            : `last active ${date(person.lastActiveAt)}`
        console.log(
          `${person.username}: ${person.role}${person.isOwner ? ' (owner)' : ''}, ${seen}`,
        )
      }
      for (const invite of people.invites) {
        console.log(
          `Open invite (${invite.role}) by ${invite.createdBy}, expires ${date(invite.expiresAt)}`,
        )
      }
      break
    }
    default:
      usage()
  }
})

await Effect.runPromise(program).finally(() => db.close())
