/**
 * TemplateSection — Mẫu thiệp.
 *
 * Grid of active/inactive templates with usage counts.
 * Editor: name ≤60, layout picker (ratio + writing zone), background picker from the image
 * library with a size hint for the layout's ratio, active switch, live preview with the
 * writing zone outlined so the admin can check the image leaves it clear.
 * Delete with 409 message "Mẫu đang được dùng — hãy tắt mẫu thay vì xóa".
 *
 * Campaign select on create/edit (from /api/admin/campaigns). Requires an admin session (ADR-9).
 * If the campaigns call fails, the select is hidden and the campaign defaults to 1.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AdminTemplate, AdminTemplateInput } from '../../../shared/api.ts'
import { LAYOUTS, SLOTS, type Slot, DEFAULT_LAYOUT, resolveLayout } from '../../../shared/layouts.ts'
import {
  ApiError,
  type AdminCampaignRow,
  type ImageRow,
  createAdminTemplate,
  deleteAdminTemplate,
  listAdminCampaigns,
  listAdminTemplates,
  listImages,
  messageFor,
  updateAdminTemplate,
  uploadImage,
} from '../../api'
import CardView from '../../components/CardView.tsx'
import { compressImage } from '../../imageCompress.ts'

type SlotImages = Partial<Record<Slot, { id: number; token: string } | null>>

type TemplateForm = {
  name: string
  layout: string
  active: 0 | 1
  images: SlotImages
  campaignId: number  // Phase 2: campaign this template belongs to (default 1)
}

const SLOT_LABELS: Record<Slot, string> = {
  background: 'Ảnh nền',
}

/** Recommended upload size per card ratio (the compressor keeps the long side ≤ 1280 px). */
const SIZE_HINT = {
  portrait: 'Ảnh dọc 3:4, nên 960×1280. Chừa trống vùng viết (khung nét đứt bên phải).',
  landscape: 'Ảnh ngang 4:3, nên 1280×960. Chừa trống vùng viết (khung nét đứt bên phải).',
} as const

const SAMPLE_CARD = {
  name: 'Tên thầy cô',
  subject: 'Môn học',
  message: 'Lời chúc chân thành từ học sinh CLB AI đến thầy cô nhân ngày Nhà giáo Việt Nam 20/11.',
  title: 'Thầy' as const,
}

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp']

function emptyForm(): TemplateForm {
  return { name: '', layout: DEFAULT_LAYOUT, active: 1, images: {}, campaignId: 1 }
}

function templateToForm(t: AdminTemplate): TemplateForm {
  const images: SlotImages = {}
  for (const slot of SLOTS) {
    const img = t.images[slot]
    if (img) images[slot] = img
  }
  return { name: t.name, layout: resolveLayout(t.layout).id, active: t.active, images, campaignId: t.campaignId ?? 1 }
}

export default function TemplateSection({
  onAccessError,
}: {
  onAccessError: (e: unknown) => boolean
}) {
  const [templates, setTemplates] = useState<AdminTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [form, setForm] = useState<TemplateForm>(emptyForm())
  const [saving, setSaving] = useState(false)

  // Image library for slot pickers
  const [images, setImages] = useState<ImageRow[]>([])
  const imagesLoaded = useRef(false)
  const [loadingImages, setLoadingImages] = useState(false)
  const [uploadingSlot, setUploadingSlot] = useState<Slot | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pendingSlot = useRef<Slot | null>(null)

  // Phase 2: Campaign list for the campaign select in create/edit.
  // If the campaigns call fails (for example the session expired), the select stays hidden.
  const [campaigns, setCampaigns] = useState<AdminCampaignRow[]>([])
  const [campaignsLoaded, setCampaignsLoaded] = useState(false)

  useEffect(() => {
    setLoading(true)
    listAdminTemplates()
      .then(setTemplates)
      .catch((e) => { if (!onAccessError(e)) setError(messageFor(e)) })
      .finally(() => setLoading(false))
  }, [onAccessError])

  const loadImages = useCallback(async () => {
    if (imagesLoaded.current) return
    setLoadingImages(true)
    try {
      setImages(await listImages())
      imagesLoaded.current = true
    } catch (e) {
      if (!onAccessError(e)) setUploadError('Lỗi tải thư viện ảnh')
    } finally {
      setLoadingImages(false)
    }
  }, [onAccessError])

  /** Load campaigns for the campaign select. On failure, silently leaves campaigns empty. */
  const loadCampaigns = useCallback(async () => {
    if (campaignsLoaded) return
    try {
      const rows = await listAdminCampaigns()
      setCampaigns(rows)
    } catch (e) {
      // Failure → hide the select, keep campaign 1 as default.
      if (!(e instanceof ApiError && e.status === 401)) {
        // Non-401 failure: treat as non-critical; select will be hidden.
      }
    } finally {
      setCampaignsLoaded(true)
    }
  }, [campaignsLoaded])

  function openNew() {
    setEditing('new')
    setForm(emptyForm())
    setError(null)
    setUploadError(null)
    void loadImages()
    void loadCampaigns()
  }

  function openEdit(t: AdminTemplate) {
    setEditing(t.id)
    setForm(templateToForm(t))
    setError(null)
    setUploadError(null)
    void loadImages()
    void loadCampaigns()
  }

  function cancelEdit() {
    setEditing(null)
    setUploadError(null)
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
      setImages((prev) => [...prev, uploaded])
      setForm((f) => ({ ...f, images: { ...f.images, [slot]: { id: uploaded.id, token: uploaded.token } } }))
    } catch (e) {
      if (!onAccessError(e)) {
        setUploadError(e instanceof ApiError && e.status === 409
          ? 'Đã đạt giới hạn thư viện ảnh'
          : messageFor(e))
      }
    } finally {
      setUploadingSlot(null)
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim()) return
    setSaving(true)
    setError(null)

    // Build images payload
    const imagesPayload: Record<string, number | null> = {}
    for (const slot of SLOTS) {
      const img = form.images[slot]
      if (img !== undefined) imagesPayload[slot] = img ? img.id : null
    }

    const input: AdminTemplateInput = {
      name: form.name.trim().slice(0, 60),
      layout: form.layout,
      active: form.active,
      images: imagesPayload,
      campaignId: form.campaignId,
    }

    try {
      if (editing === 'new') {
        const created = await createAdminTemplate(input)
        setTemplates((prev) => [...prev, created])
      } else if (editing !== null) {
        const updated = await updateAdminTemplate(editing, input)
        setTemplates((prev) => prev.map((t) => t.id === updated.id ? updated : t))
      }
      setEditing(null)
    } catch (err) {
      if (!onAccessError(err)) {
        setError(messageFor(err))
      }
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(t: AdminTemplate) {
    if (!confirm(`Xóa mẫu "${t.name}"?`)) return
    setError(null)
    try {
      await deleteAdminTemplate(t.id)
      setTemplates((prev) => prev.filter((x) => x.id !== t.id))
      if (editing === t.id) cancelEdit()
    } catch (err) {
      if (!onAccessError(err)) {
        if (err instanceof ApiError && err.status === 409) {
          setError('Mẫu đang được dùng — hãy tắt mẫu thay vì xóa')
        } else {
          setError(messageFor(err))
        }
      }
    }
  }

  // Build preview images from form
  const previewImages: Record<string, string> = {}
  for (const slot of SLOTS) {
    const img = form.images[slot]
    if (img) previewImages[slot] = img.token
  }

  return (
    <div>
      <div className="admin-subsection-header">
        <h2>Mẫu thiệp</h2>
        <button type="button" onClick={openNew}>+ Thêm mẫu</button>
      </div>

      {error && <p className="admin-error" role="alert">{error}</p>}
      {loading && <p className="admin-loading">Đang tải...</p>}

      {/* Template grid */}
      {!loading && (
        <div className="template-grid-admin">
          {templates.map((tpl) => (
            <div
              key={tpl.id}
              className={`template-admin-tile${editing === tpl.id ? ' template-admin-tile--editing' : ''}`}
            >
              <div className="card-mini">
                <CardView
                  card={SAMPLE_CARD}
                  layout={tpl.layout}
                  images={Object.fromEntries(
                    SLOTS.map((s) => [s, tpl.images[s]?.token ?? '']).filter(([, v]) => v),
                  )}
                  headingLevel="h2"
                />
              </div>
              <div className="template-admin-name">{tpl.name}</div>
              <div className="template-admin-usage">
                <span className={`template-active-badge ${tpl.active ? 'template-active' : 'template-inactive'}`}>
                  {tpl.active ? 'Đang dùng' : 'Tắt'}
                </span>
                {tpl.campaignId !== undefined && tpl.campaignId !== 1 && (
                  <span style={{ fontSize: '0.78rem', color: '#78716c', marginLeft: '0.4rem' }}>
                    {'Chiến dịch '}{tpl.campaignId}
                  </span>
                )}
              </div>
              <div className="admin-actions">
                <button type="button" className="btn-ghost" onClick={() => openEdit(tpl)}>Sửa</button>
                <button type="button" className="btn-danger" onClick={() => { void handleDelete(tpl) }}>Xóa</button>
              </div>
            </div>
          ))}
          {templates.length === 0 && (
            <p className="admin-empty">Chưa có mẫu thiệp nào.</p>
          )}
        </div>
      )}

      {/* Create/edit form */}
      {editing !== null && (
        <div className="teacher-editor">
          <div className="teacher-editor-panels">
            {/* Form */}
            <form className="admin-form teacher-editor-form" onSubmit={(e) => { void handleSave(e) }}>
              <h2>{editing === 'new' ? 'Thêm mẫu thiệp mới' : 'Chỉnh sửa mẫu thiệp'}</h2>

              <label>
                Tên mẫu <span aria-hidden="true">*</span>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  maxLength={60}
                  required
                  placeholder="VD: Hoa sen hồng"
                />
                <small>{form.name.length}/60 ký tự</small>
              </label>

              {/* Phase 2: Campaign select — hidden when campaigns are unavailable (401 / not loaded). */}
              {campaignsLoaded && campaigns.length > 0 && (
                <label htmlFor="template-campaign-select">
                  Chiến dịch
                  <select
                    id="template-campaign-select"
                    value={form.campaignId}
                    onChange={(e) => setForm((f) => ({ ...f, campaignId: parseInt(e.target.value, 10) }))}
                    aria-label="Chọn chiến dịch cho mẫu thiệp"
                  >
                    {campaigns.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.slug})
                      </option>
                    ))}
                  </select>
                  <small>Mẫu chỉ hiển thị cho học sinh trong chiến dịch này.</small>
                </label>
              )}

              <fieldset className="write-choice">
                <legend>Bố cục (khung thiệp và vùng viết)</legend>
                <div className="layout-options">
                  {LAYOUTS.map((l) => (
                    <label key={l.id} className={`layout-option${form.layout === l.id ? ' layout-option--selected' : ''}`}>
                      <input
                        type="radio"
                        name="layout"
                        value={l.id}
                        checked={form.layout === l.id}
                        onChange={() => setForm((f) => ({ ...f, layout: l.id }))}
                      />
                      <span className={`layout-icon layout-icon--${l.ratio}`} aria-hidden="true">
                        <i style={{ left: `${l.zone.x}%`, top: `${l.zone.y}%`, width: `${l.zone.w}%`, height: `${l.zone.h}%` }} />
                      </span>
                      {l.name}
                    </label>
                  ))}
                </div>
              </fieldset>

              <label className="write-anon" style={{ gap: '0.5rem' }}>
                <input
                  type="checkbox"
                  checked={form.active === 1}
                  onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked ? 1 : 0 }))}
                />
                Hiện cho học sinh chọn (đang hoạt động)
              </label>

              {/* Slot pickers */}
              {uploadError && <p className="admin-error" role="alert">{uploadError}</p>}
              {loadingImages && <p className="admin-loading">Đang tải thư viện ảnh...</p>}
              {!loadingImages && SLOTS.map((slot) => {
                const current = form.images[slot]
                return (
                  <div key={slot} className="slot-picker">
                    <span className="slot-picker-label">{SLOT_LABELS[slot]}</span>
                    <small>{SIZE_HINT[resolveLayout(form.layout).ratio]}</small>
                    <div className="slot-picker-row">
                      {current ? (
                        <>
                          <img src={`/api/image/${current.token}`} alt="" className="slot-thumb" aria-hidden="true" />
                          <button
                            type="button"
                            className="btn-ghost"
                            onClick={() => setForm((f) => ({ ...f, images: { ...f.images, [slot]: null } }))}
                          >
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
                          setForm((f) => ({
                            ...f,
                            images: { ...f.images, [slot]: img ? { id: img.id, token: img.token } : null },
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

              <div className="form-actions">
                <button type="submit" disabled={saving || !form.name.trim()}>
                  {saving ? 'Đang lưu...' : 'Lưu'}
                </button>
                <button type="button" className="btn-ghost" onClick={cancelEdit}>Hủy</button>
              </div>
            </form>

            {/* Live preview */}
            <div className="teacher-editor-preview">
              <p className="kicker" style={{ marginBottom: '0.5rem' }}>Xem trước</p>
              <div className="preview-wrap">
                <CardView
                  card={SAMPLE_CARD}
                  layout={form.layout}
                  images={previewImages}
                  showZone
                />
              </div>
            </div>
          </div>
        </div>
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
