export interface LayoutItem {
  id: string
  startMin: number
  endMin: number
}

export interface Placement {
  /** Zero-based column inside the group of overlapping tasks. */
  column: number
  /** Number of columns of that group; the width of an item is 1 / columns. */
  columns: number
}

/**
 * Places overlapping tasks side by side (FR-3.3): sort by start, split into
 * groups of transitively overlapping tasks, then give each task the first column
 * that is free when it starts. Tasks that only touch (one ends when the next
 * starts) do not overlap.
 */
export function layoutColumns(items: readonly LayoutItem[]): Map<string, Placement> {
  const sorted = [...items].sort(
    (a, b) => a.startMin - b.startMin || b.endMin - a.endMin || a.id.localeCompare(b.id),
  )

  const result = new Map<string, Placement>()
  let group: { item: LayoutItem; column: number }[] = []
  let columnEnds: number[] = []
  let groupEnd = -Infinity

  const flush = () => {
    for (const { item, column } of group) {
      result.set(item.id, { column, columns: columnEnds.length })
    }
    group = []
    columnEnds = []
    groupEnd = -Infinity
  }

  for (const item of sorted) {
    if (group.length > 0 && item.startMin >= groupEnd) flush()

    let column = columnEnds.findIndex((end) => end <= item.startMin)
    if (column === -1) {
      column = columnEnds.length
      columnEnds.push(item.endMin)
    } else {
      columnEnds[column] = item.endMin
    }
    group.push({ item, column })
    groupEnd = Math.max(groupEnd, item.endMin)
  }
  flush()
  return result
}
