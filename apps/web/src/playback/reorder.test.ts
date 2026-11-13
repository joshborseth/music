import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import {
  beforeEntryIdAfterMove,
  dropIndex,
  rowShift,
  settleOffset,
} from './reorder'

const ROW = 60
/** Five rows, 60px tall, stacked from the top. */
const slots = [0, 1, 2, 3, 4].map(index => ({ top: index * ROW, height: ROW }))
/** The middle of the row at `index`, moved by `offset`. */
const middleOf = (index: number, offset: number) =>
  index * ROW + ROW / 2 + offset

describe('dragging a queue row', () => {
  test('makes room once its middle crosses into a neighbour, half a row away', () => {
    expect(dropIndex(slots, 2, middleOf(2, 0))).toBe(2)
    expect(dropIndex(slots, 2, middleOf(2, 29))).toBe(2)
    expect(dropIndex(slots, 2, middleOf(2, 30))).toBe(3)
    expect(dropIndex(slots, 2, middleOf(2, -29))).toBe(2)
    expect(dropIndex(slots, 2, middleOf(2, -30))).toBe(1)
  })

  test('lands past every row it passed, up to either end of the list', () => {
    expect(dropIndex(slots, 0, middleOf(0, 2.5 * ROW))).toBe(3)
    expect(dropIndex(slots, 4, middleOf(4, -4 * ROW))).toBe(0)
    expect(dropIndex(slots, 1, middleOf(1, 3 * ROW))).toBe(4)
  })

  test('the rows it passes slide one place out of its way', () => {
    // Dragged from 1 down to 3: rows 2 and 3 slide up.
    expect([0, 2, 3, 4].map(index => rowShift(index, 1, 3, ROW))).toEqual([
      0,
      -ROW,
      -ROW,
      0,
    ])
    // Dragged from 3 up to 1: rows 1 and 2 slide down.
    expect([0, 1, 2, 4].map(index => rowShift(index, 3, 1, ROW))).toEqual([
      0,
      ROW,
      ROW,
      0,
    ])
  })

  test('let go, it settles into the gap', () => {
    expect(settleOffset(slots, 1, 3)).toBe(2 * ROW)
    expect(settleOffset(slots, 3, 0)).toBe(-3 * ROW)
    expect(settleOffset(slots, 2, 2)).toBe(0)
  })

  test('says which song it now goes before, or none when it ends up last', () => {
    const ids = ['a', 'b', 'c', 'd']
    expect(beforeEntryIdAfterMove(ids, 3, 1)).toEqual(Option.some('b'))
    expect(beforeEntryIdAfterMove(ids, 0, 2)).toEqual(Option.some('d'))
    expect(beforeEntryIdAfterMove(ids, 0, 3)).toEqual(Option.none())
  })
})
