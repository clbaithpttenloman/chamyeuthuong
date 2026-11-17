/**
 * Pure, testable bulk-input parser (extracted from BulkCreate.tsx).
 *
 * Format per line: `{Thầy|Cô} Name | Subject` (subject optional).
 * The title prefix is matched case-insensitively ('thầy', 'CÔ', etc.) and
 * normalised to 'Thầy' or 'Cô'.  Lines without a recognised prefix are
 * collected in `invalidLines` (1-indexed among non-empty lines); nothing is
 * returned for those lines.
 *
 * Result is capped at 100 items (excess lines beyond the first 100 valid ones
 * are silently dropped — same as the previous single-pass behaviour).
 */

import { isTitle, type Title } from '../../../shared/honorific.ts'

export type ParsedItem = { name: string; subject?: string; title: Title }

export type ParseResult = {
  items: ParsedItem[]
  invalidLines: number[]
}

/** 'thầy ' prefix length in JS string units (characters, not bytes). */
const THAY_PREFIX = 'thầy '
/** 'cô ' prefix length. */
const CO_PREFIX = 'cô '

export function parseBulkInput(raw: string): ParseResult {
  const items: ParsedItem[] = []
  const invalidLines: number[] = []

  // Split and filter empty lines; number non-empty lines from 1.
  const nonEmpty = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  for (let i = 0; i < nonEmpty.length; i++) {
    const lineNum = i + 1
    const line = nonEmpty[i]

    const pipeIdx = line.indexOf('|')
    const namePart = (pipeIdx === -1 ? line : line.slice(0, pipeIdx)).trim()
    const subjectRaw = pipeIdx === -1 ? '' : line.slice(pipeIdx + 1).trim()

    const lower = namePart.toLowerCase()

    let title: Title | null = null
    let name = ''

    if (lower.startsWith(THAY_PREFIX)) {
      title = 'Thầy'
      name = namePart.slice(THAY_PREFIX.length).trim()
    } else if (lower.startsWith(CO_PREFIX)) {
      title = 'Cô'
      name = namePart.slice(CO_PREFIX.length).trim()
    }

    if (title === null || name.length === 0) {
      invalidLines.push(lineNum)
      continue
    }

    if (!isTitle(title)) {
      // Defensive: should never happen given the if/else above
      invalidLines.push(lineNum)
      continue
    }

    const item: ParsedItem = {
      name,
      title,
      ...(subjectRaw ? { subject: subjectRaw } : {}),
    }

    items.push(item)
    if (items.length === 100) break
  }

  return { items, invalidLines }
}
