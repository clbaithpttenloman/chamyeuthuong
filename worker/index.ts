import { handlePublic } from './public.ts'
import { handleSubmit } from './submit.ts'
import { handleQr } from './qr.ts'
import { handleAdmin } from './admin.ts'
import { handlePublicImage } from './images.ts'
import { error } from './http.ts'
import type { Env, ExecutionContext } from './types.ts'

/**
 * The site's Worker. Cloudflare runs it only for /api/* (`assets.run_worker_first` in wrangler.jsonc);
 * every other path is served from the static assets in dist/.
 *
 * Routes (in order):
 *   /api/image/:token     → handlePublicImage
 *   /api/wall             → handlePublic
 *   /api/teachers/*       → handlePublic
 *   /api/templates        → handlePublic
 *   /api/wishes           → handlePublic
 *   /api/cards            → handleSubmit
 *   /api/qr/*             → handleQr
 *   /api/admin/*          → handleAdmin
 *   /api/*                → 404
 *   /*                    → ASSETS (SPA)
 *
 * /api/card/* is intentionally removed (replaced by /api/qr/:token).
 */
export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url)

    try {
      if (pathname.startsWith('/api/image/')) return await handlePublicImage(request, env, ctx)
      if (pathname === '/api/wall' || pathname.startsWith('/api/teachers/') || pathname === '/api/templates' || pathname === '/api/wishes') {
        return await handlePublic(request, env)
      }
      if (pathname === '/api/cards') return await handleSubmit(request, env)
      if (pathname.startsWith('/api/qr/')) return await handleQr(request, env)
      if (pathname.startsWith('/api/admin/')) return await handleAdmin(request, env)
      if (pathname.startsWith('/api/')) return error('not_found')
      return env.ASSETS.fetch(request)
    } catch {
      // Any unexpected exception returns a safe, non-leaking response.
      console.error('api: unavailable')
      return error('unavailable')
    }
  },
}
