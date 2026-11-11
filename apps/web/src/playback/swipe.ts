import { Match, Option, Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

import { Song } from '@music/shared'

// MODEL

/** What a finger can swipe, and what each one needs to act on release. */
export const SwipeTarget = defineTaggedUnion({
  MiniPlayer: {},
  PlayerArtwork: {},
  SongRow: { song: Song },
  QueueEntry: { entryId: Schema.String },
})
export type SwipeTarget = typeof SwipeTarget.Type

const SwipeAxis = Schema.Literals(['Undecided', 'Horizontal', 'Vertical'])
type SwipeAxis = typeof SwipeAxis.Type

/** The one swipe in progress, if any. Distances are in CSS pixels, times in ms. */
export const Swipe = defineTaggedUnion({
  Idle: {},
  Tracking: {
    target: SwipeTarget,
    pointerId: Schema.Number,
    originX: Schema.Number,
    originY: Schema.Number,
    deltaX: Schema.Number,
    deltaY: Schema.Number,
    axis: SwipeAxis,
    velocityX: Schema.Number,
    velocityY: Schema.Number,
    movedAt: Schema.Number,
  },
})
export type Swipe = typeof Swipe.Type
export type TrackingSwipe = typeof Swipe.Tracking.Type

/** What a finished swipe asks playback to do. */
export const SwipeAction = defineTaggedUnion({
  Next: {},
  Previous: {},
  ClosePlayer: {},
  PlayNext: { song: Song },
  AddToQueue: { song: Song },
  RemoveEntry: { entryId: Schema.String },
})
export type SwipeAction = typeof SwipeAction.Type

// CONSTANTS

/** How far a finger moves before the swipe picks a direction. */
const AXIS_LOCK_DISTANCE = 10

/** The shortest swipe that acts. */
export const ACTION_DISTANCE = 72

/** A quick flick acts from this far. */
const FLICK_DISTANCE = 32

/** How fast a flick moves when the finger lifts, in px/ms. */
const FLICK_VELOCITY = 0.35

/** A finger that rests this long before lifting is no longer flicking. */
const FLICK_WINDOW_MS = 100

/** How much of each new pointer sample goes into the velocity. */
const VELOCITY_SMOOTHING = 0.7

/** How far a row slides before it stops following the finger. */
export const MAX_ROW_REVEAL = 150

// TRANSITIONS

const allowsAxis = (target: SwipeTarget, axis: SwipeAxis): boolean =>
  axis !== 'Vertical' || target._tag === 'PlayerArtwork'

const lockAxis = (
  axis: SwipeAxis,
  deltaX: number,
  deltaY: number,
): SwipeAxis => {
  if (axis !== 'Undecided') {
    return axis
  } else if (
    Math.max(Math.abs(deltaX), Math.abs(deltaY)) < AXIS_LOCK_DISTANCE
  ) {
    return 'Undecided'
  } else if (Math.abs(deltaX) > Math.abs(deltaY)) {
    return 'Horizontal'
  } else {
    return 'Vertical'
  }
}

const smoothVelocity = (
  previous: number,
  distance: number,
  elapsedMs: number,
): number =>
  elapsedMs > 0
    ? previous * (1 - VELOCITY_SMOOTHING) +
      (distance / elapsedMs) * VELOCITY_SMOOTHING
    : previous

/** A finger landed on something swipeable. */
export const startSwipe = (
  target: SwipeTarget,
  pointerId: number,
  clientX: number,
  clientY: number,
  timeStamp: number,
): Swipe =>
  Swipe.Tracking({
    target,
    pointerId,
    originX: clientX,
    originY: clientY,
    deltaX: 0,
    deltaY: 0,
    axis: 'Undecided',
    velocityX: 0,
    velocityY: 0,
    movedAt: timeStamp,
  })

/**
 * The finger moved. A swipe that turns out to go a way its target does not
 * use ends here, so the page scrolls instead.
 */
export const moveSwipe = (
  swipe: TrackingSwipe,
  clientX: number,
  clientY: number,
  timeStamp: number,
): Swipe => {
  const deltaX = clientX - swipe.originX
  const deltaY = clientY - swipe.originY
  const axis = lockAxis(swipe.axis, deltaX, deltaY)

  if (!allowsAxis(swipe.target, axis)) {
    return Swipe.Idle()
  }

  const elapsedMs = timeStamp - swipe.movedAt
  return Swipe.Tracking({
    target: swipe.target,
    pointerId: swipe.pointerId,
    originX: swipe.originX,
    originY: swipe.originY,
    deltaX,
    deltaY,
    axis,
    velocityX: smoothVelocity(
      swipe.velocityX,
      deltaX - swipe.deltaX,
      elapsedMs,
    ),
    velocityY: smoothVelocity(
      swipe.velocityY,
      deltaY - swipe.deltaY,
      elapsedMs,
    ),
    movedAt: timeStamp,
  })
}

const isCommitted = (
  distance: number,
  velocity: number,
  isFlicking: boolean,
): boolean => {
  const velocityTowardDistance = Math.sign(distance) * velocity
  return (
    Math.abs(distance) >= ACTION_DISTANCE ||
    (Math.abs(distance) >= FLICK_DISTANCE &&
      isFlicking &&
      velocityTowardDistance >= FLICK_VELOCITY)
  )
}

const horizontalAction = (
  target: SwipeTarget,
  isLeft: boolean,
): Option.Option<SwipeAction> =>
  SwipeTarget.match(target, {
    MiniPlayer: () =>
      Option.some(isLeft ? SwipeAction.Next() : SwipeAction.Previous()),
    PlayerArtwork: () =>
      Option.some(isLeft ? SwipeAction.Next() : SwipeAction.Previous()),
    SongRow: ({ song }) =>
      Option.some(
        isLeft
          ? SwipeAction.PlayNext({ song })
          : SwipeAction.AddToQueue({ song }),
      ),
    QueueEntry: ({ entryId }) =>
      isLeft
        ? Option.some(SwipeAction.RemoveEntry({ entryId }))
        : Option.none(),
  })

/** What the swipe does now that the finger has lifted at `timeStamp`. */
export const releasedSwipeAction = (
  swipe: TrackingSwipe,
  timeStamp: number,
): Option.Option<SwipeAction> => {
  const isFlicking = timeStamp - swipe.movedAt <= FLICK_WINDOW_MS
  return Match.value(swipe.axis).pipe(
    Match.withReturnType<Option.Option<SwipeAction>>(),
    Match.when('Horizontal', () =>
      isCommitted(swipe.deltaX, swipe.velocityX, isFlicking)
        ? horizontalAction(swipe.target, swipe.deltaX < 0)
        : Option.none(),
    ),
    Match.when('Vertical', () =>
      swipe.target._tag === 'PlayerArtwork' &&
      swipe.deltaY > 0 &&
      isCommitted(swipe.deltaY, swipe.velocityY, isFlicking)
        ? Option.some(SwipeAction.ClosePlayer())
        : Option.none(),
    ),
    Match.when('Undecided', () => Option.none()),
    Match.exhaustive,
  )
}

// VIEW HELPERS

/** The swipe in progress on this target, if it is the one being swiped. */
export const swipeOn = (
  swipe: Swipe,
  isTarget: (target: SwipeTarget) => boolean,
): Option.Option<TrackingSwipe> =>
  swipe._tag === 'Tracking' &&
  swipe.axis !== 'Undecided' &&
  isTarget(swipe.target)
    ? Option.some(swipe)
    : Option.none()

/** Whether letting go now would act, so the view can say so. */
export const isArmed = (swipe: TrackingSwipe): boolean =>
  swipe.axis === 'Vertical'
    ? swipe.deltaY >= ACTION_DISTANCE
    : Math.abs(swipe.deltaX) >= ACTION_DISTANCE
