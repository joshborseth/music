import { Effect, Queue, Schema, Stream } from 'effect'
import { Mount } from 'foldkit'

import { Message } from './message'

// SCROLL

/**
 * Scrolls a page to where it was left, or to the top for a new page. It runs
 * as the page enters the DOM, inside any page transition, so the new page is
 * already in place when it slides in.
 */
export const RestoreScroll = Mount.define('RestoreScroll', {
  args: { top: Schema.Number },
  messages: [Message.CompletedRestoreScroll],
  execute: ({ element, top }) =>
    Effect.sync(() => {
      element.ownerDocument.defaultView?.scrollTo({ top, behavior: 'instant' })
      return Message.CompletedRestoreScroll()
    }),
})

// DRAG TO DISMISS

/** How far down a sheet must be pulled to close when let go. */
const DISMISS_DISTANCE_PX = 120

/** A flick at least this fast closes the sheet however short it was. */
const DISMISS_VELOCITY_PX_PER_MS = 0.5

/** Movement before a touch counts as a drag rather than a tap. */
const DRAG_SLOP_PX = 6

/** Pulling up past the top meets this much resistance. */
const OVERSCROLL_RESISTANCE = 0.2

const SCROLL_AREA_SELECTOR = '[data-sheet-scroll]'
const NO_DRAG_SELECTOR = 'input[type="range"], [data-no-drag]'
const BACKDROP_SELECTOR = '[data-sheet-backdrop]'

type DragState = {
  isEligible: boolean
  isDragging: boolean
  startX: number
  startY: number
  offset: number
  lastY: number
  lastTime: number
  velocity: number
}

const isAtTopOfScrollArea = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) {
    return true
  }
  const scrollArea = target.closest(SCROLL_AREA_SELECTOR)
  return scrollArea === null || scrollArea.scrollTop <= 0
}

const startsOnControl = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest(NO_DRAG_SELECTOR) !== null

/**
 * Lets a sheet follow the finger down and close when pulled far or flicked,
 * the way native sheets do. The sheet's CSS owns its open and closed
 * positions; during a drag this only sets an inline offset on top of them.
 */
const followDrags = (sheet: HTMLElement, onDismiss: () => void) => {
  const state: DragState = {
    isEligible: false,
    isDragging: false,
    startX: 0,
    startY: 0,
    offset: 0,
    lastY: 0,
    lastTime: 0,
    velocity: 0,
  }

  const backdrop = (): HTMLElement | null => {
    const sibling = sheet.parentElement?.querySelector(BACKDROP_SELECTOR)
    return sibling instanceof HTMLElement ? sibling : null
  }

  const setOffset = (offset: number) => {
    state.offset = offset
    sheet.style.transform = `translate3d(0, ${offset}px, 0)`
    const maybeBackdrop = backdrop()
    if (maybeBackdrop !== null) {
      const progress = Math.min(1, Math.max(0, offset) / sheet.offsetHeight)
      maybeBackdrop.style.opacity = String(1 - progress)
    }
  }

  const clearInlineStyles = () => {
    sheet.style.transition = ''
    sheet.style.transform = ''
    const maybeBackdrop = backdrop()
    if (maybeBackdrop !== null) {
      maybeBackdrop.style.transition = ''
      maybeBackdrop.style.opacity = ''
    }
  }

  const handleTouchStart = (event: TouchEvent) => {
    const touch = event.touches[0]
    if (event.touches.length !== 1 || touch === undefined) {
      state.isEligible = false
      return
    }
    state.isEligible =
      !startsOnControl(event.target) && isAtTopOfScrollArea(event.target)
    state.isDragging = false
    state.startX = touch.clientX
    state.startY = touch.clientY
    state.lastY = touch.clientY
    state.lastTime = event.timeStamp
    state.velocity = 0
  }

  const handleTouchMove = (event: TouchEvent) => {
    const touch = event.touches[0]
    if (!state.isEligible || touch === undefined) {
      return
    }
    const deltaY = touch.clientY - state.startY
    const deltaX = touch.clientX - state.startX
    if (!state.isDragging) {
      if (deltaY > DRAG_SLOP_PX && deltaY > Math.abs(deltaX)) {
        state.isDragging = true
        sheet.style.transition = 'none'
        const maybeBackdrop = backdrop()
        if (maybeBackdrop !== null) {
          maybeBackdrop.style.transition = 'none'
        }
      } else if (deltaY < -DRAG_SLOP_PX || Math.abs(deltaX) > DRAG_SLOP_PX) {
        state.isEligible = false
        return
      } else {
        return
      }
    }
    event.preventDefault()
    const elapsed = event.timeStamp - state.lastTime
    if (elapsed > 0) {
      state.velocity = (touch.clientY - state.lastY) / elapsed
    }
    state.lastY = touch.clientY
    state.lastTime = event.timeStamp
    setOffset(deltaY > 0 ? deltaY : deltaY * OVERSCROLL_RESISTANCE)
  }

  const handleTouchEnd = () => {
    if (!state.isDragging) {
      return
    }
    state.isDragging = false
    state.isEligible = false
    sheet.style.transition = ''
    const maybeBackdrop = backdrop()
    if (maybeBackdrop !== null) {
      maybeBackdrop.style.transition = ''
    }
    const isDismissed =
      state.offset > DISMISS_DISTANCE_PX ||
      state.velocity > DISMISS_VELOCITY_PX_PER_MS
    if (isDismissed) {
      sheet.style.transform = 'translate3d(0, 100%, 0)'
      if (maybeBackdrop !== null) {
        maybeBackdrop.style.opacity = '0'
      }
      sheet.addEventListener('transitionend', clearInlineStyles, {
        once: true,
      })
      onDismiss()
    } else {
      sheet.style.transform = ''
      if (maybeBackdrop !== null) {
        maybeBackdrop.style.opacity = ''
      }
    }
  }

  sheet.addEventListener('touchstart', handleTouchStart, { passive: true })
  sheet.addEventListener('touchmove', handleTouchMove, { passive: false })
  sheet.addEventListener('touchend', handleTouchEnd)
  sheet.addEventListener('touchcancel', handleTouchEnd)

  return () => {
    sheet.removeEventListener('touchstart', handleTouchStart)
    sheet.removeEventListener('touchmove', handleTouchMove)
    sheet.removeEventListener('touchend', handleTouchEnd)
    sheet.removeEventListener('touchcancel', handleTouchEnd)
    clearInlineStyles()
  }
}

export const DraggableSheet = Schema.Literals(['Player', 'ActionSheet'])
export type DraggableSheet = typeof DraggableSheet.Type

type SheetDragMessage =
  | typeof Message.CompletedFollowSheetDrags.Type
  | typeof Message.SwipedDownPlayer.Type
  | typeof Message.SwipedDownSheet.Type

const dismissMessage = (sheet: DraggableSheet): SheetDragMessage =>
  sheet === 'Player' ? Message.SwipedDownPlayer() : Message.SwipedDownSheet()

/**
 * Closes the sheet this is mounted on when it is pulled down. It reports once
 * when it starts following drags, then once per dismissal.
 */
export const DragToDismiss = Mount.defineStream('DragToDismiss', {
  args: { sheet: DraggableSheet },
  messages: [
    Message.CompletedFollowSheetDrags,
    Message.SwipedDownPlayer,
    Message.SwipedDownSheet,
  ],
  execute: ({ element, sheet }) =>
    Stream.callback<SheetDragMessage>(queue =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const stopFollowing =
            element instanceof HTMLElement
              ? followDrags(element, () =>
                  Queue.offerUnsafe(queue, dismissMessage(sheet)),
                )
              : () => {}
          Queue.offerUnsafe(queue, Message.CompletedFollowSheetDrags())
          return stopFollowing
        }),
        stopFollowing => Effect.sync(stopFollowing),
      ).pipe(Effect.flatMap(() => Effect.never)),
    ),
})
