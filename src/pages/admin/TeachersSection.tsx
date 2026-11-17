/**
 * TeachersSection — manage teacher cards (Thiệp).
 *
 * Features:
 *  - Teacher list with CRUD + QR + token rotation
 *  - Edit/create form with layout select, three slot image pickers (with
 *    quick upload), wish picker (fillWish), live CardView preview
 *  - Images and wishes loaded lazily when the editor first opens
 */
import { useCallback, useRef, useState } from 'react'
import QRCode from 'qrcode'
import {
  type ImageRow,
  type TeacherRow,
  type WishRow,
  ApiError,
  createTeacher,
  deleteTeacher,
  listImages,
  listWishes,
  rotateTeacherToken,
  updateTeacher,
  uploadImage,
} from '../../api'
import { LAYOUTS, SLOTS, type Slot, DEFAULT_LAYOUT } from '../../../shared/layouts.ts'
import { fillWish } from '../../../shared/wish.ts'
import CardView from '../../components/CardView.tsx'
import { compressImage } from '../../imageCompress.ts'

type SlotImages = Partial<Record<Slot, { id: number; token: string } | null>>

type EditDraft = {
  name: string
  subject: string
  message: string
  status: string
  layout: string
  title: string
  images: SlotImages
}

function emptyDraft(t?: TeacherRow): EditDraft {
  return {
    name: t?.name ?? '',
    subject: t?.subject ?? '',
    message: t?.message ?? '',
    status: t?.status ?? 'draft',
    layout: t?.layout ?? DEFAULT_LAYOUT,
    title: t?.title ?? '',
    images: (t?.images as SlotImages | undefined) ?? {},
  }
}

const SLOT_LABELS: Record<Slot, string> = {
  background: 'Nền toàn trang',
  banner: 'Banner (đầu thiệp)',
  photo: 'Ảnh tròn (trên tên)',
}

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp']

// ── Slot picker ────────────────────────────────────────────────────────────

function SlotPicker({
  slot,
  current,
  images,
  uploading,
  onSelect,
  onUpload,
}: {
  slot: Slot
  current: { id: number; token: string } | null | undefined
  images: ImageRow[]
  uploading: boolean
  onSelect: (img: { id: number; token: string } | null) => void
  onUpload: (slot: Slot) => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className="slot-picker">
      <span className="slot-picker-label">{SLOT_LABELS[slot]}</span>
      <div className="slot-picker-row">
        {current ? (
          <>
            <img
              src={`/api/image/${current.token}`}
              alt=""
              className="slot-thumb"
              aria-hidden="true"
            />
            <button
              type="button"
              className="btn-ghost"
              onClick={() => { onSelect(null); setOpen(false) }}
            >
              Bỏ chọn
            </button>
          </>
        ) : (
          <span className="slot-empty">Chưa có ảnh</span>
        )}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
        >
          Thư viện
        </button>
        <button
          type="button"
          onClick={() => onUpload(slot)}
          disabled={uploading}
        >
          {uploading ? 'Đang tải...' : 'Tải lên'}
        </button>
      </div>
      {open && (
        <div className="slot-picker-library" role="listbox" aria-label={`Chọn ảnh cho ${SLOT_LABELS[slot]}`}>
          {images.length === 0 && (
            <p className="slot-picker-empty">Thư viện trống. Hãy tải ảnh lên trước.</p>
          )}
          {images.map((img) => (
            <button
              key={img.id}
              type="button"
              role="option"
              aria-selected={current?.id === img.id}
              className={`img-thumb-btn${current?.id === img.id ? ' img-thumb-btn--selected' : ''}`}
              onClick={() => { onSelect({ id: img.id, token: img.token }); setOpen(false) }}
              title={img.name}
            >
              <img src={`/api/image/${img.token}`} alt={img.name} className="slot-thumb" />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Wish picker ────────────────────────────────────────────────────────────

function WishPicker({
  wishes,
  name,
  subject,
  title,
  onPick,
}: {
  wishes: WishRow[]
  name: string
  subject: string
  title?: 'Thầy' | 'Cô'
  onPick: (body: string) => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className="wish-picker">
      <button type="button" onClick={() => setOpen((o) => !o)}>
        {open ? 'Ẩn thư viện lời chúc' : 'Chọn từ thư viện lời chúc'}
      </button>
      {open && (
        <ul className="wish-picker-list" aria-label="Thư viện lời chúc">
          {wishes.length === 0 && (
            <li className="slot-picker-empty">Thư viện trống.</li>
          )}
          {wishes.map((w) => (
            <li key={w.id}>
              <button
                type="button"
                className="wish-pick-btn"
                onClick={() => { onPick(fillWish(w.body, { name, subject, title })); setOpen(false) }}
              >
                <strong>{w.title}</strong>
                <span>{w.body.slice(0, 80)}{w.body.length > 80 ? '…' : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ── Teacher edit/add form ──────────────────────────────────────────────────

function TeacherForm({
  teacher,
  images,
  wishes,
  loadingExtras,
  uploadError,
  onSave,
  onCancel,
  onQuickUpload,
}: {
  teacher: TeacherRow | null  // null = adding new
  images: ImageRow[]
  wishes: WishRow[]
  loadingExtras: boolean
  uploadError: string | null
  onSave: (draft: EditDraft) => void
  onCancel: () => void
  onQuickUpload: (slot: Slot, file: File) => Promise<{ id: number; token: string } | null>
}) {
  const [draft, setDraft] = useState<EditDraft>(() => emptyDraft(teacher ?? undefined))
  const [uploadingSlot, setUploadingSlot] = useState<Slot | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pendingSlot = useRef<Slot | null>(null)

  // Build preview images: slot → token (drop nulls)
  const previewImages: Partial<Record<string, string>> = {}
  for (const slot of SLOTS) {
    const img = draft.images[slot]
    if (img) previewImages[slot] = img.token
  }

  function handleUploadClick(slot: Slot) {
    pendingSlot.current = slot
    fileInputRef.current?.click()
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    const slot = pendingSlot.current
    if (!file || !slot) return

    if (!ACCEPTED_TYPES.includes(file.type)) return

    setUploadingSlot(slot)
    try {
      const newImg = await onQuickUpload(slot, file)
      // Auto-select the newly uploaded image for the slot
      if (newImg) {
        setDraft((d) => ({ ...d, images: { ...d.images, [slot]: newImg } }))
      }
    } finally {
      setUploadingSlot(null)
    }
  }

  // Called by parent after a quick-upload completes to inject the new image.
  // We expose a stable callback via the slot picker's onSelect.
  function handleSelectSlot(slot: Slot) {
    return (img: { id: number; token: string } | null) => {
      setDraft((d) => ({ ...d, images: { ...d.images, [slot]: img } }))
    }
  }

  const canPublish = draft.message.trim().length > 0

  return (
    <div className="teacher-editor">
      <div className="teacher-editor-panels">
        {/* Left: form */}
        <form
          className="admin-form teacher-editor-form"
          onSubmit={(e) => { e.preventDefault(); onSave(draft) }}
        >
          <h2>{teacher ? `Sửa thiệp — ${teacher.name}` : 'Thêm giáo viên'}</h2>

          <label>
            Họ tên <span aria-hidden="true">*</span>
            <input
              type="text"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              maxLength={80}
              required
            />
          </label>
          <label>
            Danh xưng <span aria-hidden="true">*</span>
            <select
              value={draft.title}
              onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
              required
            >
              <option value="" disabled>Chọn Thầy/Cô</option>
              <option value="Thầy">Thầy</option>
              <option value="Cô">Cô</option>
            </select>
          </label>
          <label>
            Môn dạy
            <input
              type="text"
              value={draft.subject}
              onChange={(e) => setDraft((d) => ({ ...d, subject: e.target.value }))}
              maxLength={80}
            />
          </label>

          <label>
            Lời chúc
            {loadingExtras ? (
              <span className="admin-loading" style={{ fontSize: '0.8rem' }}>Đang tải thư viện…</span>
            ) : (
              <WishPicker
                wishes={wishes}
                name={draft.name}
                subject={draft.subject}
                title={draft.title as 'Thầy' | 'Cô' | undefined}
                onPick={(body) => setDraft((d) => ({ ...d, message: body }))}
              />
            )}
            <textarea
              value={draft.message}
              onChange={(e) => setDraft((d) => ({ ...d, message: e.target.value }))}
              maxLength={600}
              rows={5}
              placeholder="Nhập lời chúc hoặc chọn từ thư viện"
            />
            <small>{draft.message.length}/600 ký tự</small>
          </label>

          <label>
            Bố cục thiệp
            <select
              value={draft.layout}
              onChange={(e) => setDraft((d) => ({ ...d, layout: e.target.value }))}
            >
              {LAYOUTS.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
          </label>

          {uploadError && (
            <p className="admin-error" role="alert">{uploadError}</p>
          )}

          {/* Slot image pickers */}
          {SLOTS.map((slot) => (
            <SlotPicker
              key={slot}
              slot={slot}
              current={draft.images[slot] ?? null}
              images={images}
              uploading={uploadingSlot === slot}
              onSelect={handleSelectSlot(slot)}
              onUpload={handleUploadClick}
            />
          ))}

          <label>
            Trạng thái
            <select
              value={draft.status}
              onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value }))}
            >
              <option value="draft">Nháp</option>
              <option value="published" disabled={!canPublish}>
                Đã phát hành{!canPublish ? ' (cần lời chúc)' : ''}
              </option>
            </select>
          </label>

          <div className="form-actions">
            <button type="submit">{teacher ? 'Lưu thay đổi' : 'Thêm'}</button>
            <button type="button" onClick={onCancel} className="btn-ghost">Hủy</button>
          </div>
        </form>

        {/* Right: live preview */}
        <div className="teacher-editor-preview">
          <p className="kicker" style={{ marginBottom: '0.5rem' }}>Xem trước thiệp</p>
          <div className="preview-wrap">
            <CardView
              card={{
                name: draft.name || '(Họ tên)',
                subject: draft.subject,
                message: draft.message || '(Lời chúc)',
                title: (draft.title as 'Thầy' | 'Cô') || null,
              }}
              layout={draft.layout}
              images={previewImages}
            />
          </div>
        </div>
      </div>

      {/* Hidden file input for quick upload */}
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

// ── QR section ─────────────────────────────────────────────────────────────

function QrSection({
  teacher,
  dataUrl,
  onClose,
}: {
  teacher: TeacherRow
  dataUrl: string
  onClose: () => void
}) {
  return (
    <div className="admin-qr">
      <h2>Mã QR — {teacher.name}</h2>
      <img src={dataUrl} alt={`Mã QR cho ${teacher.name}`} width={256} height={256} />
      <p className="qr-url">{location.origin}/t/{teacher.token}</p>
      <div className="form-actions">
        <a href={dataUrl} download={`thiep-${teacher.id}.png`} className="btn-link">
          Tải PNG
        </a>
        <button onClick={onClose} className="btn-ghost">Đóng</button>
      </div>
    </div>
  )
}

// ── Main TeachersSection ───────────────────────────────────────────────────

export default function TeachersSection({
  teachers,
  onTeachersChange,
  onAccessError,
}: {
  teachers: TeacherRow[]
  onTeachersChange: (updater: (ts: TeacherRow[]) => TeacherRow[]) => void
  onAccessError: (e: unknown) => boolean
}) {
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [editTeacher, setEditTeacher] = useState<TeacherRow | null>(null)
  const [qrData, setQrData] = useState<{ teacher: TeacherRow; dataUrl: string } | null>(null)
  const [copiedId, setCopiedId] = useState<number | null>(null)

  // Lazy-loaded editor resources
  const [images, setImages] = useState<ImageRow[]>([])
  const [wishes, setWishes] = useState<WishRow[]>([])
  const [loadingExtras, setLoadingExtras] = useState(false)
  const extrasLoaded = useRef(false)
  const [uploadError, setUploadError] = useState<string | null>(null)

  const loadExtras = useCallback(async () => {
    if (extrasLoaded.current) return
    setLoadingExtras(true)
    try {
      const [imgs, wshs] = await Promise.all([listImages(), listWishes()])
      setImages(imgs)
      setWishes(wshs)
      extrasLoaded.current = true
    } catch (e) {
      if (!onAccessError(e)) {
        setError(e instanceof Error ? e.message : 'Lỗi tải thư viện')
      }
    } finally {
      setLoadingExtras(false)
    }
  }, [onAccessError])

  function openEditor(teacher: TeacherRow | null) {
    setEditTeacher(teacher)
    setAdding(teacher === null)
    setQrData(null)
    setError(null)
    setUploadError(null)
    void loadExtras()
  }

  async function handleQuickUpload(_slot: Slot, file: File): Promise<{ id: number; token: string } | null> {
    setUploadError(null)
    try {
      const compressed = await compressImage(file, { maxBytes: 307200, maxDim: 1280 })
      const name = file.name.replace(/\.[^.]+$/, '').slice(0, 80) || 'image'
      const uploaded = await uploadImage(compressed, name)
      const newImg = { id: uploaded.id, token: uploaded.token }
      setImages((imgs) => [...imgs, uploaded])
      return newImg
    } catch (err) {
      if (!onAccessError(err)) {
        if (err instanceof ApiError && err.status === 409) {
          setUploadError('Đã đạt giới hạn thư viện ảnh (200 ảnh hoặc 40 MB)')
        } else if (err instanceof ApiError && err.status === 400) {
          setUploadError('Ảnh không hợp lệ. Chỉ chấp nhận JPEG, PNG, WebP nhỏ hơn 300 KB.')
        } else {
          setUploadError(err instanceof Error ? err.message : 'Lỗi tải ảnh lên')
        }
      }
      return null
    }
  }

  async function handleSave(draft: EditDraft) {
    setError(null)
    // Build images payload: slot → image id (null to remove)
    const imagesPayload: Partial<Record<string, number | null>> = {}
    for (const slot of SLOTS) {
      const img = draft.images[slot]
      if (img !== undefined) {
        imagesPayload[slot] = img ? img.id : null
      }
    }
    try {
      let saved: TeacherRow
      if (editTeacher !== null) {
        saved = await updateTeacher(editTeacher.id, {
          name: draft.name,
          subject: draft.subject,
          message: draft.message,
          status: draft.status,
          layout: draft.layout,
          images: imagesPayload,
          ...(draft.title ? { title: draft.title as 'Thầy' | 'Cô' } : {}),
        })
        onTeachersChange((ts) => ts.map((t) => (t.id === saved.id ? saved : t)))
      } else {
        if (!draft.title || (draft.title !== 'Thầy' && draft.title !== 'Cô')) {
          setError('Vui lòng chọn danh xưng Thầy hoặc Cô.')
          return
        }
        saved = await createTeacher({
          name: draft.name,
          subject: draft.subject || undefined,
          message: draft.message || undefined,
          layout: draft.layout,
          images: Object.fromEntries(
            Object.entries(imagesPayload)
              .filter(([, v]) => v !== null)
              .map(([k, v]) => [k, v as number]),
          ),
          status: draft.status,
          title: draft.title as 'Thầy' | 'Cô',
        })
        onTeachersChange((ts) => [...ts, saved])
      }
      setEditTeacher(null)
      setAdding(false)
    } catch (e) {
      if (!onAccessError(e)) {
        if (e instanceof ApiError && e.status === 400) {
          setError('Không thể lưu: kiểm tra lại các trường hoặc chọn ảnh hợp lệ.')
        } else {
          setError(e instanceof Error ? e.message : 'Lỗi lưu thiệp')
        }
      }
    }
  }

  async function handleToggleStatus(t: TeacherRow) {
    setError(null)
    try {
      const updated = await updateTeacher(t.id, {
        name: t.name,
        subject: t.subject,
        message: t.message,
        status: t.status === 'published' ? 'draft' : 'published',
      })
      onTeachersChange((ts) => ts.map((x) => (x.id === updated.id ? updated : x)))
      if (editTeacher?.id === updated.id) setEditTeacher(updated)
    } catch (e) {
      if (!onAccessError(e)) {
        if (e instanceof ApiError && e.status === 400 && t.status === 'draft') {
          setError(`Không thể phát hành "${t.name}": lời chúc không được để trống`)
        } else {
          setError(e instanceof Error ? e.message : 'Lỗi cập nhật trạng thái')
        }
      }
    }
  }

  async function handleDelete(t: TeacherRow) {
    if (!confirm(`Xóa giáo viên "${t.name}"? Hành động này không thể hoàn tác.`)) return
    setError(null)
    try {
      await deleteTeacher(t.id)
      onTeachersChange((ts) => ts.filter((x) => x.id !== t.id))
      if (editTeacher?.id === t.id) { setEditTeacher(null); setAdding(false) }
      if (qrData?.teacher.id === t.id) setQrData(null)
    } catch (e) {
      if (!onAccessError(e)) setError(e instanceof Error ? e.message : 'Lỗi xóa giáo viên')
    }
  }

  async function handleRotate(t: TeacherRow) {
    if (!confirm(`Đổi mã QR của "${t.name}"? Mã cũ sẽ không còn hoạt động.`)) return
    setError(null)
    try {
      const { token } = await rotateTeacherToken(t.id)
      const updated = { ...t, token }
      onTeachersChange((ts) => ts.map((x) => (x.id === t.id ? updated : x)))
      if (editTeacher?.id === t.id) setEditTeacher(updated)
      if (qrData?.teacher.id === t.id) {
        const url = `${location.origin}/t/${token}`
        setQrData({ teacher: updated, dataUrl: await QRCode.toDataURL(url, { margin: 2, width: 256 }) })
      }
    } catch (e) {
      if (!onAccessError(e)) setError(e instanceof Error ? e.message : 'Lỗi đổi mã')
    }
  }

  async function handleShowQr(t: TeacherRow) {
    try {
      const url = `${location.origin}/t/${t.token}`
      const dataUrl = await QRCode.toDataURL(url, { margin: 2, width: 256 })
      setQrData({ teacher: t, dataUrl })
      setEditTeacher(null)
      setAdding(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lỗi tạo mã QR')
    }
  }

  async function handleCopyUrl(t: TeacherRow) {
    try {
      await navigator.clipboard.writeText(`${location.origin}/t/${t.token}`)
      setCopiedId(t.id)
      setTimeout(() => setCopiedId((x) => (x === t.id ? null : x)), 1500)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lỗi sao chép URL')
    }
  }

  const showForm = adding || editTeacher !== null

  return (
    <div>
      <div className="admin-header">
        <h2 style={{ margin: 0 }}>Thiệp giáo viên</h2>
        <div className="admin-header-actions">
          <button
            onClick={() => openEditor(null)}
            disabled={showForm}
          >
            + Thêm giáo viên
          </button>
        </div>
      </div>

      {error && <p className="admin-error" role="alert">{error}</p>}

      {showForm && (
        <TeacherForm
          key={editTeacher?.id ?? 'new'}
          teacher={editTeacher}
          images={images}
          wishes={wishes}
          loadingExtras={loadingExtras}
          uploadError={uploadError}
          onSave={(draft) => { void handleSave(draft) }}
          onCancel={() => { setEditTeacher(null); setAdding(false) }}
          onQuickUpload={handleQuickUpload}
        />
      )}

      {!showForm && teachers.length === 0 && (
        <p className="admin-empty">Chưa có giáo viên nào. Nhấn &ldquo;+ Thêm giáo viên&rdquo; để bắt đầu.</p>
      )}

      {teachers.length > 0 && (
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Danh xưng</th>
                <th>Họ tên</th>
                <th>Môn</th>
                <th>Bố cục</th>
                <th>Trạng thái</th>
                <th>Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {teachers.map((t) => (
                <tr
                  key={t.id}
                  className={editTeacher?.id === t.id ? 'row-active' : undefined}
                >
                  <td>{t.title ?? '—'}</td>
                  <td>{t.name}</td>
                  <td>{t.subject || '—'}</td>
                  <td>{LAYOUTS.find((l) => l.id === t.layout)?.name ?? t.layout}</td>
                  <td>
                    <span className={`status-badge status-${t.status}`}>
                      {t.status === 'published' ? 'Đã phát hành' : 'Nháp'}
                    </span>
                  </td>
                  <td className="admin-actions">
                    <button
                      onClick={() => openEditor(t)}
                      aria-label={`Sửa thiệp của ${t.name}`}
                    >
                      Sửa
                    </button>
                    <button
                      onClick={() => { void handleToggleStatus(t) }}
                      aria-label={
                        t.status === 'published'
                          ? `Chuyển "${t.name}" về nháp`
                          : `Phát hành thiệp của ${t.name}`
                      }
                    >
                      {t.status === 'published' ? 'Về nháp' : 'Phát hành'}
                    </button>
                    <button
                      onClick={() => { void handleCopyUrl(t) }}
                      aria-label={`Sao chép URL thiệp của ${t.name}`}
                    >
                      {copiedId === t.id ? '✓ Đã sao chép' : 'Sao chép URL'}
                    </button>
                    <button
                      onClick={() => { void handleShowQr(t) }}
                      aria-label={`Xem mã QR cho ${t.name}`}
                    >
                      QR
                    </button>
                    <button
                      onClick={() => { void handleRotate(t) }}
                      aria-label={`Đổi mã QR của ${t.name}`}
                      className="btn-warn"
                    >
                      Đổi mã
                    </button>
                    <button
                      onClick={() => { void handleDelete(t) }}
                      aria-label={`Xóa giáo viên ${t.name}`}
                      className="btn-danger"
                    >
                      Xóa
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {qrData && (
        <QrSection
          teacher={qrData.teacher}
          dataUrl={qrData.dataUrl}
          onClose={() => setQrData(null)}
        />
      )}
    </div>
  )
}
