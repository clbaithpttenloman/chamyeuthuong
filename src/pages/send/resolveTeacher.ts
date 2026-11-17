/**
 * src/pages/send/resolveTeacher.ts — pure function that resolves a teacher profile
 * from a publicId, using the wall teacher list first and falling back to the API.
 *
 * Returns:
 *   - TeacherProfile if found on the wall
 *   - TeacherProfile if the teacher is hidden (showOnHome=0) but fetchable via API
 *   - null if the teacher does not exist anywhere
 */
import type { TeacherPageResponse, TeacherProfile, WallTeacher } from '../../../shared/api.ts'

export type FetchTeacherPage = (publicId: string) => Promise<TeacherPageResponse>

/**
 * Resolve a teacher profile from a publicId.
 *
 * @param publicId       The teacher's public ID (from ?thay= query param).
 * @param wallTeachers   Teachers currently visible on the wall (showOnHome=1).
 * @param fetchTeacherPage  Async function that calls GET /api/teachers/:publicId.
 */
export async function resolveTeacher(
  publicId: string,
  wallTeachers: WallTeacher[],
  fetchTeacherPage: FetchTeacherPage,
): Promise<TeacherProfile | null> {
  const wallMatch = wallTeachers.find((t) => t.publicId === publicId)
  if (wallMatch) {
    return {
      publicId: wallMatch.publicId,
      title: wallMatch.title,
      name: wallMatch.name,
      subject: wallMatch.subject,
      department: wallMatch.department,
    }
  }

  // Not on wall — may be hidden (showOnHome=0); try fetching the teacher page directly.
  try {
    const page = await fetchTeacherPage(publicId)
    return page.teacher
  } catch {
    // Teacher does not exist or fetch failed — let the user pick manually.
    return null
  }
}
