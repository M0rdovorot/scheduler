/** "2 ч 30 мин", "45 мин", "3 ч", "0 мин". */
export function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0) return `${m} мин`
  return m === 0 ? `${h} ч` : `${h} ч ${m} мин`
}

/** A compact length for a chart label: "2,5 ч", "45 мин", "3 ч". */
export function formatShort(minutes: number): string {
  const total = Math.round(minutes)
  if (total < 60) return `${total} мин`
  const hours = total / 60
  const text = Number.isInteger(hours) ? String(hours) : hours.toFixed(1).replace('.', ',')
  return `${text} ч`
}
