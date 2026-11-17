/**
 * Pure, testable bulk-input parser for teacher bulk-add.
 *
 * Format per line: `{Thầy|Cô} Tên | Môn | Tổ`
 *   - Title prefix required (Thầy / Cô, case-insensitive).
 *   - Subject (after first `|`) and department (after second `|`) are optional.
 *
 * Lines without a recognised prefix or name are reported in `invalidLines` using
 * the line numbers shown in the textarea (blank lines are counted but ignored).
 * At most 100 items are returned; `overLimit` counts valid lines beyond that.
 */

import type { Title } from '../../../shared/honorific.ts'

export type ParsedItem = { name: string; subject?: string; department?: string; title: Title }

export type ParseResult = {
  items: ParsedItem[]
  invalidLines: number[]
  overLimit: number
}

export const MAX_BULK_ITEMS = 100

const PREFIXES: ReadonlyArray<[string, Title]> = [['thầy ', 'Thầy'], ['cô ', 'Cô']]

export function parseBulkInput(raw: string): ParseResult {
  const items: ParsedItem[] = []
  const invalidLines: number[] = []
  let overLimit = 0

  const lines = raw.normalize('NFC').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    // Split on pipes to get: [title+name, subject?, department?]
    const parts = line.split('|').map((s) => s.trim())
    const namePart = parts[0] ?? ''
    const subject = parts[1] ? parts[1] : undefined
    const department = parts[2] ? parts[2] : undefined

    const lower = namePart.toLowerCase()
    const match = PREFIXES.find(([prefix]) => lower.startsWith(prefix))
    const name = match ? namePart.slice(match[0].length).trim() : ''
    if (!match || !name) {
      invalidLines.push(i + 1)
      continue
    }

    if (items.length === MAX_BULK_ITEMS) {
      overLimit++
      continue
    }
    items.push({
      name,
      title: match[1],
      ...(subject ? { subject } : {}),
      ...(department ? { department } : {}),
    })
  }

  return { items, invalidLines, overLimit }
}
