/**
 * src/pages/admin/bulkMap.ts — pure mapper from parseBulkInput result to
 * BulkTeacherInputItem[] ready for the POST /api/admin/teachers/bulk endpoint.
 *
 * Extracted from BulkAddPanel (TeachersSection) so the full UI parse → map → API
 * contract path can be tested without React.
 */
import type { ParseResult } from './bulkParse.ts'
import type { BulkTeacherInputItem } from '../../../shared/api.ts'

/**
 * Convert a ParseResult (from parseBulkInput) to the array of items
 * expected by bulkAdminTeachers / POST /api/admin/teachers/bulk.
 *
 * Invalid lines and over-limit entries are already excluded from parseResult.items.
 */
export function toBulkItems(parseResult: ParseResult): BulkTeacherInputItem[] {
  return parseResult.items.map((item): BulkTeacherInputItem => ({
    title: item.title,
    name: item.name,
    ...(item.subject ? { subject: item.subject } : {}),
    ...(item.department ? { department: item.department } : {}),
  }))
}
