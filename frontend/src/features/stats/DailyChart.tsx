import { useState } from 'react'
import { dayMonthLabel, fullDayLabel } from '@/features/calendar/dates'
import { formatDuration, formatShort } from './format'
import { niceTicks, tickLabel, type Column, type Series } from './chartData'

const width = 360
const height = 200
const margin = { top: 14, right: 8, bottom: 22, left: 40 }
const plotW = width - margin.left - margin.right
const plotH = height - margin.top - margin.bottom
const maxBar = 24
const gap = 2
const maxLabeledColumns = 7

interface DailyChartProps {
  columns: readonly Column[]
  series: readonly Series[]
}

/** A column's date as a short caption: "14 окт." or "12 – 18 окт." for a week. */
function columnTitle(column: Column): string {
  if (!column.endDate) return fullDayLabel(column.date)
  return `${dayMonthLabel(column.date)} – ${dayMonthLabel(column.endDate)}`
}

/** Path of a bar with only the top corners rounded; the base stays on the axis. */
function topRounded(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h)
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`
}

/**
 * Stacked columns of the hours per day (or per week for a long period), one segment per
 * category. Hover or focus a column for its numbers; the same numbers are in the table.
 */
export function DailyChart({ columns, series }: DailyChartProps) {
  const [active, setActive] = useState<number | null>(null)
  const seriesById = new Map(series.map((s) => [s.id, s]))

  const peak = columns.reduce((m, c) => Math.max(m, c.total), 0)
  const { ticks, max } = niceTicks(peak)
  const y = (minutes: number) => margin.top + plotH - (minutes / max) * plotH

  const slot = plotW / Math.max(columns.length, 1)
  const barW = Math.max(2, Math.min(maxBar, slot - gap))
  // Label the x axis so that captions never touch: about one per 36px.
  const every = Math.max(1, Math.ceil(36 / slot))
  const labelValues = columns.length <= maxLabeledColumns

  const shown = active === null ? null : columns[active]
  const activeX = active === null ? 0 : margin.left + slot * active + slot / 2

  return (
    <div className="relative" data-testid="daily-chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        role="img"
        aria-label="Часы по дням, по категориям"
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={margin.left}
              x2={width - margin.right}
              y1={y(t)}
              y2={y(t)}
              stroke="var(--app-separator)"
              strokeWidth={t === 0 ? 1 : 0.5}
            />
            <text
              x={margin.left - 6}
              y={y(t)}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize="10"
              fill="var(--app-hint)"
            >
              {tickLabel(t)}
            </text>
          </g>
        ))}

        {columns.map((column, i) => {
          const x = margin.left + slot * i + (slot - barW) / 2
          let top = 0
          const lastIndex = column.segments.length - 1
          return (
            <g key={column.date}>
              {column.segments.map((segment, k) => {
                const s = seriesById.get(segment.seriesId)
                const h = (segment.minutes / max) * plotH
                const yTop = y(top + segment.minutes)
                top += segment.minutes
                if (h <= 0) return null
                // Segments are separated by a 2px gap of the page color, drawn as an inset.
                const inset = k === 0 ? 0 : gap / 2
                const drawH = Math.max(h - inset, 0.5)
                return k === lastIndex ? (
                  <path
                    key={segment.seriesId}
                    d={topRounded(x, yTop + inset, barW, drawH, 4)}
                    fill={s?.color}
                    opacity={active === null || active === i ? 1 : 0.55}
                  />
                ) : (
                  <rect
                    key={segment.seriesId}
                    x={x}
                    y={yTop + inset}
                    width={barW}
                    height={drawH}
                    fill={s?.color}
                    opacity={active === null || active === i ? 1 : 0.55}
                  />
                )
              })}
              {labelValues && column.total > 0 && (
                <text
                  x={x + barW / 2}
                  y={y(column.total) - 4}
                  textAnchor="middle"
                  fontSize="10"
                  fill="var(--app-fg)"
                >
                  {formatShort(column.total)}
                </text>
              )}
              {i % every === 0 && (
                <text
                  x={margin.left + slot * i + slot / 2}
                  y={height - 6}
                  textAnchor="middle"
                  fontSize="10"
                  fill="var(--app-hint)"
                >
                  {column.endDate ? dayMonthLabel(column.date) : column.date.slice(8)}
                </text>
              )}
            </g>
          )
        })}

        {/* Hit areas: the whole slot, taller than the bar. */}
        {columns.map((column, i) => (
          <rect
            key={column.date}
            x={margin.left + slot * i}
            y={margin.top}
            width={slot}
            height={plotH}
            fill="transparent"
            tabIndex={0}
            role="img"
            aria-label={`${columnTitle(column)}: ${formatDuration(column.total)}`}
            data-column={column.date}
            onMouseEnter={() => setActive(i)}
            onMouseLeave={() => setActive(null)}
            onFocus={() => setActive(i)}
            onBlur={() => setActive(null)}
            onClick={() => setActive(active === i ? null : i)}
          />
        ))}
      </svg>

      {shown && (
        <div
          role="status"
          data-testid="chart-tooltip"
          className="pointer-events-none absolute top-full z-10 mt-1 w-44 rounded-xl bg-surface p-2 text-xs shadow-lg"
          style={{
            left: `${Math.min(Math.max((activeX / width) * 100, 25), 75)}%`,
            transform: 'translateX(-50%)',
          }}
        >
          <p className="font-medium">{columnTitle(shown)}</p>
          <p>Всего: {formatDuration(shown.total)}</p>
          {shown.busy !== shown.total && (
            <p className="text-hint">Без наложений: {formatDuration(shown.busy)}</p>
          )}
          <ul className="mt-1 space-y-0.5">
            {shown.segments.map((segment) => {
              const s = seriesById.get(segment.seriesId)
              return (
                <li key={segment.seriesId} className="flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="size-2 shrink-0 rounded-sm"
                    style={{ background: s?.color }}
                  />
                  <span className="min-w-0 flex-1 truncate">{s?.name}</span>
                  <span>{formatDuration(segment.minutes)}</span>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

/** The legend under the chart; it is what identifies the colors. */
export function ChartLegend({ series }: { series: readonly Series[] }) {
  if (series.length < 2) return null
  return (
    <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs" aria-label="Категории на графике">
      {series.map((s) => (
        <li key={s.id} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="size-2.5 rounded-sm"
            style={{ background: s.color }}
          />
          {s.name}
        </li>
      ))}
    </ul>
  )
}

/** The same numbers as a table: for reading exactly and for screen readers. */
export function ChartTable({
  columns,
  series,
}: {
  columns: readonly Column[]
  series: readonly Series[]
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs" data-testid="chart-table">
        <thead>
          <tr className="text-hint">
            <th className="py-1 pr-2 font-normal">Дата</th>
            {series.map((s) => (
              <th key={s.id} className="px-1 py-1 font-normal">
                {s.name}
              </th>
            ))}
            <th className="py-1 pl-2 text-right font-normal">Всего</th>
          </tr>
        </thead>
        <tbody>
          {columns.map((column) => (
            <tr key={column.date} className="border-t border-separator">
              <td className="py-1 pr-2 whitespace-nowrap">{columnTitle(column)}</td>
              {series.map((s) => {
                const minutes = column.segments.find((x) => x.seriesId === s.id)?.minutes
                return (
                  <td key={s.id} className="px-1 py-1">
                    {minutes ? formatShort(minutes) : '—'}
                  </td>
                )
              })}
              <td className="py-1 pl-2 text-right font-medium">{formatShort(column.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
