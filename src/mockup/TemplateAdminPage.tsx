/**
 * TemplateAdminPage — /mockup/admin-mau-thiep
 *
 * Admin page for managing card templates.
 * Features:
 *   - Grid of existing templates with usage counts and edit button
 *   - Create / edit form: name, layout select, three image slot placeholders,
 *     live CardView preview with sample text
 * All state is local — no API calls.
 */
import { useState } from 'react'
import CardView, { LAYOUTS } from '../components/CardView.tsx'
import { CARDS, TEMPLATES, type Template } from './data.ts'

type TemplateForm = { name: string; layout: string }

const SAMPLE_CARD = {
  name: 'Tên thầy cô',
  subject: 'Môn học',
  message: 'Lời chúc chân thành từ học sinh CLB AI đến thầy cô nhân ngày Nhà giáo Việt Nam 20/11.',
  title: 'Thầy' as const,
}

const IMAGE_SLOTS = ['Ảnh nền (background)', 'Ảnh banner', 'Ảnh thầy cô (photo)']

export default function TemplateAdminPage() {
  const [templates, setTemplates] = useState<Template[]>([...TEMPLATES])
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [form, setForm] = useState<TemplateForm>({ name: '', layout: 'classic' })

  function usageCount(tplId: number): number {
    return CARDS.filter((c) => c.templateId === tplId).length
  }

  function startEdit(tpl: Template) {
    setEditing(tpl.id)
    setForm({ name: tpl.name, layout: tpl.layout })
  }

  function startNew() {
    setEditing('new')
    setForm({ name: '', layout: 'classic' })
  }

  function handleSave() {
    if (!form.name.trim()) return
    if (editing === 'new') {
      const newId = Math.max(0, ...templates.map((t) => t.id)) + 1
      setTemplates((prev) => [
        ...prev,
        { id: newId, name: form.name.trim(), layout: form.layout },
      ])
    } else if (editing !== null) {
      const editId = editing
      setTemplates((prev) =>
        prev.map((t) =>
          t.id === editId
            ? { ...t, name: form.name.trim(), layout: form.layout }
            : t,
        ),
      )
    }
    setEditing(null)
  }

  function handleCancel() {
    setEditing(null)
  }

  return (
    <div className="admin-template-page">
      <div className="admin-header">
        <h1>Mẫu thiệp</h1>
        <button type="button" onClick={startNew}>
          + Thêm mẫu
        </button>
      </div>

      {/* Template grid */}
      <div className="template-grid-admin">
        {templates.map((tpl) => (
          <div
            key={tpl.id}
            className={`template-admin-tile${editing === tpl.id ? ' template-admin-tile--editing' : ''}`}
          >
            <div className="card-mini">
              <div className="card-mini-inner">
                <CardView card={SAMPLE_CARD} layout={tpl.layout} images={{}} />
              </div>
            </div>
            <div className="template-admin-name">{tpl.name}</div>
            <div className="template-admin-count">
              {usageCount(tpl.id)} thiệp đã dùng
            </div>
            <button type="button" className="btn-ghost" onClick={() => startEdit(tpl)}>
              Sửa
            </button>
          </div>
        ))}
      </div>

      {/* Create / edit form */}
      {editing !== null && (
        <div className="admin-form template-edit-form">
          <h2>{editing === 'new' ? 'Thêm mẫu thiệp mới' : 'Chỉnh sửa mẫu thiệp'}</h2>

          <label>
            Tên mẫu
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="VD: Hoa sen hồng"
            />
          </label>

          <label>
            Bố cục (layout)
            <select
              value={form.layout}
              onChange={(e) => setForm((f) => ({ ...f, layout: e.target.value }))}
            >
              {LAYOUTS.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>

          {/* Image slot placeholders */}
          <div>
            <p style={{ margin: '0 0 0.5rem', fontWeight: 600, fontSize: '0.9rem' }}>
              Ảnh đính kèm
            </p>
            {IMAGE_SLOTS.map((label) => (
              <div key={label} className="template-slot-row">
                <span className="template-slot-label">{label}</span>
                <button type="button" className="btn-ghost template-slot-btn">
                  Chọn ảnh
                </button>
              </div>
            ))}
            <small>Chức năng tải ảnh sẽ có sau khi triển khai backend.</small>
          </div>

          <div className="form-actions">
            <button
              type="button"
              onClick={handleSave}
              disabled={!form.name.trim()}
            >
              Lưu
            </button>
            <button type="button" className="btn-ghost" onClick={handleCancel}>
              Huỷ
            </button>
          </div>

          {/* Live preview */}
          <div>
            <p className="preview-label">Xem trước</p>
            <div className="preview-wrap">
              <CardView card={SAMPLE_CARD} layout={form.layout} images={{}} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
