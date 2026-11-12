import { Effect, Queue, Schema, Stream } from 'effect'
import { Mount } from 'foldkit'

import { PAGE_SELECTOR, TITLE_BAR_SELECTOR } from './constant'
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
      element.scrollTo({ top, behavior: 'instant' })
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

          placeReveal()
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

/**
 * Keeps the line being sung near the top of the lyrics panel. When it moves
 * on, the panel jumps to the new line and every row glides from where it
 * was, the rows above first and the rows below a beat later, so the lines
 * ripple up like a wave. A finger on the panel pauses this while the lyrics
 * are read, and marks the panel `data-browsing` so every line brightens.
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

  const follow = (isGliding: boolean) => {
    const row = scroller.querySelector(ACTIVE_LYRIC_SELECTOR)
    const isNewRow = row !== maybeActiveRow
    maybeActiveRow = row
    if (!(row instanceof HTMLElement) || isBrowsing) {
      return
    }
    if (isGliding && isNewRow && !prefersLessMotion) {
      glideTo(row)
    } else {
      scroller.scrollTop = targetTop(row)
    }
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
