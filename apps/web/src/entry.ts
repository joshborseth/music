import { Runtime } from 'foldkit'

import { Message } from './message'
import { Model } from './model'
import { managedResources } from './playback/resource'
import { subscriptions } from './playback/subscription'
import { MusicClientLive } from './rpc'
import { init, update } from './update'
import { view } from './view'
import { viewTransition } from './viewTransition'

const application = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  subscriptions,
  viewTransition,
  managedResources,
  resources: MusicClientLive,
  container: document.getElementById('root'),
  devTools: {
    Message,
  },
  routing: {
    onUrlRequest: request => Message.ClickedLink({ request }),
    onUrlChange: url => Message.ChangedUrl({ url }),
  },
})

// NOTE: the app starts in a task of its own, once every module has run, so
// a cold start is two shorter tasks the browser can breathe between rather
// than one long one. The page has nothing to show before then anyway.
setTimeout(() => Runtime.run(application), 0)
