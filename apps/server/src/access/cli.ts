import { Option } from 'effect'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { formatCode, makeAccessStore, openAccessDatabase } from './store.ts'

/*
 * Invites for the app's public address (`gate.ts`):
 *
 *   bun run access invite <name>   a code and a link for someone (a new code
 *                                  for a name already invited replaces it;
 *                                  devices already signed in stay signed in)
 *   bun run access revoke <name>   signs every device of theirs out
 *   bun run access list            who is invited, their devices, last seen
 *
 * Run it from apps/server. It opens the same file as the server
 * (`ACCESS_DB_PATH`) and builds links on `PUBLIC_ORIGIN`.
 */

const DEFAULT_ORIGIN = 'https://joshify.tail76a394.ts.net'

const file =
  process.env['ACCESS_DB_PATH'] ??
  join(homedir(), '.local', 'share', 'music', 'access.sqlite')
const origin = process.env['PUBLIC_ORIGIN'] ?? DEFAULT_ORIGIN

const usage = (): never => {
  console.error('Usage: bun run access invite|revoke <name> | list')
  process.exit(2)
}

const [command, ...rest] = process.argv.slice(2)
const name = rest.join(' ').trim()
const db = openAccessDatabase(file)
const store = makeAccessStore(db, Date.now)

const date = (time: number) => new Date(time).toISOString().slice(0, 16)

switch (command) {
  case 'invite': {
    if (name === '') usage()
    const code = formatCode(store.invite(name))
    console.log(`Invited ${name}.`)
    console.log(`  Code: ${code}`)
    console.log(`  Link: ${origin}/sign-in?code=${code}`)
    break
  }
  case 'revoke': {
    if (name === '') usage()
    console.log(
      store.revoke(name)
        ? `Revoked ${name}; their devices are signed out.`
        : `Nobody named ${name} is invited.`,
    )
    break
  }
  case 'list': {
    const invites = store.invites()
    if (invites.length === 0) console.log('Nobody is invited yet.')
    for (const invite of invites) {
      const seen = Option.match(invite.maybeLastSeen, {
        onNone: () => 'never signed in',
        onSome: time => `last seen ${date(time)}`,
      })
      console.log(
        `${invite.name}: ${invite.devices} device(s), ${seen}, invited ${date(invite.createdAt)}`,
      )
    }
    break
  }
  default:
    usage()
}
db.close()
