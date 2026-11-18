/**
 * Tests for src/pages/admin/aboutForm.ts
 *
 *
 * Contract expected:
 *   serializeAboutForm(fields: AboutFormFields): AboutContent
 *     Converts the admin form's local state (which may use different field names
 *     or mutable arrays) into the AboutContent shape ready for PUT /api/admin/about.
 *     - Trims all string fields (NFC-normalizes if needed)
 *     - Preserves array order
 *     - Returns a plain object with the AboutContent shape
 */
import { describe, it, expect } from 'vitest'

import { serializeAboutForm } from './aboutForm.ts'
import type { AboutContent } from '../../../shared/api.ts'

describe('serializeAboutForm — basic shape', () => {
  it('returns an object with all required AboutContent keys', () => {
    const result = serializeAboutForm({
      heading: 'CLB AI',
      intro: 'Giới thiệu',
      stats: [{ value: '2', label: 'ngày' }],
      stepsHeading: 'Quá trình',
      steps: [{ when: '16/11', title: 'Khởi tạo', text: '' }],
      membersHeading: 'Thành viên',
      members: [{ name: 'Vũ Ngọc Diệp', role: 'Chủ nhiệm' }],
    })
    expect(result).toHaveProperty('heading')
    expect(result).toHaveProperty('intro')
    expect(result).toHaveProperty('stats')
    expect(result).toHaveProperty('stepsHeading')
    expect(result).toHaveProperty('steps')
    expect(result).toHaveProperty('membersHeading')
    expect(result).toHaveProperty('members')
  })

  it('heading is trimmed', () => {
    const result = serializeAboutForm({
      heading: '  CLB AI  ',
      intro: 'intro',
      stats: [],
      stepsHeading: 'Steps',
      steps: [],
      membersHeading: 'Members',
      members: [],
    })
    expect(result.heading).toBe('CLB AI')
  })

  it('intro is trimmed', () => {
    const result = serializeAboutForm({
      heading: 'H',
      intro: '  intro text  ',
      stats: [],
      stepsHeading: 'S',
      steps: [],
      membersHeading: 'M',
      members: [],
    })
    expect(result.intro).toBe('intro text')
  })

  it('preserves stats array order', () => {
    const result = serializeAboutForm({
      heading: 'H',
      intro: 'I',
      stats: [
        { value: '2', label: 'ngày phát triển' },
        { value: '5', label: 'mẫu thiệp' },
      ],
      stepsHeading: 'S',
      steps: [],
      membersHeading: 'M',
      members: [],
    })
    expect(result.stats[0].value).toBe('2')
    expect(result.stats[1].label).toBe('mẫu thiệp')
  })

  it('preserves steps array order with when/title/text', () => {
    const result = serializeAboutForm({
      heading: 'H',
      intro: 'I',
      stats: [],
      stepsHeading: 'S',
      steps: [
        { when: '16/11', title: 'Khởi tạo', text: 'Chi tiết' },
        { when: '17/11', title: 'Hoàn thiện', text: '' },
      ],
      membersHeading: 'M',
      members: [],
    })
    expect(result.steps[0].when).toBe('16/11')
    expect(result.steps[1].title).toBe('Hoàn thiện')
  })

  it('preserves members array with name/role', () => {
    const result = serializeAboutForm({
      heading: 'H',
      intro: 'I',
      stats: [],
      stepsHeading: 'S',
      steps: [],
      membersHeading: 'M',
      members: [
        { name: 'Vũ Ngọc Diệp', role: 'Chủ nhiệm CLB' },
        { name: 'Kiro Coding Agent', role: 'Thiết kế & phát triển' },
      ],
    })
    expect(result.members[0].name).toBe('Vũ Ngọc Diệp')
    expect(result.members[1].role).toBe('Thiết kế & phát triển')
  })

  it('empty arrays are preserved as empty arrays', () => {
    const result = serializeAboutForm({
      heading: 'H',
      intro: 'I',
      stats: [],
      stepsHeading: 'S',
      steps: [],
      membersHeading: 'M',
      members: [],
    })
    expect(result.stats).toEqual([])
    expect(result.steps).toEqual([])
    expect(result.members).toEqual([])
  })

  it('output satisfies the AboutContent shape', () => {
    const result: AboutContent = serializeAboutForm({
      heading: 'CLB AI',
      intro: 'Intro text',
      stats: [{ value: '2', label: 'ngày' }],
      stepsHeading: 'Quá trình',
      steps: [{ when: '16/11', title: 'Step', text: 'Detail' }],
      membersHeading: 'Thành viên',
      members: [{ name: 'Vũ Ngọc Diệp', role: 'Chủ nhiệm' }],
    })
    // TypeScript type assignment asserts the shape
    expect(typeof result.heading).toBe('string')
    expect(Array.isArray(result.stats)).toBe(true)
    expect(Array.isArray(result.steps)).toBe(true)
    expect(Array.isArray(result.members)).toBe(true)
  })
})
