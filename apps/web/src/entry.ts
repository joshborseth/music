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

Runtime.run(application)
