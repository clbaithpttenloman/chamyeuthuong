/**
 * src/pages/send/resolveTeacher.ts — synchronous teacher profile lookup by numeric id.
 *
 * Returns:
 *   - TeacherProfile if found in the wall teacher list by numeric id
 *   - null if no matching teacher exists (hidden teachers are not in the wall list;
 *     they are accessed via ?t=<token> which calls getQr directly in SendPage)
 */
import type { TeacherProfile, WallTeacher } from '../../../shared/api.ts'

/**
 * Look up a teacher profile from the wall by numeric id.
 * Synchronous — the wall list is already loaded before this is called.
 *
 * @param id           The teacher's numeric id (from ?thay=<id> query param).
 * @param wallTeachers Teachers currently visible on the wall (showOnHome=1).
 */
export function resolveTeacherById(
  id: number,
  wallTeachers: WallTeacher[],
): TeacherProfile | null {
  const found = wallTeachers.find((t) => t.id === id)
  if (!found) return null
  return {
    id: found.id,
    title: found.title,
    name: found.name,
    subject: found.subject,
    department: found.department,
    role: found.role,
  }
}
