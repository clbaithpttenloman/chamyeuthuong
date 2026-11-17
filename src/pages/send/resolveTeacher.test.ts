/**
 * Tests for resolveTeacher — pure function that resolves a teacher from publicId.
 * Fails until resolveTeacher.ts is created.
 */
import { describe, it, expect, vi } from 'vitest'
// Import fails until resolveTeacher.ts is created → all tests fail.
import { resolveTeacher } from './resolveTeacher.ts'
import type { WallTeacher } from '../../../shared/api.ts'

const WALL_TEACHER: WallTeacher = {
  publicId: 'pub1234567890ab',
  title: 'Thầy',
  name: 'Nguyễn Văn A',
  subject: 'Toán',
  department: 'Tổ Toán',
  cardCount: 5,
}

describe('resolveTeacher', () => {
  it('teacher on wall → returns TeacherProfile from wall data', async () => {
    const fetchPage = vi.fn()
    const result = await resolveTeacher('pub1234567890ab', [WALL_TEACHER], fetchPage)
    expect(result).toEqual({
      publicId: 'pub1234567890ab',
      title: 'Thầy',
      name: 'Nguyễn Văn A',
      subject: 'Toán',
      department: 'Tổ Toán',
    })
    expect(fetchPage).not.toHaveBeenCalled()
  })

  it('hidden teacher (not on wall) → fetched via fetchTeacherPage', async () => {
    const hiddenProfile = {
      publicId: 'hid1234567890ab',
      title: 'Cô',
      name: 'Trần Thị B',
      subject: 'Văn',
      department: '',
    }
    const fetchPage = vi.fn().mockResolvedValue({ teacher: hiddenProfile, cards: [], total: 0 })
    const result = await resolveTeacher('hid1234567890ab', [WALL_TEACHER], fetchPage)
    expect(result).toEqual(hiddenProfile)
    expect(fetchPage).toHaveBeenCalledWith('hid1234567890ab')
  })

  it('unknown teacher (not on wall, fetch fails) → returns null', async () => {
    const fetchPage = vi.fn().mockRejectedValue(new Error('not found'))
    const result = await resolveTeacher('unknown0000000ab', [WALL_TEACHER], fetchPage)
    expect(result).toBeNull()
  })

  it('empty wall → falls back to fetchTeacherPage', async () => {
    const hiddenProfile = {
      publicId: 'pub1234567890ab',
      title: 'Thầy',
      name: 'Nguyễn Văn A',
      subject: 'Toán',
      department: 'Tổ Toán',
    }
    const fetchPage = vi.fn().mockResolvedValue({ teacher: hiddenProfile, cards: [], total: 0 })
    const result = await resolveTeacher('pub1234567890ab', [], fetchPage)
    expect(result).toEqual(hiddenProfile)
  })
})
