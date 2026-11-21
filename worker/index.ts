import { handlePublic } from './public.ts'
import { handleSubmit } from './submit.ts'
import { handleQr } from './qr.ts'
import { handleAdmin } from './admin.ts'
import { handleAbout } from './about.ts'
import { handlePublicImage } from './images.ts'
import { handleCampaigns, handleAdminCampaigns } from './campaigns.ts'
import { requireAdmin } from './auth.ts'
import { handleAuth, handleMe } from './me.ts'
import { error } from './http.ts'
import type { Env, ExecutionContext } from './types.ts'

/**
 * The site's Worker. Cloudflare runs it only for /api/* (`assets.run_worker_first` in wrangler.jsonc);
 * every other path is served from the static assets in dist/.
 *
 * Routes (in order):
 *   /api/image/:token     → handlePublicImage
 *   /api/wall             → handlePublic
 *   /api/templates        → handlePublic
 *   /api/wishes           → handlePublic
 *   /api/about            → handleAbout  (public GET, rate-limited)
 *   /api/auth/*           → handleAuth   (nonce, google sign-in, logout)
 *   /api/me               → handleMe     (profile read/update)
 *   /api/cards            → handleSubmit
 *   /api/qr/*             → handleQr
 *   /api/admin/campaigns* → handleAdminCampaigns (Google session required)
 *   /api/admin/*          → handleAdmin
 *   /api/*                → 404
 *   /*                    → ASSETS (SPA)
 */
export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url)

    try {
      if (pathname.startsWith('/api/image/')) return await handlePublicImage(request, env, ctx)
      if (pathname === '/api/wall' || pathname === '/api/templates' || pathname === '/api/wishes') {
        return await handlePublic(request, env)
      }
      if (pathname === '/api/about') return await handleAbout(request, env)
      // Auth and profile endpoints (no legacy email auth)
      if (pathname.startsWith('/api/auth/')) return await handleAuth(request, env as never)
      if (pathname === '/api/me') return await handleMe(request, env as never)
      if (pathname === '/api/cards') return await handleSubmit(request, env)
      if (pathname.startsWith('/api/qr/')) return await handleQr(request, env)
      // Campaign public endpoints (no auth; memoised per isolate; rate limited on cache misses)
      if (pathname === '/api/campaigns/active' || pathname.startsWith('/api/campaigns/')) {
        return await handleCampaigns(request, env)
      }
      // Campaign admin CRUD — requires Google session (not legacy email)
      if (pathname.startsWith('/api/admin/campaigns')) {
        const auth = await requireAdmin(request, env)
        if (auth instanceof Response) return auth
        return await handleAdminCampaigns(request, env, auth.email)
      }
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
