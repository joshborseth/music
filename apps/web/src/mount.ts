import { Effect, Option, Queue, Schema, Stream } from 'effect'
import { Mount } from 'foldkit'

import { PAGE_SELECTOR, TITLE_BAR_SELECTOR } from './constant'
import { Message } from './message'
import {
  type RowSlot,
  beforeEntryIdAfterMove,
  dropIndex,
  rowShift,
  settleOffset,
} from './playback/reorder'

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
      // NOTE: the page is new, so it already sits at the top. Scrolling it
      // there anyway would make the browser lay out the whole app at once,
      // mid-render, which on a cold start is the costliest part of booting.
      if (top > 0) {
        element.scrollTo({ top, behavior: 'instant' })
      }
      return Message.CompletedRestoreScroll()
    }),
})

// TITLE BAR

/**
 * Fades a detail page's nav bar title in as the page's own title slides under
 * the bar, rather than at a fixed scroll distance that suits only some heroes.
 * Mounted on the title, it measures again whenever the title changes size or
 * the window does.
 */
export const SyncTitleBarReveal = Mount.defineStream('SyncTitleBarReveal', {
  messages: [Message.CompletedSyncTitleBarReveal],
  execute: ({ element }) =>
    Stream.callback<typeof Message.CompletedSyncTitleBarReveal.Type>(queue =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const maybeWindow = element.ownerDocument.defaultView

          const placeReveal = () => {
            const maybePage = element.closest(PAGE_SELECTOR)
            if (maybePage === null) {
              return
            }

            const maybeBar = maybePage.querySelector(TITLE_BAR_SELECTOR)
            if (!(maybeBar instanceof HTMLElement)) {
              return
            }

            const title = element.getBoundingClientRect()
            const barHeight = maybeBar.offsetHeight
            const revealEnd = Math.max(
              1,
              title.bottom + maybePage.scrollTop - barHeight,
            )
            const revealStart = Math.min(
              revealEnd - 1,
              Math.max(0, title.top + maybePage.scrollTop - barHeight),
            )

            maybeBar.style.setProperty('--reveal-start', `${revealStart}px`)
            maybeBar.style.setProperty('--reveal-end', `${revealEnd}px`)
          }

          // NOTE: no first measure here: a ResizeObserver reports every
          // element it starts watching once the page is laid out, before it
          // is painted, so measuring now would only force an early layout.
          const observer = new ResizeObserver(placeReveal)
          observer.observe(element)
          maybeWindow?.addEventListener('resize', placeReveal)
          Queue.offerUnsafe(queue, Message.CompletedSyncTitleBarReveal())

          return () => {
            observer.disconnect()
            maybeWindow?.removeEventListener('resize', placeReveal)
          }
        }),
        stopSyncing => Effect.sync(stopSyncing),
      ).pipe(Effect.flatMap(() => Effect.never)),
    ),
})

// MARQUEE

/** Space between the end of the text and its copy coming around again. */
const MARQUEE_GAP_PX = 48

const MARQUEE_SPEED_PX_PER_SECOND = 30

/** The share of each loop spent resting at the start, as in `@keyframes marquee`. */
const MARQUEE_REST_SHARE = 0.3

const MARQUEE_TEXT_SELECTOR = '.marquee-text'

/**
 * Lets one line of text scroll sideways when it is too long to fit (see
 * `.marquee` in styles.css). It marks the element `data-overflowing` and
 * sets how far and how long the text travels, and measures again whenever
 * the text or the space for it changes size, so a new song's title gets
 * its own.
 */
export const Marquee = Mount.defineStream('Marquee', {
  messages: [Message.CompletedSyncMarquee],
  execute: ({ element }) =>
    Stream.callback<typeof Message.CompletedSyncMarquee.Type>(queue =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const maybeText = element.querySelector(MARQUEE_TEXT_SELECTOR)

          const measure = () => {
            if (
              !(maybeText instanceof HTMLElement) ||
              !(element instanceof HTMLElement)
            ) {
              return
            }
            const textWidth = maybeText.offsetWidth
            if (textWidth - element.clientWidth > 1) {
              const distance = textWidth + MARQUEE_GAP_PX
              const seconds =
                distance /
                MARQUEE_SPEED_PX_PER_SECOND /
                (1 - MARQUEE_REST_SHARE)
              element.style.setProperty('--marquee-distance', `${distance}px`)
              element.style.setProperty('--marquee-duration', `${seconds}s`)
              element.setAttribute('data-overflowing', '')
            } else {
              element.removeAttribute('data-overflowing')
            }
          }

          // NOTE: the observer's first report, after layout and before
          // paint, is the first measure; see `SyncTitleBarReveal`.
          const observer = new ResizeObserver(measure)
          observer.observe(element)
          if (maybeText instanceof HTMLElement) {
            observer.observe(maybeText)
          }
          Queue.offerUnsafe(queue, Message.CompletedSyncMarquee())

          return () => observer.disconnect()
        }),
        stopMeasuring => Effect.sync(stopMeasuring),
      ).pipe(Effect.flatMap(() => Effect.never)),
    ),
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

// QUEUE DRAGS

const QUEUE_ROW_SELECTOR = '[data-queue-entry]'
const REORDER_HANDLE_SELECTOR = '[data-reorder-handle]'

/** How long the other rows take to slide out of the dragged row's way. */
const ROW_MAKE_WAY_MS = 220

/** How long a let-go row takes to settle into the gap made for it. */
const ROW_SETTLE_MS = 160

const ROW_EASING = 'cubic-bezier(0.2, 0, 0, 1)'

/** How long a row takes to lift off the list when its handle is pressed. */
const ROW_LIFT_MS = 150

/** How much bigger a lifted row is, so it reads as floating over the rows it passes. */
const ROW_LIFT_SCALE = '1.03'

/** A row dragged this close to the scroll area's top or bottom scrolls it. */
const AUTO_SCROLL_EDGE_PX = 64

const AUTO_SCROLL_MAX_PX_PER_FRAME = 12

/**
 * A let-go row waits this long for the list to come back in its new order
 * before sliding back, in case the move was refused.
 */
const DROP_TIMEOUT_MS = 1000

interface QueueDrag {
  readonly pointerId: number
  readonly rows: ReadonlyArray<HTMLElement>
  readonly slots: ReadonlyArray<RowSlot>
  readonly from: number
  readonly startY: number
  readonly startScrollTop: number
  readonly maybeScroller: HTMLElement | null
  clientY: number
  to: number
}

const queueRows = (list: HTMLElement): ReadonlyArray<HTMLElement> =>
  Array.from(list.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.matches(QUEUE_ROW_SELECTOR),
  )

const translateY = (offset: number): string =>
  offset === 0 ? '' : `translate3d(0, ${offset}px, 0)`

/** Scroll speed for a finger `inside` px from an edge of the scroll area. */
const edgeSpeed = (inside: number): number =>
  inside >= AUTO_SCROLL_EDGE_PX
    ? 0
    : AUTO_SCROLL_MAX_PX_PER_FRAME *
      Math.min(
        1,
        (AUTO_SCROLL_EDGE_PX - Math.max(0, inside)) / AUTO_SCROLL_EDGE_PX,
      )

/**
 * Lets a queue row be dragged up or down by its handle, the way Apple Music
 * does: the row follows the finger, the rows it passes slide out of its way,
 * and near the top or bottom the queue scrolls along. Let go, the row settles
 * into the gap and `onMove` reports where it went; the list re-rendered in
 * its new order then takes over from the inline offsets. The handle's press
 * never reaches the row's own swipe.
 */
const followQueueDrags = (
  list: HTMLElement,
  onMove: (entryId: string, maybeBeforeEntryId: Option.Option<string>) => void,
) => {
  const maybeWindow = list.ownerDocument.defaultView
  const prefersLessMotion =
    maybeWindow?.matchMedia('(prefers-reduced-motion: reduce)').matches ?? false
  const makeWay = prefersLessMotion
    ? 'none'
    : `transform ${ROW_MAKE_WAY_MS}ms ${ROW_EASING}`
  const lift = prefersLessMotion
    ? 'none'
    : `scale ${ROW_LIFT_MS}ms ${ROW_EASING}`
  let maybeDrag: QueueDrag | undefined
  let settlingRows: ReadonlyArray<HTMLElement> = []
  let maybeFrame: number | undefined
  let maybeTimer: ReturnType<typeof setTimeout> | undefined

  const clearRows = (rows: ReadonlyArray<HTMLElement>) =>
    rows.forEach(row => {
      row.style.transition = ''
      row.style.transform = ''
      row.style.scale = ''
      row.removeAttribute('data-dragging')
    })

  /** Every row back in its own place: slid there, or at once. */
  const restoreRows = (
    rows: ReadonlyArray<HTMLElement>,
    isAnimated: boolean,
  ) => {
    clearTimeout(maybeTimer)
    if (!isAnimated || prefersLessMotion) {
      clearRows(rows)
      settlingRows = []
      return
    }
    rows.forEach(row => {
      row.style.transition = makeWay
      row.style.transform = ''
      row.style.scale = ''
    })
    settlingRows = rows
    maybeTimer = setTimeout(() => {
      clearRows(rows)
      settlingRows = []
    }, ROW_MAKE_WAY_MS)
  }

  const stopAutoScroll = () => {
    if (maybeFrame !== undefined) {
      cancelAnimationFrame(maybeFrame)
      maybeFrame = undefined
    }
  }

  const draggedOffset = (drag: QueueDrag): number => {
    const scrolled =
      (drag.maybeScroller?.scrollTop ?? drag.startScrollTop) -
      drag.startScrollTop
    const moving = drag.slots[drag.from]
    const first = drag.slots[0]
    const last = drag.slots[drag.slots.length - 1]
    if (moving === undefined || first === undefined || last === undefined) {
      return 0
    }
    return Math.min(
      last.top + last.height - (moving.top + moving.height),
      Math.max(first.top - moving.top, drag.clientY - drag.startY + scrolled),
    )
  }

  const follow = (drag: QueueDrag) => {
    const moving = drag.slots[drag.from]
    if (moving === undefined) {
      return
    }
    const offset = draggedOffset(drag)
    drag.to = dropIndex(
      drag.slots,
      drag.from,
      moving.top + moving.height / 2 + offset,
    )
    drag.rows.forEach((row, index) => {
      row.style.transform = translateY(
        index === drag.from
          ? offset
          : rowShift(index, drag.from, drag.to, moving.height),
      )
    })
  }

  const autoScroll = () => {
    maybeFrame = undefined
    const drag = maybeDrag
    if (drag === undefined || drag.maybeScroller === null) {
      return
    }
    const scroller = drag.maybeScroller
    const bounds = scroller.getBoundingClientRect()
    const speed =
      edgeSpeed(bounds.bottom - drag.clientY) -
      edgeSpeed(drag.clientY - bounds.top)
    if (speed === 0) {
      return
    }
    const before = scroller.scrollTop
    scroller.scrollTop = before + speed
    if (scroller.scrollTop !== before) {
      follow(drag)
    }
    maybeFrame = requestAnimationFrame(autoScroll)
  }

  const handlePointerDown = (event: PointerEvent) => {
    const maybeHandle =
      event.target instanceof Element
        ? event.target.closest(REORDER_HANDLE_SELECTOR)
        : null
    if (maybeHandle === null || !list.contains(maybeHandle)) {
      return
    }
    // NOTE: the row under the handle swipes to remove; a press on the
    // handle only ever drags.
    event.stopPropagation()
    if (
      maybeDrag !== undefined ||
      settlingRows.length > 0 ||
      event.button !== 0
    ) {
      return
    }
    const rows = queueRows(list)
    const from = rows.findIndex(row => row.contains(maybeHandle))
    const row = rows[from]
    if (row === undefined) {
      return
    }
    event.preventDefault()
    list.setPointerCapture(event.pointerId)
    const maybeScroller = list.closest(SCROLL_AREA_SELECTOR)
    const scroller = maybeScroller instanceof HTMLElement ? maybeScroller : null
    maybeDrag = {
      pointerId: event.pointerId,
      rows,
      slots: rows.map(each => ({
        top: each.offsetTop,
        height: each.offsetHeight,
      })),
      from,
      startY: event.clientY,
      startScrollTop: scroller?.scrollTop ?? 0,
      maybeScroller: scroller,
      clientY: event.clientY,
      to: from,
    }
    // NOTE: the lifted row follows the finger with no transition on its
    // transform; only its growth, a separate `scale`, eases in.
    rows.forEach(each => {
      each.style.transition = each === row ? lift : makeWay
    })
    row.style.scale = ROW_LIFT_SCALE
    row.setAttribute('data-dragging', '')
  }

  const handlePointerMove = (event: PointerEvent) => {
    const drag = maybeDrag
    if (drag === undefined || event.pointerId !== drag.pointerId) {
      return
    }
    drag.clientY = event.clientY
    follow(drag)
    if (maybeFrame === undefined) {
      maybeFrame = requestAnimationFrame(autoScroll)
    }
  }

  const handlePointerUp = (event: PointerEvent) => {
    const drag = maybeDrag
    if (drag === undefined || event.pointerId !== drag.pointerId) {
      return
    }
    maybeDrag = undefined
    stopAutoScroll()
    const row = drag.rows[drag.from]
    const maybeEntryId = row?.dataset['queueEntry']
    if (
      row === undefined ||
      maybeEntryId === undefined ||
      drag.to === drag.from
    ) {
      restoreRows(drag.rows, true)
      return
    }
    const entryId = maybeEntryId
    const maybeBeforeEntryId = beforeEntryIdAfterMove(
      drag.rows.map(each => each.dataset['queueEntry'] ?? ''),
      drag.from,
      drag.to,
    )
    row.style.transition = prefersLessMotion
      ? 'none'
      : `transform ${ROW_SETTLE_MS}ms ${ROW_EASING}, scale ${ROW_SETTLE_MS}ms ${ROW_EASING}`
    row.style.transform = translateY(
      settleOffset(drag.slots, drag.from, drag.to),
    )
    row.style.scale = ''
    settlingRows = drag.rows
    maybeTimer = setTimeout(
      () => {
        maybeTimer = setTimeout(
          () => restoreRows(drag.rows, true),
          DROP_TIMEOUT_MS,
        )
        onMove(entryId, maybeBeforeEntryId)
      },
      prefersLessMotion ? 0 : ROW_SETTLE_MS,
    )
  }

  const handlePointerCancel = (event: PointerEvent) => {
    const drag = maybeDrag
    if (drag === undefined || event.pointerId !== drag.pointerId) {
      return
    }
    maybeDrag = undefined
    stopAutoScroll()
    restoreRows(drag.rows, true)
  }

  // NOTE: the list re-rendered in its new order puts each row where its
  // offset was showing it, so the offsets go at once, before the next paint.
  // A list that changes mid-drag (a song ends, autoplay adds more) ends it.
  const observer = new MutationObserver(() => {
    const drag = maybeDrag
    if (drag !== undefined) {
      maybeDrag = undefined
      stopAutoScroll()
      restoreRows(drag.rows, true)
    } else if (settlingRows.length > 0) {
      restoreRows(settlingRows, false)
    }
  })
  observer.observe(list, { childList: true })

  list.addEventListener('pointerdown', handlePointerDown, { capture: true })
  list.addEventListener('pointermove', handlePointerMove)
  list.addEventListener('pointerup', handlePointerUp)
  list.addEventListener('pointercancel', handlePointerCancel)
  list.addEventListener('lostpointercapture', handlePointerCancel)

  return () => {
    observer.disconnect()
    list.removeEventListener('pointerdown', handlePointerDown, {
      capture: true,
    })
    list.removeEventListener('pointermove', handlePointerMove)
    list.removeEventListener('pointerup', handlePointerUp)
    list.removeEventListener('pointercancel', handlePointerCancel)
    list.removeEventListener('lostpointercapture', handlePointerCancel)
    stopAutoScroll()
    clearTimeout(maybeTimer)
    clearRows(queueRows(list))
  }
}

type QueueDragMessage =
  | typeof Message.CompletedFollowQueueDrags.Type
  | typeof Message.DraggedQueueEntry.Type

/**
 * Reorders the queue list it is mounted on by its rows' handles; see
 * `followQueueDrags`. It reports once when it starts, then once per move.
 */
export const FollowQueueDrags = Mount.defineStream('FollowQueueDrags', {
  messages: [Message.CompletedFollowQueueDrags, Message.DraggedQueueEntry],
  execute: ({ element }) =>
    Stream.callback<QueueDragMessage>(queue =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const stopFollowing =
            element instanceof HTMLElement
              ? followQueueDrags(element, (entryId, maybeBeforeEntryId) =>
                  Queue.offerUnsafe(
                    queue,
                    Message.DraggedQueueEntry({ entryId, maybeBeforeEntryId }),
                  ),
                )
              : () => {}
          Queue.offerUnsafe(queue, Message.CompletedFollowQueueDrags())
          return stopFollowing
        }),
        stopFollowing => Effect.sync(stopFollowing),
      ).pipe(Effect.flatMap(() => Effect.never)),
    ),
})

// RANGE DRAGS

const RANGE_INPUT_SELECTOR = 'input[type="range"]'

/** What a drag on a range bar reports, in the input's own whole units. */
interface RangeDrag {
  readonly moved: (value: number) => void
  readonly released: (value: number) => void
  readonly cancelled: () => void
}

/** The whole unit under `clientX` on the bar's range input, if it has a length. */
const valueAt = (area: HTMLElement, clientX: number): number | undefined => {
  const input = area.querySelector(RANGE_INPUT_SELECTOR)
  if (!(input instanceof HTMLInputElement)) {
    return undefined
  }
  const max = Number(input.max)
  const rect = input.getBoundingClientRect()
  if (!(max > 0) || rect.width <= 0) {
    return undefined
  }
  const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  return Math.round(fraction * max)
}

/**
 * Lets a finger land anywhere on a range bar (the seek bar) and drag, jumping the thumb under it. iOS only drags a native
 * range input by its thumb, so the input itself ignores pointers and keeps
 * keyboard and screen reader use.
 */
const followRangeDrags = (area: HTMLElement, drag: RangeDrag) => {
  let maybePointerId: number | undefined
  let value = 0

  const handlePointerDown = (event: PointerEvent) => {
    if (maybePointerId !== undefined || event.button !== 0) {
      return
    }
    const maybeValue = valueAt(area, event.clientX)
    if (maybeValue === undefined) {
      return
    }
    event.preventDefault()
    area.setPointerCapture(event.pointerId)
    maybePointerId = event.pointerId
    value = maybeValue
    drag.moved(value)
  }

  const handlePointerMove = (event: PointerEvent) => {
    if (event.pointerId !== maybePointerId) {
      return
    }
    const maybeValue = valueAt(area, event.clientX)
    if (maybeValue !== undefined && maybeValue !== value) {
      value = maybeValue
      drag.moved(value)
    }
  }

  const handlePointerUp = (event: PointerEvent) => {
    if (event.pointerId !== maybePointerId) {
      return
    }
    maybePointerId = undefined
    drag.released(value)
  }

  const handlePointerCancel = (event: PointerEvent) => {
    if (event.pointerId !== maybePointerId) {
      return
    }
    maybePointerId = undefined
    drag.cancelled()
  }

  area.addEventListener('pointerdown', handlePointerDown)
  area.addEventListener('pointermove', handlePointerMove)
  area.addEventListener('pointerup', handlePointerUp)
  area.addEventListener('pointercancel', handlePointerCancel)
  area.addEventListener('lostpointercapture', handlePointerCancel)

  return () => {
    area.removeEventListener('pointerdown', handlePointerDown)
    area.removeEventListener('pointermove', handlePointerMove)
    area.removeEventListener('pointerup', handlePointerUp)
    area.removeEventListener('pointercancel', handlePointerCancel)
    area.removeEventListener('lostpointercapture', handlePointerCancel)
  }
}

/** Follow range drags on `element` until the Mount ends, after `started`. */
const rangeDragStream = <M>(
  element: Element,
  started: M,
  toDrag: (emit: (message: M) => void) => RangeDrag,
) =>
  Stream.callback<M>(queue =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const stopFollowing =
          element instanceof HTMLElement
            ? followRangeDrags(
                element,
                toDrag(message => Queue.offerUnsafe(queue, message)),
              )
            : () => {}
        Queue.offerUnsafe(queue, started)
        return stopFollowing
      }),
      stopFollowing => Effect.sync(stopFollowing),
    ).pipe(Effect.flatMap(() => Effect.never)),
  )

// SEEK BAR

type SeekBarMessage =
  | typeof Message.CompletedFollowSeekBarDrags.Type
  | typeof Message.UpdatedScrubPosition.Type
  | typeof Message.ChangedSeekPosition.Type
  | typeof Message.CancelledScrub.Type

/** Scrubs and seeks from pointer drags on the element it is mounted on. */
export const FollowSeekBarDrags = Mount.defineStream('FollowSeekBarDrags', {
  messages: [
    Message.CompletedFollowSeekBarDrags,
    Message.UpdatedScrubPosition,
    Message.ChangedSeekPosition,
    Message.CancelledScrub,
  ],
  execute: ({ element }) =>
    rangeDragStream<SeekBarMessage>(
      element,
      Message.CompletedFollowSeekBarDrags(),
      emit => ({
        moved: seconds => emit(Message.UpdatedScrubPosition({ seconds })),
        released: seconds => emit(Message.ChangedSeekPosition({ seconds })),
        cancelled: () => emit(Message.CancelledScrub()),
      }),
    ),
})

// LYRICS

/** Where the active line sits, as a fraction of the panel's height. */
const LYRICS_ANCHOR = 0.3

/** After a finger or wheel moves the lyrics, they stay put this long. */
const LYRICS_BROWSE_MS = 3500

const LYRIC_GLIDE_MS = 720
const LYRIC_STAGGER_MS = 45
const LYRIC_GLIDE_EASING = 'cubic-bezier(0.2, 0.9, 0.25, 1.06)'

const LYRIC_ROW_SELECTOR = '[data-lyric-row]'
const ACTIVE_LYRIC_SELECTOR = '[data-lyric-row][data-state="active"]'
const CUTTABLE_LYRIC_SELECTOR = '[data-lyric-row], [data-lyrics-source]'
const CUT_LYRIC_ATTRIBUTE = 'data-cut'

/** How far a line may overhang the panel's edge and still count as whole. */
const CUT_TOLERANCE_PX = 1

/**
 * Keeps the line being sung near the top of the lyrics panel. When it moves
 * on, the panel jumps to the new line and every row glides from where it
 * was, the rows above first and the rows below a beat later, so the lines
 * ripple up like a wave. A finger on the panel pauses this while the lyrics
 * are read, and marks the panel `data-browsing` so every line brightens.
 * Wherever it settles, it marks the rows the panel's edges cut through
 * `data-cut`, which hides them, so no line shows sliced in half.
 */
const followLyrics = (scroller: HTMLElement) => {
  const maybeWindow = scroller.ownerDocument.defaultView
  const prefersLessMotion =
    maybeWindow?.matchMedia('(prefers-reduced-motion: reduce)').matches ?? false
  let isBrowsing = false
  let maybeActiveRow: Element | null = null
  let maybeFrame: number | undefined
  let maybeBrowseTimer: ReturnType<typeof setTimeout> | undefined

  const targetTop = (row: HTMLElement): number => {
    const scrollerTop = scroller.getBoundingClientRect().top
    const rowTop = row.getBoundingClientRect().top - scrollerTop
    const top =
      scroller.scrollTop + rowTop - scroller.clientHeight * LYRICS_ANCHOR
    return Math.max(
      0,
      Math.min(top, scroller.scrollHeight - scroller.clientHeight),
    )
  }

  const glideTo = (row: HTMLElement) => {
    const rows = Array.from(
      scroller.querySelectorAll(LYRIC_ROW_SELECTOR),
    ).filter(element => element instanceof HTMLElement)
    const before = rows.map(element => element.getBoundingClientRect().top)
    rows.forEach(element =>
      element.getAnimations().forEach(animation => animation.cancel()),
    )
    scroller.scrollTop = targetTop(row)
    const viewTop = scroller.getBoundingClientRect().top
    const viewBottom = viewTop + scroller.clientHeight
    const firstMoving = rows.findIndex(
      element => element.getBoundingClientRect().bottom >= viewTop,
    )
    rows.forEach((element, index) => {
      const after = element.getBoundingClientRect().top
      const offset = (before[index] ?? after) - after
      const isOnScreen =
        Math.min(after, before[index] ?? after) < viewBottom &&
        Math.max(after, before[index] ?? after) + element.offsetHeight > viewTop
      if (Math.abs(offset) < 1 || !isOnScreen) {
        return
      }
      element.animate(
        [
          { transform: `translateY(${offset}px)` },
          { transform: 'translateY(0)' },
        ],
        {
          duration: LYRIC_GLIDE_MS,
          delay: Math.max(0, index - firstMoving) * LYRIC_STAGGER_MS,
          easing: LYRIC_GLIDE_EASING,
          fill: 'backwards',
        },
      )
    })
  }

  /**
   * Marks the rows the panel's edges cut through, so the panel shows only
   * whole lines while it follows the song (see `.lyrics` in styles.css). A
   * row counts by its text, not its padding, and by where it settles, not
   * where a glide has it now.
   */
  const markCutRows = () => {
    const viewTop = scroller.scrollTop
    const viewBottom = viewTop + scroller.clientHeight
    scroller.querySelectorAll(CUTTABLE_LYRIC_SELECTOR).forEach(row => {
      if (!(row instanceof HTMLElement)) {
        return
      }
      // NOTE: measured on the row itself, whose offset parent is the panel.
      // A row gliding has a transform, which makes it the offset parent of
      // what it holds.
      const style = getComputedStyle(row)
      const textTop = row.offsetTop + Number.parseFloat(style.paddingTop)
      const textBottom =
        row.offsetTop +
        row.offsetHeight -
        Number.parseFloat(style.paddingBottom)
      const isCut =
        textTop < viewTop - CUT_TOLERANCE_PX ||
        textBottom > viewBottom + CUT_TOLERANCE_PX
      row.toggleAttribute(CUT_LYRIC_ATTRIBUTE, isCut)
    })
  }

  const follow = (isGliding: boolean) => {
    const row = scroller.querySelector(ACTIVE_LYRIC_SELECTOR)
    const isNewRow = row !== maybeActiveRow
    maybeActiveRow = row
    if (isBrowsing) {
      return
    }
    if (!(row instanceof HTMLElement)) {
      markCutRows()
      return
    }
    if (isGliding && isNewRow && !prefersLessMotion) {
      glideTo(row)
    } else {
      scroller.scrollTop = targetTop(row)
    }
    markCutRows()
  }

  const scheduleFollow = () => {
    if (maybeFrame !== undefined) {
      return
    }
    maybeFrame = requestAnimationFrame(() => {
      maybeFrame = undefined
      follow(true)
    })
  }

  const browse = () => {
    isBrowsing = true
    scroller.setAttribute('data-browsing', '')
    clearTimeout(maybeBrowseTimer)
    maybeBrowseTimer = setTimeout(() => {
      isBrowsing = false
      scroller.removeAttribute('data-browsing')
      maybeActiveRow = null
      follow(true)
    }, LYRICS_BROWSE_MS)
  }

  const observer = new MutationObserver(scheduleFollow)
  observer.observe(scroller, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-state'],
  })
  const resizeObserver = new ResizeObserver(() => follow(false))
  resizeObserver.observe(scroller)
  scroller.addEventListener('touchstart', browse, { passive: true })
  scroller.addEventListener('touchmove', browse, { passive: true })
  scroller.addEventListener('wheel', browse, { passive: true })
  follow(false)

  return () => {
    observer.disconnect()
    resizeObserver.disconnect()
    scroller.removeEventListener('touchstart', browse)
    scroller.removeEventListener('touchmove', browse)
    scroller.removeEventListener('wheel', browse)
    clearTimeout(maybeBrowseTimer)
    if (maybeFrame !== undefined) {
      cancelAnimationFrame(maybeFrame)
    }
  }
}

/** Keeps timed lyrics following the song; see `followLyrics`. */
export const FollowLyrics = Mount.defineStream('FollowLyrics', {
  messages: [Message.CompletedFollowLyrics],
  execute: ({ element }) =>
    Stream.callback<typeof Message.CompletedFollowLyrics.Type>(queue =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const stopFollowing =
            element instanceof HTMLElement ? followLyrics(element) : () => {}
          Queue.offerUnsafe(queue, Message.CompletedFollowLyrics())
          return stopFollowing
        }),
        stopFollowing => Effect.sync(stopFollowing),
      ).pipe(Effect.flatMap(() => Effect.never)),
    ),
})
