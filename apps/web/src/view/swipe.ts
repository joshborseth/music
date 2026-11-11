import { Option } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'
import { type IconNode } from 'lucide'

import { icon } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { Message } from '../message'
import {
  MAX_ROW_REVEAL,
  type SwipeTarget,
  type TrackingSwipe,
  isArmed,
} from '../playback/swipe'

/** Starts a swipe when a finger or pen lands here. A mouse keeps clicking and dragging as usual. */
export const onSwipeStart = (target: SwipeTarget, h: HtmlBuilder<Message>) =>
  h.OnPointerDown(
    (
      pointerType,
      _button,
      _screenX,
      _screenY,
      timeStamp,
      clientX,
      clientY,
      pointerId,
    ) =>
      pointerType === 'mouse'
        ? Option.none()
        : Option.some(
            Message.PressedSwipeable({
              target,
              pointerId,
              clientX,
              clientY,
              timeStamp,
            }),
          ),
  )

/** Eases back into place after a swipe, but follows the finger exactly during one. */
export const swipeTransitionClass = (
  maybeSwipe: Option.Option<TrackingSwipe>,
): string =>
  Option.isSome(maybeSwipe)
    ? 'transition-none'
    : 'transition-[transform,opacity] duration-200 ease-out'

export type SwipeReveal = Readonly<{
  label: string
  icon: IconNode
  isDestructive: boolean
}>

type SwipeableRowConfig = Readonly<{
  target: SwipeTarget
  maybeSwipe: Option.Option<TrackingSwipe>
  /** Shown while the row slides right, uncovering its left edge. */
  maybeRightReveal: Option.Option<SwipeReveal>
  /** Shown while the row slides left, uncovering its right edge. */
  maybeLeftReveal: Option.Option<SwipeReveal>
  /** What covers the reveal while the row slides. Defaults to the page color. */
  surfaceClass?: string
}>

const clampOffset = (config: SwipeableRowConfig, deltaX: number): number =>
  Math.min(
    Option.isSome(config.maybeRightReveal) ? MAX_ROW_REVEAL : 0,
    Math.max(
      Option.isSome(config.maybeLeftReveal) ? -MAX_ROW_REVEAL : 0,
      deltaX,
    ),
  )

const revealFor = (
  config: SwipeableRowConfig,
  offset: number,
): Option.Option<SwipeReveal> => {
  if (offset > 0) {
    return config.maybeRightReveal
  } else if (offset < 0) {
    return config.maybeLeftReveal
  } else {
    return Option.none()
  }
}

const revealPanel = (
  swipe: TrackingSwipe,
  reveal: SwipeReveal,
  isRightward: boolean,
  h: HtmlBuilder<Message>,
): Html => {
  const isActionArmed = isArmed(swipe)
  return h.div(
    [
      h.AriaHidden(true),
      h.Class(
        cn(
          'absolute inset-0 flex items-center gap-2 px-4 text-sm font-medium whitespace-nowrap transition-colors',
          isRightward ? 'justify-start' : 'justify-end',
          isActionArmed && reveal.isDestructive && 'bg-destructive text-white',
          isActionArmed &&
            !reveal.isDestructive &&
            'bg-primary text-primary-foreground',
          !isActionArmed && 'bg-muted text-muted-foreground',
        ),
      ),
    ],
    [icon(h, reveal.icon, 'size-4'), reveal.label],
  )
}

/** A list row that slides sideways under a finger to show what letting go will do. */
export const swipeableRow = (
  config: SwipeableRowConfig,
  content: Html,
  h: HtmlBuilder<Message>,
): Html => {
  const offset = Option.match(config.maybeSwipe, {
    onNone: () => 0,
    onSome: swipe => clampOffset(config, swipe.deltaX),
  })
  const maybeReveal = Option.flatMap(config.maybeSwipe, swipe =>
    Option.map(revealFor(config, offset), reveal => ({ swipe, reveal })),
  )
  return h.div(
    [h.Class('relative overflow-hidden rounded-lg')],
    [
      Option.match(maybeReveal, {
        onNone: () => h.empty,
        onSome: ({ swipe, reveal }) =>
          revealPanel(swipe, reveal, offset > 0, h),
      }),
      h.div(
        [
          onSwipeStart(config.target, h),
          h.Class(
            cn(
              'relative touch-pan-y',
              Option.isSome(config.maybeSwipe) &&
                (config.surfaceClass ?? 'bg-background'),
              swipeTransitionClass(config.maybeSwipe),
            ),
          ),
          h.Style({ transform: `translateX(${offset}px)` }),
        ],
        [content],
      ),
    ],
  )
}
