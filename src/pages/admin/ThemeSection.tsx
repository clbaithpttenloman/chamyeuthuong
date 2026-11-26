/**
 * ThemeSection — Chủ đề cây thông (Phase 3).
 *
 * One card per gift-tree slot (stills, animated loops and sprite sheets). Each card shows the rule
 * checklist (size, formats including GIF, transparency, animation, size limit), the upload in use or
 * the default art, an upload control and "Dùng mặc định". Sprite slots also take the playback speed
 * (fps) at upload. The server checks every file and returns the reasons in Vietnamese.
 * Works for draft campaigns too, because it reads the admin theme list, not the public one.
 */
import { useCallback, useEffect, useState } from 'react'
import { THEME_SLOTS, type ThemeAsset, type ThemeSlotSpec } from '../../../shared/themeSlots.ts'
import {
  type AdminCampaignRow,
  getAdminThemeMap,
  listAdminCampaigns,
  messageFor,
  resetThemeImage,
  uploadThemeImage,
} from '../../api'
import { DEFAULT_THEME_URLS } from '../../game/defaultTheme.ts'
import { slotChecklist } from './themeSpec.ts'

type Props = {
  onAccessError: (e: unknown) => boolean
}

type CardState = { busy: boolean; errors: string[]; notice: string | null }

const EMPTY_CARD: CardState = { busy: false, errors: [], notice: null }
const DEFAULT_FPS = 24

const CHECKER = 'repeating-conic-gradient(#e5e7eb 0 25%, #ffffff 0 50%) 0 0 / 16px 16px'

/** What the admin sees as the current state of a slot. */
function currentLabel(spec: ThemeSlotSpec, asset: ThemeAsset | undefined): string {
  if (asset) {
    if (spec.animation === 'sprite') return `Đang dùng lưới ${asset.cols}×${asset.rows} (${asset.frames} khung, ${asset.fps} fps)`
    if (spec.animation === 'loop' && asset.frames > 1) return `Đang dùng hoạt ảnh ${asset.frames} khung`
    return 'Đang dùng ảnh tải lên'
  }
  if (spec.slot in DEFAULT_THEME_URLS) return 'Đang dùng ảnh mặc định'
  if (spec.animation === 'sprite') return 'Chưa có: mở hộp dùng hiệu ứng mặc định'
  return 'Chưa có: ô này không hiển thị'
}

export default function ThemeSection({ onAccessError }: Props) {
  const [campaigns, setCampaigns] = useState<AdminCampaignRow[]>([])
  const [campaignId, setCampaignId] = useState<number | null>(null)
  const [theme, setTheme] = useState<Record<string, ThemeAsset>>({})
  const [cards, setCards] = useState<Record<string, CardState>>({})
  const [fpsBySlot, setFpsBySlot] = useState<Record<string, number>>({})
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    listAdminCampaigns()
      .then((rows) => {
        if (!alive) return
        const kind = rows.filter((r) => r.kind === 'gift_tree')
        setCampaigns(kind)
        setCampaignId(kind[0]?.id ?? null)
      })
      .catch((e) => {
        if (alive && !onAccessError(e)) setLoadError(messageFor(e))
      })
    return () => { alive = false }
  }, [onAccessError])

  const loadTheme = useCallback(async (id: number) => {
    setLoadError(null)
    try {
      setTheme(await getAdminThemeMap(id))
    } catch (e) {
      if (!onAccessError(e)) setLoadError(messageFor(e))
    }
  }, [onAccessError])

  useEffect(() => {
    if (campaignId === null) return
    setCards({})
    loadTheme(campaignId)
  }, [campaignId, loadTheme])

  const setCard = (slot: string, patch: Partial<CardState>) =>
    setCards((prev) => ({ ...prev, [slot]: { ...(prev[slot] ?? EMPTY_CARD), ...patch } }))

  async function upload(spec: ThemeSlotSpec, file: File | undefined) {
    if (campaignId === null || !file) return
    setCard(spec.slot, { busy: true, errors: [], notice: null })
    const fps = spec.animation === 'sprite' ? (fpsBySlot[spec.slot] ?? DEFAULT_FPS) : undefined
    try {
      const result = await uploadThemeImage(campaignId, spec.slot, file, fps)
      if (result.ok) {
        await loadTheme(campaignId)
        setCard(spec.slot, { busy: false, notice: 'Đã lưu.' })
      } else {
        setCard(spec.slot, { busy: false, errors: result.errors })
      }
    } catch (e) {
      if (onAccessError(e)) return
      setCard(spec.slot, { busy: false, errors: [messageFor(e)] })
    }
  }

  async function resetToDefault(spec: ThemeSlotSpec) {
    if (campaignId === null) return
    setCard(spec.slot, { busy: true, errors: [], notice: null })
    try {
      await resetThemeImage(campaignId, spec.slot)
      await loadTheme(campaignId)
      setCard(spec.slot, { busy: false, notice: 'Đã đặt về mặc định.' })
    } catch (e) {
      if (onAccessError(e)) return
      setCard(spec.slot, { busy: false, errors: [messageFor(e)] })
    }
  }

  if (campaigns.length === 0 && !loadError) {
    return <p>Chưa có chiến dịch cây thông nào. Tạo chiến dịch ở mục «Chiến dịch» trước.</p>
  }

  return (
    <section aria-label="Chủ đề cây thông">
      <h2>Chủ đề cây thông</h2>
      <p>
        Thay ảnh của từng phần cây. Ô nào chưa tải lên sẽ dùng ảnh mặc định, nếu có. Mỗi ô có quy định riêng về
        kích thước, định dạng (PNG, JPEG, WebP, GIF), nền và hoạt ảnh. Ảnh có metadata (EXIF, XMP, chú thích) bị từ chối.
      </p>

      {campaigns.length > 1 && (
        <label>
          Chiến dịch{' '}
          <select value={campaignId ?? ''} onChange={(e) => setCampaignId(Number(e.target.value))}>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>{c.name} ({c.status === 'draft' ? 'nháp' : c.status})</option>
            ))}
          </select>
        </label>
      )}

      {loadError && <p role="alert">{loadError}</p>}

      <div className="theme-grid" style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
        {THEME_SLOTS.map((spec) => {
          const card = cards[spec.slot] ?? EMPTY_CARD
          const asset = theme[spec.slot]
          const src = asset?.url ?? DEFAULT_THEME_URLS[spec.slot as keyof typeof DEFAULT_THEME_URLS]
          const inputId = `theme-file-${spec.slot}`
          const fpsId = `theme-fps-${spec.slot}`
          return (
            <article key={spec.slot} aria-label={spec.purpose} style={{ border: '1px solid #d1d5db', borderRadius: '0.5rem', padding: '0.75rem' }}>
              <h3 style={{ margin: '0 0 0.5rem', fontSize: '1rem' }}>{spec.purpose}</h3>
              <div style={{ background: CHECKER, height: 140, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {src
                  ? <img src={src} alt={`Ảnh hiện tại: ${spec.purpose}`} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
                  : <span style={{ fontSize: '0.875rem', color: '#4b5563' }}>Không có ảnh</span>}
              </div>
              <p style={{ fontSize: '0.875rem', margin: '0.5rem 0' }}>{currentLabel(spec, asset)}</p>
              <ul style={{ fontSize: '0.875rem', paddingLeft: '1.25rem' }}>
                {slotChecklist(spec).map((line) => <li key={line}>{line}</li>)}
              </ul>
              {spec.animation === 'sprite' && (
                <div style={{ marginTop: '0.5rem' }}>
                  <label htmlFor={fpsId}>Tốc độ (fps) </label>
                  <input
                    id={fpsId}
                    type="number"
                    min={spec.fps?.min ?? 12}
                    max={spec.fps?.max ?? 30}
                    step={1}
                    value={fpsBySlot[spec.slot] ?? DEFAULT_FPS}
                    onChange={(e) => setFpsBySlot((prev) => ({ ...prev, [spec.slot]: Number(e.target.value) }))}
                    style={{ width: '5rem' }}
                  />
                </div>
              )}
              <label htmlFor={inputId} style={{ display: 'block', marginTop: '0.5rem' }}>Chọn tệp mới</label>
              <input
                id={inputId}
                type="file"
                accept={spec.formats.join(',')}
                disabled={card.busy || campaignId === null}
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  e.target.value = ''
                  void upload(spec, file)
                }}
              />
              <div style={{ marginTop: '0.5rem' }}>
                <button type="button" disabled={card.busy || !asset || campaignId === null} onClick={() => void resetToDefault(spec)}>
                  {spec.slot in DEFAULT_THEME_URLS ? 'Dùng mặc định' : 'Xóa ảnh'}
                </button>
              </div>
              {card.busy && <p role="status">Đang xử lý…</p>}
              {card.notice && <p role="status">{card.notice}</p>}
              {card.errors.length > 0 && (
                <ul role="alert" style={{ color: '#b91c1c', fontSize: '0.875rem' }}>
                  {card.errors.map((msg) => <li key={msg}>{msg}</li>)}
                </ul>
              )}
            </article>
          )
        })}
      </div>
    </section>
  )
}
