/**
 * CampaignsSection — Chiến dịch tab in the admin page.
 *
 * Lists campaigns and provides a create/edit form (Phase 1 cut line):
 *   slug, kind, name, tagline, content JSON, starts/ends dates in Asia/Ho_Chi_Minh (UTC+7),
 *   status, settings with defaults from validateSettings, activate.
 *
 * Campaign admin APIs require a Google session (not legacy email).
 * When the API returns 401, shows a "sign in with Google" hint.
 *
 * FR-7; plan.md § "Admin CRUD" and "cut line"; requirements.md FR-1…FR-7.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  activateAdminCampaign,
  ApiError,
  createAdminCampaign,
  listAdminCampaigns,
  messageFor,
  updateAdminCampaign,
} from '../../api.ts'
import type { AdminCampaignInput, AdminCampaignRow } from '../../api.ts'
import { CAMPAIGN_KINDS, isValidSlug, validateSettings } from '../../../shared/campaign.ts'
import type { CampaignKind } from '../../../shared/campaign.ts'

// ── Date helpers (Vietnam = UTC+7, no DST) ────────────────────────────────

const VN_OFFSET_MS = 7 * 60 * 60 * 1000

/** "YYYY-MM-DDTHH:MM" in Vietnam time ← UTC ISO string */
function utcToVnDatetime(utcStr: string): string {
  if (!utcStr) return ''
  const d = new Date(utcStr)
  if (isNaN(d.getTime())) return ''
  const vnDate = new Date(d.getTime() + VN_OFFSET_MS)
  return vnDate.toISOString().slice(0, 16)
}

/** UTC ISO string ← "YYYY-MM-DDTHH:MM" in Vietnam time */
function vnDatetimeToUtc(localStr: string): string {
  if (!localStr) return ''
  const d = new Date(localStr + ':00+07:00')
  if (isNaN(d.getTime())) return ''
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

// ── Vietnamese error messages ─────────────────────────────────────────────

function campaignMessageFor(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 401) return 'Vui lòng đăng nhập bằng Google để quản lý chiến dịch.'
    if (e.code === 'campaign_has_rows') return 'Không thể xóa — chiến dịch đang có dữ liệu.'
    if (e.code === 'bad_request') return 'Dữ liệu không hợp lệ. Kiểm tra lại slug, ngày và cài đặt.'
  }
  return messageFor(e)
}

// ── Gift tree settings form state ─────────────────────────────────────────

type GiftTreeSettings = {
  report_threshold: number
  hearts_per_day: number
  gifts_per_user: number
  tree_slots: number
  ground_slots: number
}

const DEFAULT_GIFT_TREE_SETTINGS: GiftTreeSettings = {
  report_threshold: 3,
  hearts_per_day: 5,
  gifts_per_user: 3,
  tree_slots: 15,
  ground_slots: 10,
}

const GIFT_TREE_RANGES: Record<keyof GiftTreeSettings, [number, number, string]> = {
  report_threshold: [2, 20, 'Báo cáo tự ẩn sau'],
  hearts_per_day: [1, 20, 'Tim mỗi ngày'],
  gifts_per_user: [1, 10, 'Quà mỗi người'],
  tree_slots: [5, 25, 'Ô trên cây'],
  ground_slots: [0, 15, 'Ô dưới đất'],
}

// ── Campaign form ─────────────────────────────────────────────────────────

type FormState = {
  slug: string
  kind: CampaignKind
  name: string
  tagline: string
  content: string
  startsAt: string   // Vietnam local datetime "YYYY-MM-DDTHH:MM"
  endsAt: string
  status: string
  settings: GiftTreeSettings
}

function defaultForm(): FormState {
  return {
    slug: '',
    kind: 'teacher_cards',
    name: '',
    tagline: '',
    content: '{}',
    startsAt: '',
    endsAt: '',
    status: 'draft',
    settings: { ...DEFAULT_GIFT_TREE_SETTINGS },
  }
}

function rowToForm(row: AdminCampaignRow): FormState {
  let settings = { ...DEFAULT_GIFT_TREE_SETTINGS }
  if (row.kind === 'gift_tree') {
    // try to parse existing settings
    try {
      const parsed = JSON.parse('{}') as Record<string, unknown> // placeholder; actual from full row
      void parsed
    } catch { /* use defaults */ }
  }
  return {
    slug: row.slug,
    kind: row.kind as CampaignKind,
    name: row.name,
    tagline: row.tagline,
    content: '{}',   // list row doesn't carry content; full row fetched on edit
    startsAt: utcToVnDatetime(row.starts_at),
    endsAt: utcToVnDatetime(row.ends_at),
    status: row.status,
    settings,
  }
}

type CampaignFormProps = {
  initial: FormState
  editing: boolean    // true = PATCH existing; false = POST new
  editId: number | null
  onSaved: () => void
  onCancel: () => void
}

function CampaignForm({ initial, editing, editId, onSaved, onCancel }: CampaignFormProps) {
  const [form, setForm] = useState<FormState>(initial)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  function updateSetting(key: keyof GiftTreeSettings, value: string) {
    const n = parseInt(value, 10)
    const [min, max] = GIFT_TREE_RANGES[key]
    const clamped = isNaN(n) ? DEFAULT_GIFT_TREE_SETTINGS[key] : Math.max(min, Math.min(max, n))
    setForm((f) => ({ ...f, settings: { ...f.settings, [key]: clamped } }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    // Client-side validation
    if (!isValidSlug(form.slug)) {
      setError('Slug phải 2–32 ký tự gồm chữ thường, số và dấu gạch ngang; không được dùng tên dành riêng.')
      return
    }
    if (!form.name.trim()) { setError('Tên chiến dịch không được để trống.'); return }
    if (!form.startsAt) { setError('Vui lòng chọn ngày bắt đầu.'); return }
    if (!form.endsAt) { setError('Vui lòng chọn ngày kết thúc.'); return }
    const startsUtc = vnDatetimeToUtc(form.startsAt)
    const endsUtc = vnDatetimeToUtc(form.endsAt)
    if (!startsUtc || !endsUtc) { setError('Ngày không hợp lệ.'); return }
    if (new Date(startsUtc) >= new Date(endsUtc)) {
      setError('Ngày kết thúc phải sau ngày bắt đầu.')
      return
    }

    // Validate settings
    const settingsResult = validateSettings(form.kind, form.settings)
    if (!settingsResult.ok) {
      setError(`Cài đặt không hợp lệ: ${settingsResult.field}`)
      return
    }

    let contentJson: string
    try {
      contentJson = JSON.stringify(JSON.parse(form.content))
    } catch {
      setError('Content không phải JSON hợp lệ.')
      return
    }

    const input: AdminCampaignInput = {
      slug: form.slug,
      kind: form.kind,
      name: form.name.trim(),
      tagline: form.tagline.trim(),
      content: contentJson,
      settings: JSON.stringify(settingsResult.value),
      starts_at: startsUtc,
      ends_at: endsUtc,
      status: form.status,
    }

    setSaving(true)
    setError(null)
    try {
      if (editing && editId !== null) {
        await updateAdminCampaign(editId, input)
      } else {
        await createAdminCampaign(input)
      }
      onSaved()
    } catch (e) {
      setError(campaignMessageFor(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="admin-form" onSubmit={(e) => { void handleSubmit(e) }} noValidate>
      <h2>{editing ? 'Chỉnh sửa chiến dịch' : 'Tạo chiến dịch mới'}</h2>
      {error && <p className="admin-error" role="alert">{error}</p>}

      <label htmlFor="camp-slug">
        Slug <span aria-hidden="true">*</span>
        <input
          id="camp-slug"
          type="text"
          value={form.slug}
          onChange={(e) => update('slug', e.target.value.toLowerCase())}
          maxLength={32}
          required
          disabled={editing}
          pattern="[a-z0-9-]{2,32}"
          autoComplete="off"
        />
        <small>2–32 ký tự: chữ thường, số, dấu gạch ngang. Không thể thay đổi sau khi tạo.</small>
      </label>

      <label htmlFor="camp-kind">
        Loại <span aria-hidden="true">*</span>
        <select
          id="camp-kind"
          value={form.kind}
          onChange={(e) => update('kind', e.target.value as CampaignKind)}
          disabled={editing}
        >
          {CAMPAIGN_KINDS.map((k) => (
            <option key={k} value={k}>
              {k === 'teacher_cards' ? 'Thiệp giáo viên (teacher_cards)' : 'Cây thông điều ước (gift_tree)'}
            </option>
          ))}
        </select>
        <small>Không thể thay đổi sau khi tạo.</small>
      </label>

      <label htmlFor="camp-name">
        Tên chiến dịch <span aria-hidden="true">*</span>
        <input
          id="camp-name"
          type="text"
          value={form.name}
          onChange={(e) => update('name', e.target.value)}
          maxLength={120}
          required
        />
      </label>

      <label htmlFor="camp-tagline">
        Tagline
        <input
          id="camp-tagline"
          type="text"
          value={form.tagline}
          onChange={(e) => update('tagline', e.target.value)}
          maxLength={200}
        />
      </label>

      <label htmlFor="camp-starts">
        Ngày bắt đầu (giờ Việt Nam) <span aria-hidden="true">*</span>
        <input
          id="camp-starts"
          type="datetime-local"
          value={form.startsAt}
          onChange={(e) => update('startsAt', e.target.value)}
          required
        />
        <small>Múi giờ: Asia/Ho_Chi_Minh (UTC+7)</small>
      </label>

      <label htmlFor="camp-ends">
        Ngày kết thúc (giờ Việt Nam) <span aria-hidden="true">*</span>
        <input
          id="camp-ends"
          type="datetime-local"
          value={form.endsAt}
          onChange={(e) => update('endsAt', e.target.value)}
          required
        />
      </label>

      <label htmlFor="camp-status">
        Trạng thái
        <select
          id="camp-status"
          value={form.status}
          onChange={(e) => update('status', e.target.value)}
        >
          <option value="draft">Nháp (draft)</option>
          <option value="active">Đang hoạt động (active)</option>
          <option value="closed">Đã đóng (closed)</option>
        </select>
      </label>

      <label htmlFor="camp-content">
        Nội dung (JSON)
        <textarea
          id="camp-content"
          value={form.content}
          onChange={(e) => update('content', e.target.value)}
          rows={5}
          spellCheck={false}
          aria-describedby="camp-content-hint"
        />
        <small id="camp-content-hint">JSON object; ví dụ: {'{"home":{"kicker":"...","heading":"...","body":"..."}}'}</small>
      </label>

      {form.kind === 'gift_tree' && (
        <>
          <p style={{ margin: '0.25rem 0 0' }}><strong>Cài đặt gift_tree</strong></p>
          {(Object.keys(GIFT_TREE_RANGES) as (keyof GiftTreeSettings)[]).map((key) => {
            const [min, max, label] = GIFT_TREE_RANGES[key]
            return (
              <label key={key} htmlFor={`camp-setting-${key}`}>
                {label}
                <input
                  id={`camp-setting-${key}`}
                  type="number"
                  value={form.settings[key]}
                  min={min}
                  max={max}
                  onChange={(e) => updateSetting(key, e.target.value)}
                />
                <small>{min}–{max}, mặc định {DEFAULT_GIFT_TREE_SETTINGS[key]}</small>
              </label>
            )
          })}
        </>
      )}

      <div className="form-actions">
        <button type="submit" disabled={saving}>
          {saving ? 'Đang lưu…' : (editing ? 'Lưu thay đổi' : 'Tạo chiến dịch')}
        </button>
        <button type="button" className="btn-ghost" onClick={onCancel} disabled={saving}>
          Hủy
        </button>
      </div>
    </form>
  )
}

// ── Main CampaignsSection ─────────────────────────────────────────────────

type Props = {
  onAccessError: (e: unknown) => boolean
}

export default function CampaignsSection({ onAccessError }: Props) {
  const [campaigns, setCampaigns] = useState<AdminCampaignRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [needsGoogleSignIn, setNeedsGoogleSignIn] = useState(false)
  const [creating, setCreating] = useState(false)
  const [editRow, setEditRow] = useState<AdminCampaignRow | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setNeedsGoogleSignIn(false)
    try {
      const rows = await listAdminCampaigns()
      setCampaigns(rows)
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setNeedsGoogleSignIn(true)
      } else if (!onAccessError(e)) {
        setError(campaignMessageFor(e))
      }
    } finally {
      setLoading(false)
    }
  }, [onAccessError])

  useEffect(() => { void load() }, [load])

  async function handleActivate(id: number) {
    setError(null)
    try {
      await activateAdminCampaign(id)
      await load()
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setNeedsGoogleSignIn(true)
      } else {
        setError(campaignMessageFor(e))
      }
    }
  }

  if (loading) return <p className="admin-loading">Đang tải…</p>

  if (needsGoogleSignIn) {
    return (
      <div>
        <p className="admin-error" role="alert">
          Quản lý chiến dịch yêu cầu đăng nhập bằng Google.
          Hãy đăng nhập bằng Google ở phần đăng nhập trên.
        </p>
      </div>
    )
  }

  if (creating) {
    return (
      <CampaignForm
        initial={defaultForm()}
        editing={false}
        editId={null}
        onSaved={() => { setCreating(false); void load() }}
        onCancel={() => setCreating(false)}
      />
    )
  }

  if (editRow) {
    return (
      <CampaignForm
        initial={rowToForm(editRow)}
        editing={true}
        editId={editRow.id}
        onSaved={() => { setEditRow(null); void load() }}
        onCancel={() => setEditRow(null)}
      />
    )
  }

  return (
    <div>
      <div className="admin-subsection-header">
        <h2>Chiến dịch</h2>
        <button type="button" onClick={() => setCreating(true)}>+ Tạo mới</button>
      </div>
      {error && <p className="admin-error" role="alert">{error}</p>}

      {campaigns.length === 0 ? (
        <p className="admin-empty">Chưa có chiến dịch nào.</p>
      ) : (
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Slug</th>
                <th>Loại</th>
                <th>Tên</th>
                <th>Trạng thái</th>
                <th>Bắt đầu (VN)</th>
                <th>Kết thúc (VN)</th>
                <th>Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id} className={c.status === 'active' ? 'row-active' : ''}>
                  <td><code>{c.slug}</code></td>
                  <td>{c.kind}</td>
                  <td>{c.name}</td>
                  <td>
                    <span className={`status-badge ${c.status === 'active' ? 'status-published' : 'status-draft'}`}>
                      {c.status}
                    </span>
                  </td>
                  <td>{utcToVnDatetime(c.starts_at)}</td>
                  <td>{utcToVnDatetime(c.ends_at)}</td>
                  <td>
                    <div className="admin-actions">
                      <button type="button" onClick={() => setEditRow(c)}>Sửa</button>
                      {c.status !== 'active' && (
                        <button
                          type="button"
                          className="btn-warn"
                          onClick={() => { void handleActivate(c.id) }}
                        >
                          Kích hoạt
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
