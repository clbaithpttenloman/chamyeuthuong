// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { getSlotSpec } from '../../../shared/themeSlots.ts'
import { slotChecklist } from './themeSpec.ts'

describe('slotChecklist', () => {
  it('lists size, formats, transparency and the size limit for a transparent slot', () => {
    const spec = getSlotSpec('star')!
    expect(slotChecklist(spec)).toEqual([
      'Kích thước: 256×256 px',
      'Định dạng: PNG, WebP',
      'Nền: phải trong suốt',
      'Dung lượng tối đa: 300 KB',
    ])
  })

  it('says a background slot must be opaque and lists JPEG when allowed', () => {
    const spec = getSlotSpec('sky_portrait')!
    expect(slotChecklist(spec)).toEqual([
      'Kích thước: 1080×1920 px',
      'Định dạng: JPEG, PNG, WebP',
      'Nền: không được trong suốt',
      'Dung lượng tối đa: 600 KB',
    ])
  })
})
