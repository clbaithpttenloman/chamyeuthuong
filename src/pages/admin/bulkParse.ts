/**
 * Pure, testable bulk-input parser (used by BulkCreate.tsx).
 *
 * Format per line: `{Thầy|Cô} Name | Subject` (subject optional).
 * The title prefix is matched case-insensitively ('thầy', 'CÔ', …) after Unicode NFC
 * normalisation (text pasted from macOS can be decomposed) and stored as 'Thầy' or 'Cô'.
 * Lines without a recognised prefix or name are reported in `invalidLines` using the line
 * numbers shown in the textarea (blank lines are counted but ignored). At most 100 items
 * are returned; `overLimit` counts the valid lines beyond that.
 */

import type { Title } from '../../../shared/honorific.ts'

export type ParsedItem = { name: string; subject?: string; title: Title }

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

    const pipeIdx = line.indexOf('|')
    const namePart = (pipeIdx === -1 ? line : line.slice(0, pipeIdx)).trim()
    const subject = pipeIdx === -1 ? '' : line.slice(pipeIdx + 1).trim()

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
    items.push({ name, title: match[1], ...(subject ? { subject } : {}) })
  }

  return { items, invalidLines, overLimit }
}
