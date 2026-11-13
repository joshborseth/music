import { Array, Option, pipe } from 'effect'

/*
 * The geometry of dragging a queue row by its handle, kept pure so it can be
 * tested without a DOM. The `FollowQueueDrags` Mount measures the rows and
 * moves them; these say where the dragged row would land and how far each
 * other row slides out of its way.
 */

/** A row's place in its list, in CSS pixels from the list's top. */
export interface RowSlot {
  readonly top: number
  readonly height: number
}

/**
 * Where the row at `from` lands when its middle is at `draggedCenter`: a row
 * makes room once that middle crosses into it, half a row's drag, as in
 * native lists. A row held at the edge of the list takes the first or last
 * place.
 */
export const dropIndex = (
  slots: ReadonlyArray<RowSlot>,
  from: number,
  draggedCenter: number,
): number => {
  const passedAbove = pipe(
    Array.take(slots, from),
    Array.findFirstIndex(slot => draggedCenter <= slot.top + slot.height),
  )
  const passedBelow = pipe(
    Array.drop(slots, from + 1),
    Array.findLastIndex(slot => draggedCenter >= slot.top),
  )
  return Option.match(passedAbove, {
    onSome: index => index,
    onNone: () =>
      Option.match(passedBelow, {
        onSome: index => from + 1 + index,
        onNone: () => from,
      }),
  })
}

/**
 * How far the row at `index` slides while the row at `from`, `height` tall,
 * would land at `to`: down one place for rows it passed going up, up one
 * place for rows it passed going down.
 */
export const rowShift = (
  index: number,
  from: number,
  to: number,
  height: number,
): number => {
  if (index < from && index >= to) {
    return height
  } else if (index > from && index <= to) {
    return -height
  } else {
    return 0
  }
}

/**
 * How far the dragged row travels from where it was to settle at `to`, so it
 * lands where the other rows made room.
 */
export const settleOffset = (
  slots: ReadonlyArray<RowSlot>,
  from: number,
  to: number,
): number => {
  const maybeOffset = Option.flatMap(Array.get(slots, from), moving =>
    Option.map(Array.get(slots, to), target =>
      to > from
        ? target.top + target.height - (moving.top + moving.height)
        : target.top - moving.top,
    ),
  )
  return Option.getOrElse(maybeOffset, () => 0)
}

/**
 * The entry the moved one goes before, once the entry at `from` moves to
 * `to` among `entryIds`. None when it ends up last in the list.
 */
export const beforeEntryIdAfterMove = (
  entryIds: ReadonlyArray<string>,
  from: number,
  to: number,
): Option.Option<string> => Array.get(Array.remove(entryIds, from), to)
