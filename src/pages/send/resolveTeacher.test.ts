/**
 * Tests for resolveTeacher — synchronous lookup of a teacher by numeric id.
 */
import { describe, it, expect } from 'vitest'
import { resolveTeacherById } from './resolveTeacher.ts'
import type { WallTeacher } from '../../../shared/api.ts'

const WALL_TEACHER: WallTeacher = {
  id: 1,
  title: 'Thầy',
  name: 'Nguyễn Văn A',
  subject: 'Toán',
  department: 'Tổ Toán',
  cardCount: 5,
  role: 'Giáo viên',
}

describe('resolveTeacherById', () => {
  it('teacher on wall → returns TeacherProfile from wall data', () => {
    const result = resolveTeacherById(1, [WALL_TEACHER])
    expect(result).toEqual({
      id: 1,
      title: 'Thầy',
      name: 'Nguyễn Văn A',
      subject: 'Toán',
      department: 'Tổ Toán',
      role: 'Giáo viên',
    })
  })

  it('id not on wall → returns null', () => {
    const result = resolveTeacherById(99, [WALL_TEACHER])
    expect(result).toBeNull()
  })

  it('empty wall → returns null', () => {
    const result = resolveTeacherById(1, [])
    expect(result).toBeNull()
  })

  it('matches by id, not by position', () => {
    const teachers: WallTeacher[] = [
      { id: 10, title: 'Cô', name: 'Trần Thị B', subject: 'Văn', department: '', cardCount: 0, role: 'Giáo viên' },
      { id: 20, title: null, name: 'Lê Văn C', subject: '', department: 'Tổ Lý', cardCount: 2, role: 'Giáo viên' },
    ]
    const result = resolveTeacherById(20, teachers)
    expect(result?.name).toBe('Lê Văn C')
    expect(result?.id).toBe(20)
  })

  it('teacher with null title is returned correctly', () => {
    const t: WallTeacher = { id: 5, title: null, name: 'Phạm Văn D', subject: '', department: '', cardCount: 0, role: 'Giáo viên' }
    const result = resolveTeacherById(5, [t])
    expect(result?.title).toBeNull()
  })
})

describe('resolveTeacherById — role', () => {
  it('carries the role so the send preview shows the chức vụ', () => {
    const t: WallTeacher = { id: 9, title: 'Cô', name: 'Hà', subject: 'Toán', department: '', cardCount: 0, role: 'Hiệu trưởng' }
    expect(resolveTeacherById(9, [t])?.role).toBe('Hiệu trưởng')
  })
})
