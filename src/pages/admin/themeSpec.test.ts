// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { getSlotSpec } from '../../../shared/themeSlots.ts'
import { slotChecklist } from './themeSpec.ts'

describe('slotChecklist', () => {
  it('a still transparent slot: size, formats, transparency, no animation, size limit', () => {
    expect(slotChecklist(getSlotSpec('star')!)).toEqual([
      'Kích thước: 256×256 px',
      'Định dạng: PNG, WebP, GIF',
      'Nền: phải trong suốt',
      'Hoạt ảnh: GIF hoặc WebP động lặp tự động, tối đa 24 khung hình (ảnh tĩnh cũng được)',
      'Dung lượng tối đa: 300 KB',
    ])
  })

  it('a still opaque slot says it has no animation', () => {
    const lines = slotChecklist(getSlotSpec('sky_portrait')!)
    expect(lines).toContain('Định dạng: JPEG, PNG, WebP')
    expect(lines).toContain('Nền: không được trong suốt')
    expect(lines).toContain('Hoạt ảnh: không (ảnh tĩnh)')
  })

  it('a sprite slot states the cell size, grid rules, and the fps to declare', () => {
    const lines = slotChecklist(getSlotSpec('box_1_open')!)
    expect(lines[0]).toBe('Kích thước: ô 512×512 px (lưới ghép từ các ô)')
    expect(lines[3]).toMatch(/^Hoạt ảnh: lưới khung hình.*6–16 khung.*12–30 fps/)
    expect(lines[4]).toBe('Dung lượng tối đa: 1024 KB')
  })
})
