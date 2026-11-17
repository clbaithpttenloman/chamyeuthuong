/**
 * BulkCreate — create up to 100 teacher cards from a pasted list.
 *
 * Input format: one "Thầy/Cô Name | Subject" per line.
 * Lines without a valid title prefix (Thầy/Cô, case-insensitive) are listed
 * in the error message and nothing is created.
 * Shared layout, images, and wish template are applied to every card.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  type ImageRow,
  type TeacherRow,
  type WishRow,
  ApiError,
  bulkCreateTeachers,
  listImages,
  listWishes,
  uploadImage,
} from '../../api'
import { LAYOUTS, SLOTS, type Slot, DEFAULT_LAYOUT } from '../../../shared/layouts.ts'
import { fillWish } from '../../../shared/wish.ts'
import { compressImage } from '../../imageCompress.ts'
import { parseBulkInput } from './bulkParse.ts'

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const SLOT_LABELS: Record<Slot, string> = {
  background: 'Nền toàn trang',
  banner: 'Banner (đầu thiệp)',
  photo: 'Ảnh tròn (trên tên)',
}

type SlotImages = Partial<Record<Slot, { id: number; token: string } | null>>

export default function BulkCreate({
  onAccessError,
  onTeachersCreated,
}: {
  onAccessError: (e: unknown) => boolean
  onTeachersCreated: (teachers: TeacherRow[]) => void
}) {
  const [text, setText] = useState('')
  const [layout, setLayout] = useState(DEFAULT_LAYOUT)
  const [slotImages, setSlotImages] = useState<SlotImages>({})
  const [wishTemplate, setWishTemplate] = useState('')
  const [status, setStatus] = useState<'draft' | 'published'>('draft')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [successCount, setSuccessCount] = useState<number | null>(null)

  const [images, setImages] = useState<ImageRow[]>([])
  const [wishes, setWishes] = useState<WishRow[]>([])
  const [loadingExtras, setLoadingExtras] = useState(true)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploadingSlot, setUploadingSlot] = useState<Slot | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pendingSlot = useRef<Slot | null>(null)

  const loadExtras = useCallback(async () => {
    try {
      const [imgs, wshs] = await Promise.all([listImages(), listWishes()])
      setImages(imgs)
      setWishes(wshs)
    } catch (e) {
      if (!onAccessError(e)) {
        setError(e instanceof Error ? e.message : 'Lỗi tải thư viện')
      }
    } finally {
      setLoadingExtras(false)
    }
  }, [onAccessError])

  useEffect(() => { void loadExtras() }, [loadExtras])

  function handleUploadClick(slot: Slot) {
    pendingSlot.current = slot
    fileInputRef.current?.click()
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    const slot = pendingSlot.current
    if (!file || !slot) return
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setUploadError('Chỉ chấp nhận ảnh JPEG, PNG hoặc WebP.')
      return
    }
    setUploadingSlot(slot)
    setUploadError(null)
    try {
      const compressed = await compressImage(file, { maxBytes: 307200, maxDim: 1280 })
      const name = file.name.replace(/\.[^.]+$/, '').slice(0, 80) || 'image'
      const uploaded = await uploadImage(compressed, name)
      setImages((imgs) => [...imgs, uploaded])
      setSlotImages((s) => ({ ...s, [slot]: { id: uploaded.id, token: uploaded.token } }))
    } catch (err) {
      if (!onAccessError(err)) {
        if (err instanceof ApiError && err.status === 409) {
          setUploadError('Đã đạt giới hạn thư viện ảnh')
        } else {
          setUploadError(err instanceof Error ? err.message : 'Lỗi tải ảnh lên')
        }
      }
    } finally {
      setUploadingSlot(null)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSuccessCount(null)

    const { items, invalidLines, overLimit } = parseBulkInput(text)

    if (invalidLines.length > 0) {
      setError(`Các dòng sau thiếu danh xưng Thầy/Cô hoặc tên: ${invalidLines.join(', ')}`)
      return
    }
    if (items.length === 0) { setError('Danh sách trống.'); return }
    if (overLimit > 0) { setError(`Tối đa 100 giáo viên mỗi lần; bớt ${overLimit} dòng rồi thử lại.`); return }

    // Build items with message from wish template (if set)
    const finalItems = items.map((item) => ({
      name: item.name,
      title: item.title,
      subject: item.subject,
      message: wishTemplate.trim()
        ? fillWish(wishTemplate.trim(), { name: item.name, subject: item.subject, title: item.title })
        : undefined,
    }))

    // Build images payload
    const imagesPayload: Partial<Record<string, number>> = {}
    for (const slot of SLOTS) {
      const img = slotImages[slot]
      if (img) imagesPayload[slot] = img.id
    }

    setSubmitting(true)
    try {
      const { created } = await bulkCreateTeachers({
        items: finalItems,
        layout,
        images: Object.keys(imagesPayload).length > 0 ? imagesPayload : undefined,
        status,
      })
      onTeachersCreated(created)
      setSuccessCount(created.length)
      setText('')
      setWishTemplate('')
    } catch (err) {
      if (!onAccessError(err)) {
        if (err instanceof ApiError && err.status === 400) {
          setError('Dữ liệu không hợp lệ. Kiểm tra lại danh sách và thử lại.')
        } else if (err instanceof ApiError && err.status === 413) {
          setError('Danh sách quá lớn. Giảm số lượng hoặc rút ngắn tên.')
        } else {
          setError(err instanceof Error ? err.message : 'Lỗi tạo hàng loạt')
        }
      }
    } finally {
      setSubmitting(false)
    }
  }

  const { items } = parseBulkInput(text)

  return (
    <div>
      <div className="admin-subsection-header">
        <h2>Tạo hàng loạt</h2>
      </div>

      {error && <p className="admin-error" role="alert">{error}</p>}
      {successCount !== null && (
        <p className="admin-success" role="status">
          Đã tạo {successCount} thiệp thành công!
        </p>
      )}

      <form className="admin-form" onSubmit={(e) => { void handleSubmit(e) }}>
        <label>
          Danh sách giáo viên <span aria-hidden="true">*</span>
          <small>Mỗi dòng: Thầy/Cô Tên | Môn (tối đa 100 dòng)</small>
          <textarea
            value={text}
            onChange={(e) => { setText(e.target.value); setSuccessCount(null) }}
            rows={8}
            placeholder={'Thầy Nguyễn Văn A | Toán\nCô Trần Thị B | Văn\nThầy Lê Văn C'}
            required
          />
          <small>{items.length} giáo viên</small>
        </label>

        <label>
          Lời chúc dùng chung (tùy chọn)
          <small>Dùng {'{Thầy/Cô}'}, {'{thầy/cô}'}, {'{tên}'} và {'{môn}'} để điền tự động</small>
          <textarea
            value={wishTemplate}
            onChange={(e) => setWishTemplate(e.target.value)}
            maxLength={600}
            rows={4}
            placeholder="Kính chúc {Thầy/Cô} {tên} luôn mạnh khỏe và hạnh phúc!"
          />
          <small>{wishTemplate.length}/600 ký tự</small>
        </label>

        <label>
          Bố cục thiệp
          <select value={layout} onChange={(e) => setLayout(e.target.value)}>
            {LAYOUTS.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        </label>

        {/* Shared slot image pickers */}
        <fieldset style={{ border: '1px solid #fed7aa', borderRadius: '0.4rem', padding: '0.75rem' }}>
          <legend style={{ fontWeight: 600, fontSize: '0.9rem' }}>Ảnh dùng chung</legend>
          {uploadError && <p className="admin-error" role="alert" style={{ marginTop: '0.5rem' }}>{uploadError}</p>}
          {loadingExtras && <p className="admin-loading">Đang tải thư viện…</p>}
          {!loadingExtras && SLOTS.map((slot) => {
            const current = slotImages[slot]
            return (
              <div key={slot} className="slot-picker">
                <span className="slot-picker-label">{SLOT_LABELS[slot]}</span>
                <div className="slot-picker-row">
                  {current ? (
                    <>
                      <img src={`/api/image/${current.token}`} alt="" className="slot-thumb" aria-hidden="true" />
                      <button type="button" className="btn-ghost" onClick={() => setSlotImages((s) => ({ ...s, [slot]: null }))}>
                        Bỏ chọn
                      </button>
                    </>
                  ) : (
                    <span className="slot-empty">Chưa có ảnh</span>
                  )}
                  <button
                    type="button"
                    onClick={() => handleUploadClick(slot)}
                    disabled={uploadingSlot === slot}
                  >
                    {uploadingSlot === slot ? 'Đang tải...' : 'Tải lên'}
                  </button>
                  <select
                    value={current?.id.toString() ?? ''}
                    onChange={(e) => {
                      const id = parseInt(e.target.value, 10)
                      const img = images.find((i) => i.id === id)
                      setSlotImages((s) => ({
                        ...s,
                        [slot]: img ? { id: img.id, token: img.token } : null,
                      }))
                    }}
                    aria-label={`Chọn ảnh cho ${SLOT_LABELS[slot]}`}
                  >
                    <option value="">— Chọn từ thư viện —</option>
                    {images.map((img) => (
                      <option key={img.id} value={img.id.toString()}>{img.name}</option>
                    ))}
                  </select>
                </div>
              </div>
            )
          })}
        </fieldset>

        <label>
          Trạng thái
          <select value={status} onChange={(e) => setStatus(e.target.value as 'draft' | 'published')}>
            <option value="draft">Nháp</option>
            <option value="published">Đã phát hành</option>
          </select>
        </label>

        <div className="form-actions">
          <button type="submit" disabled={submitting || items.length === 0}>
            {submitting ? 'Đang tạo...' : `Tạo ${items.length} thiệp`}
          </button>
        </div>
      </form>

      {/* Wish library reference */}
      {wishes.length > 0 && (
        <details style={{ marginTop: '1rem' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
            Thư viện lời chúc ({wishes.length})
          </summary>
          <ul className="wish-list" style={{ marginTop: '0.5rem' }}>
            {wishes.map((w) => (
              <li key={w.id} className="wish-item">
                <div className="wish-item-content">
                  <strong className="wish-title">{w.title}</strong>
                  <p className="wish-body">{w.body.slice(0, 100)}{w.body.length > 100 ? '…' : ''}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setWishTemplate(w.body)}
                >
                  Dùng mẫu này
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        style={{ display: 'none' }}
        onChange={(e) => { void handleFileChange(e) }}
        aria-label="Chọn ảnh để tải lên"
      />
    </div>
  )
}
