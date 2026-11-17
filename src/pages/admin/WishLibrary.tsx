/**
 * WishLibrary — create, edit, delete and search the wish library.
 */
import { useEffect, useState } from 'react'
import {
  type WishRow,
  ApiError,
  createWish,
  deleteWish,
  listWishes,
  messageFor,
  updateWish,
} from '../../api'

export default function WishLibrary({
  onAccessError,
}: {
  onAccessError: (e: unknown) => boolean
}) {
  const [wishes, setWishes] = useState<WishRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [adding, setAdding] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)

  // form state
  const [formTitle, setFormTitle] = useState('')
  const [formBody, setFormBody] = useState('')

  useEffect(() => {
    setLoading(true)
    listWishes()
      .then(setWishes)
      .catch((e) => {
        if (!onAccessError(e)) {
          setError(messageFor(e))
        }
      })
      .finally(() => { setLoading(false) })
  }, [onAccessError])

  function openAdd() {
    setAdding(true)
    setEditId(null)
    setFormTitle('')
    setFormBody('')
    setError(null)
  }

  function openEdit(w: WishRow) {
    setEditId(w.id)
    setAdding(false)
    setFormTitle(w.title)
    setFormBody(w.body)
    setError(null)
  }

  function cancelForm() {
    setAdding(false)
    setEditId(null)
    setFormTitle('')
    setFormBody('')
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const t = formTitle.trim()
    const b = formBody.trim()
    if (!t || !b) { setError('Tiêu đề và nội dung không được để trống'); return }
    if (t.length > 80) { setError('Tiêu đề tối đa 80 ký tự'); return }
    if (b.length > 600) { setError('Nội dung tối đa 600 ký tự'); return }
    try {
      if (editId !== null) {
        const updated = await updateWish(editId, t, b)
        setWishes((ws) => ws.map((x) => (x.id === updated.id ? updated : x)))
        cancelForm()
      } else {
        const created = await createWish(t, b)
        setWishes((ws) => [...ws, created])
        cancelForm()
      }
    } catch (err) {
      if (!onAccessError(err)) {
        if (err instanceof ApiError && err.status === 409) {
          setError('Đã đạt giới hạn thư viện lời chúc (200 lời chúc)')
        } else {
          setError(messageFor(err))
        }
      }
    }
  }

  async function handleDelete(w: WishRow) {
    if (!confirm(`Xóa lời chúc "${w.title}"?`)) return
    setError(null)
    try {
      await deleteWish(w.id)
      setWishes((ws) => ws.filter((x) => x.id !== w.id))
      if (editId === w.id) cancelForm()
    } catch (err) {
      if (!onAccessError(err)) {
        setError(messageFor(err))
      }
    }
  }

  const lowerSearch = search.toLowerCase()
  const visible = wishes.filter(
    (w) =>
      w.title.toLowerCase().includes(lowerSearch) ||
      w.body.toLowerCase().includes(lowerSearch),
  )

  return (
    <div>
      <div className="admin-subsection-header">
        <h2>Thư viện lời chúc</h2>
        <button onClick={openAdd} disabled={adding}>+ Thêm lời chúc</button>
      </div>

      {error && <p className="admin-error" role="alert">{error}</p>}

      {(adding || editId !== null) && (
        <form className="admin-form" onSubmit={(e) => { void handleSave(e) }}>
          <h2>{editId !== null ? 'Sửa lời chúc' : 'Thêm lời chúc'}</h2>
          <label>
            Tiêu đề <span aria-hidden="true">*</span>
            <input
              type="text"
              value={formTitle}
              onChange={(e) => setFormTitle(e.target.value)}
              maxLength={80}
              required
              autoFocus
            />
            <small>{formTitle.length}/80 ký tự</small>
          </label>
          <label>
            Nội dung <span aria-hidden="true">*</span>
            <textarea
              value={formBody}
              onChange={(e) => setFormBody(e.target.value)}
              maxLength={600}
              rows={5}
              required
              placeholder="Dùng {tên} và {môn} để điền tên và môn dạy tự động."
            />
            <small>{formBody.length}/600 ký tự</small>
          </label>
          <div className="form-actions">
            <button type="submit">Lưu</button>
            <button type="button" className="btn-ghost" onClick={cancelForm}>Hủy</button>
          </div>
        </form>
      )}

      <input
        type="search"
        className="wish-search"
        placeholder="Tìm lời chúc..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        aria-label="Tìm kiếm lời chúc"
      />

      {loading && <p className="admin-loading">Đang tải...</p>}

      {!loading && visible.length === 0 && (
        <p className="admin-empty">
          {search ? 'Không tìm thấy lời chúc nào.' : 'Thư viện trống. Hãy thêm lời chúc đầu tiên.'}
        </p>
      )}

      {!loading && visible.length > 0 && (
        <ul className="wish-list">
          {visible.map((w) => (
            <li key={w.id} className={`wish-item${editId === w.id ? ' wish-item--active' : ''}`}>
              <div className="wish-item-content">
                <strong className="wish-title">{w.title}</strong>
                <p className="wish-body">{w.body}</p>
              </div>
              <div className="wish-item-actions">
                <button
                  type="button"
                  onClick={() => openEdit(w)}
                  aria-label={`Sửa lời chúc "${w.title}"`}
                >
                  Sửa
                </button>
                <button
                  type="button"
                  onClick={() => { void handleDelete(w) }}
                  className="btn-danger"
                  aria-label={`Xóa lời chúc "${w.title}"`}
                >
                  Xóa
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
