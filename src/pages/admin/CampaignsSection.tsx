/**
 * CampaignsSection — Chiến dịch tab in the admin page.
 *
 * Lists campaigns and provides a create/edit form (Phase 1 cut line):
 *   slug, kind, name, tagline, content JSON, starts/ends dates in Asia/Ho_Chi_Minh (UTC+7),
 *   settings with defaults, activate and close.
 *
 * Editing fetches the full row via GET /api/admin/campaigns/<id> so that content,
 * theme_colors and settings are populated from D1, not defaulted to {}. (Fix F2.)
 *
 * Campaign admin APIs require a Google session (not legacy email).
 * When the API returns 401, shows a "sign in with Google" hint.
 *
 * Status changes go only through activate/close (decisions.md 2026-11-16 item 5).
 * PATCH does NOT send status.
 *
 * FR-7; plan.md § "Admin CRUD" and "cut line"; requirements.md FR-1…FR-7.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  activateAdminCampaign,
  closeAdminCampaign,
  ApiError,
  createAdminCampaign,
  getAdminCampaign,
  listAdminCampaigns,
  messageFor,
  updateAdminCampaign,
} from '../../api.ts'
import type { AdminCampaignRow } from '../../api.ts'
import { isValidSlug, validateSettings } from '../../../shared/campaign.ts'
import {
  rowToForm,
  formToInput,
  defaultForm,
  utcToVnDatetime,
  vnDatetimeToUtc,
  clampSetting,
  DEFAULT_GIFT_TREE_SETTINGS,
  GIFT_TREE_RANGES,
  type CampaignFormState,
  type GiftTreeSettings,
  type AdminCampaignFullRow,
} from './campaignFormHelpers.ts'

// ── Vietnamese error messages ─────────────────────────────────────────────

function campaignMessageFor(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 401) return 'Vui lòng đăng nhập bằng Google để quản lý chiến dịch.'
    if (e.code === 'bad_request') return 'Dữ liệu không hợp lệ. Kiểm tra lại slug, ngày và cài đặt.'
  }
  return messageFor(e)
}

// ── Campaign form ─────────────────────────────────────────────────────────

type CampaignFormProps = {
  initial: CampaignFormState
  editing: boolean    // true = PATCH existing; false = POST new
  editId: number | null
  onSaved: () => void
  onCancel: () => void
}

function CampaignForm({ initial, editing, editId, onSaved, onCancel }: CampaignFormProps) {
  const [form, setForm] = useState<CampaignFormState>(initial)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Raw string values displayed in the inputs while typing.
  // Validated and clamped on blur and submit — not on every keystroke.
  // This allows typing intermediate values like "12" without being snapped to a boundary.
  const [rawSettings, setRawSettings] = useState<Record<keyof GiftTreeSettings, string>>(
    () => Object.fromEntries(
      (Object.keys(GIFT_TREE_RANGES) as (keyof GiftTreeSettings)[]).map((k) => [
        k, String(initial.settings[k]),
      ])
    ) as Record<keyof GiftTreeSettings, string>,
  )

  function update<K extends keyof CampaignFormState>(key: K, value: CampaignFormState[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  /** Update raw display only — does NOT clamp. */
  function handleSettingChange(key: keyof GiftTreeSettings, value: string) {
    setRawSettings((r) => ({ ...r, [key]: value }))
  }

  /** Clamp and commit on blur — syncs both display and form state. */
  function handleSettingBlur(key: keyof GiftTreeSettings) {
    const clamped = clampSetting(key, rawSettings[key])
    setRawSettings((r) => ({ ...r, [key]: String(clamped) }))
    setForm((f) => ({ ...f, settings: { ...f.settings, [key]: clamped } }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    // Client-side validation
    if (!editing && !isValidSlug(form.slug)) {
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

    // Derive current settings from raw values (bypasses stale form.settings if the user
    // typed without blurring before submitting).
    const currentSettings = Object.fromEntries(
      (Object.keys(GIFT_TREE_RANGES) as (keyof GiftTreeSettings)[]).map((k) => [
        k, clampSetting(k, rawSettings[k]),
      ])
    ) as GiftTreeSettings

    // Validate settings
    const settingsResult = validateSettings(form.kind, currentSettings)
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

    const input = formToInput({ ...form, settings: currentSettings, content: contentJson }, editing)

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
          onChange={(e) => update('kind', e.target.value as CampaignFormState['kind'])}
          disabled={editing}
        >
          <option value="teacher_cards">Thiệp giáo viên (teacher_cards)</option>
          <option value="gift_tree">Cây thông điều ước (gift_tree)</option>
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
                  value={rawSettings[key]}
                  min={min}
                  max={max}
                  onChange={(e) => handleSettingChange(key, e.target.value)}
                  onBlur={() => handleSettingBlur(key)}
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
  const [editForm, setEditForm] = useState<{ id: number; initial: CampaignFormState } | null>(null)

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

  async function handleClose(id: number) {
    setError(null)
    try {
      await closeAdminCampaign(id)
      await load()
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setNeedsGoogleSignIn(true)
      } else {
        setError(campaignMessageFor(e))
      }
    }
  }

  /**
   * Fetch the full campaign row (with content/settings/theme_colors) before opening the editor.
   * Using the list row would leave content as {} — that is F2.
   */
  async function handleEdit(id: number) {
    setError(null)
    try {
      const full: AdminCampaignFullRow = await getAdminCampaign(id)
      setEditForm({ id, initial: rowToForm(full) })
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

  if (editForm) {
    return (
      <CampaignForm
        initial={editForm.initial}
        editing={true}
        editId={editForm.id}
        onSaved={() => { setEditForm(null); void load() }}
        onCancel={() => setEditForm(null)}
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
            <caption>Danh sách chiến dịch</caption>
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
                      <button
                        type="button"
                        aria-label={`Sửa chiến dịch ${c.name}`}
                        onClick={() => { void handleEdit(c.id) }}
                      >
                        Sửa
                      </button>
                      {c.status !== 'active' && (
                        <button
                          type="button"
                          className="btn-warn"
                          aria-label={`Kích hoạt chiến dịch ${c.name}`}
                          onClick={() => {
                            if (window.confirm(`Kích hoạt chiến dịch "${c.name}"?\nChiến dịch đang hoạt động sẽ bị đóng.`)) {
                              void handleActivate(c.id)
                            }
                          }}
                        >
                          Kích hoạt
                        </button>
                      )}
                      {c.status === 'active' && (
                        <button
                          type="button"
                          className="btn-ghost"
                          aria-label={`Đóng chiến dịch ${c.name}`}
                          onClick={() => { void handleClose(c.id) }}
                        >
                          Đóng
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
