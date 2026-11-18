/**
 * worker/publicSql.ts — shared SQL fragments and mappers for public card responses.
 *
 * Used by public.ts (wall, teacher page, templates) and qr.ts.
 * Having one place prevents the alias-substitution pattern
 * (`PUBLIC_CARD_WHERE.replace('sc.', 'sc2.')`) and ensures image/card mapping
 * stays consistent across endpoints.
 */
import { formatFrom } from '../shared/api.ts'
import { isSlot, resolveLayout } from '../shared/layouts.ts'
import { resolveFont, resolveInk } from '../shared/fonts.ts'
import type { Env } from './types.ts'

/**
 * SQL fragment for approved cards, using the given table alias.
 * @example cardWhere('sc')  → "sc.status = 'approved'"
 * @example cardWhere('sc2') → "sc2.status = 'approved'"
 */
export function cardWhere(alias: string): string {
  return `${alias}.status = 'approved'`
}

/**
 * SQL fragment for show-on-home teachers, using the given table alias.
 * @example teacherWhere('tp') → "tp.show_on_home = 1"
 */
export function teacherWhere(alias: string): string {
  return `${alias}.show_on_home = 1`
}

export type CardRow = {
  public_id: string
  layout: string
  font: string
  ink: string
  message: string
  from_name: string
  from_class: string
  anonymous: number
  created_at: string
  template_id: number
}

/** Fetch slot→token map for a set of template ids (one query, json_each). */
export async function fetchTemplateImages(
  db: Env['DB'],
  templateIds: number[],
): Promise<Map<number, Record<string, string>>> {
  if (templateIds.length === 0) return new Map()
  const { results } = await db
    .prepare(
      'SELECT ti.template_id, ti.slot, i.token ' +
      'FROM template_image ti JOIN image i ON i.id = ti.image_id ' +
      'WHERE ti.template_id IN (SELECT value FROM json_each(?))',
    )
    .bind(JSON.stringify(templateIds))
    .all<{ template_id: number; slot: string; token: string }>()
  const map = new Map<number, Record<string, string>>()
  for (const r of results) {
    // Skip slots not in SLOTS (e.g. legacy 'photo' rows in old local DBs).
    if (!isSlot(r.slot)) continue
    if (!map.has(r.template_id)) map.set(r.template_id, {})
    map.get(r.template_id)![r.slot] = r.token
  }
  return map
}

/** Map a card DB row + its images to the public card shape. */
export function toPublicCard(row: CardRow, images: Record<string, string>) {
  return {
    publicId: row.public_id,
    layout: resolveLayout(row.layout).id,
    images,
    font: resolveFont(row.font).id,
    ink: resolveInk(row.ink),
    message: row.message,
    from: formatFrom({
      fromName: row.from_name,
      fromClass: row.from_class,
      anonymous: row.anonymous === 1,
    }),
    createdAt: row.created_at,
  }
}
