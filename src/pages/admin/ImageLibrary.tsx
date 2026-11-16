/**
 * ImageLibrary — upload, browse, and delete images.
 * Images are compressed client-side before upload (max 1280 px, ≤ 300 KB).
 */
import { useEffect, useRef, useState } from 'react'
import { type ImageRow, ApiError, deleteImage, listImages, uploadImage } from '../../api'
import { compressImage } from '../../imageCompress.ts'

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp']

function uploadErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409) return 'Đã đạt giới hạn thư viện ảnh (200 ảnh hoặc 40 MB)'
    if (err.status === 400) return 'Ảnh không hợp lệ. Vui lòng chọn ảnh JPEG, PNG hoặc WebP nhỏ hơn 300 KB.'
    if (err.status === 413) return 'Ảnh quá lớn. Vui lòng chọn ảnh nhỏ hơn 300 KB.'
  }
  if (err instanceof Error) return err.message
  return 'Lỗi tải ảnh lên'
}

export type ImageLibraryHandle = {
  reload: () => Promise<void>
}

export default function ImageLibrary({
  onAccessError,
}: {
  onAccessError: (e: unknown) => boolean
}) {
  const [images, setImages] = useState<ImageRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function loadImages() {
    setLoading(true)
    try {
      setImages(await listImages())
    } catch (e) {
      if (!onAccessError(e)) {
        setError(e instanceof Error ? e.message : 'Lỗi tải thư viện ảnh')
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadImages()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!e.target.files) return
    // Reset so the same file can be re-selected
    e.target.value = ''
    if (!file) return

    if (!ACCEPTED_TYPES.includes(file.type)) {
      setError('Chỉ chấp nhận ảnh JPEG, PNG hoặc WebP.')
      return
    }

    setError(null)
    setUploading(true)
    try {
      const compressed = await compressImage(file, { maxBytes: 307200, maxDim: 1280 })
      const imageName = file.name.replace(/\.[^.]+$/, '').slice(0, 80) || 'image'
      const uploaded = await uploadImage(compressed, imageName)
      setImages((imgs) => [...imgs, uploaded])
    } catch (err) {
      if (!onAccessError(err)) {
        setError(uploadErrorMessage(err))
      }
    } finally {
      setUploading(false)
    }
  }

  async function handleDelete(img: ImageRow) {
    if (img.used_by > 0) {
      setError(`Ảnh "${img.name}" đang được dùng trong ${img.used_by} thiệp, không thể xóa.`)
      return
    }
    if (!confirm(`Xóa ảnh "${img.name}"? Hành động này không thể hoàn tác.`)) return
    setError(null)
    try {
      await deleteImage(img.id)
      setImages((imgs) => imgs.filter((x) => x.id !== img.id))
    } catch (err) {
      if (!onAccessError(err)) {
        if (err instanceof ApiError && err.status === 409) {
          setError(`Ảnh "${img.name}" đang được dùng trong thiệp, không thể xóa.`)
        } else {
          setError(err instanceof Error ? err.message : 'Lỗi xóa ảnh')
        }
      }
    }
  }

  const usedCount = images.filter((img) => img.used_by > 0).length

  return (
    <div>
      <div className="admin-subsection-header">
        <h2>Thư viện ảnh</h2>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <span className="admin-loading" style={{ fontSize: '0.8rem', margin: 0 }}>
            {images.length}/200 ảnh · {usedCount} đang dùng
          </span>
          <button
            onClick={() => { fileInputRef.current?.click() }}
            disabled={uploading}
          >
            {uploading ? 'Đang tải lên...' : '+ Tải ảnh lên'}
          </button>
        </div>
      </div>

      {/* Hidden file input — only JPEG/PNG/WebP */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        style={{ display: 'none' }}
        onChange={(e) => { void handleFileChange(e) }}
        aria-label="Chọn ảnh để tải lên"
      />

      {error && <p className="admin-error" role="alert">{error}</p>}

      {loading && <p className="admin-loading">Đang tải...</p>}

      {!loading && images.length === 0 && (
        <p className="admin-empty">Thư viện trống. Tải ảnh lên để bắt đầu.</p>
      )}

      {!loading && images.length > 0 && (
        <div className="image-grid">
          {images.map((img) => (
            <div key={img.id} className="image-tile">
              <img
                src={`/api/image/${img.token}`}
                alt={img.name}
                className="image-thumb"
                loading="lazy"
              />
              <div className="image-tile-info">
                <span className="image-name" title={img.name}>{img.name}</span>
                <span className="image-meta">
                  {(img.size / 1024).toFixed(0)} KB
                  {img.used_by > 0 && (
                    <span className="image-used"> · {img.used_by} thiệp</span>
                  )}
                </span>
              </div>
              <button
                type="button"
                onClick={() => { void handleDelete(img) }}
                className={img.used_by > 0 ? 'btn-warn' : 'btn-danger'}
                aria-label={`Xóa ảnh ${img.name}`}
                title={img.used_by > 0 ? 'Đang được dùng trong thiệp' : undefined}
              >
                Xóa
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
