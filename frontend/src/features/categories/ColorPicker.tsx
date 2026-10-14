import { palette } from './palette'

interface ColorPickerProps {
  value: string
  onChange: (color: string) => void
}

/** Palette swatches plus a free color input (FR-2.2). */
export function ColorPicker({ value, onChange }: ColorPickerProps) {
  const lower = value.toLowerCase()
  return (
    <div role="radiogroup" aria-label="Цвет" className="flex flex-wrap items-center gap-2">
      {palette.map((c) => (
        <button
          key={c.value}
          type="button"
          role="radio"
          aria-checked={lower === c.value}
          aria-label={c.label}
          title={c.label}
          onClick={() => onChange(c.value)}
          className="size-8 rounded-full border-2 border-transparent aria-checked:border-fg"
          style={{ backgroundColor: c.value }}
        />
      ))}
      <label className="flex items-center gap-1 text-sm text-hint">
        <input
          type="color"
          aria-label="Свой цвет"
          value={/^#[0-9a-f]{6}$/.test(lower) ? lower : '#000000'}
          onChange={(e) => onChange(e.target.value)}
          className="size-8 cursor-pointer rounded-full border-0 bg-transparent p-0"
        />
        свой
      </label>
    </div>
  )
}
