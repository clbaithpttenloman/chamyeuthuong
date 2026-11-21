import { handlePublic } from './public.ts'
import { handleSubmit } from './submit.ts'
import { handleQr } from './qr.ts'
import { handleAdmin } from './admin.ts'
import { handleAbout } from './about.ts'
import { handlePublicImage } from './images.ts'
import { handleCampaigns, handleAdminCampaigns } from './campaigns.ts'
import { handleGifts } from './gifts.ts'
import { handleTree } from './tree.ts'
import { handleGiftModeration } from './giftModeration.ts'
import { requireAdmin } from './auth.ts'
import { handleAuth, handleMe } from './me.ts'
import { error } from './http.ts'
import type { Env, ExecutionContext } from './types.ts'

/**
 * The site's Worker. Cloudflare runs it only for /api/* (`assets.run_worker_first` in wrangler.jsonc);
 * every other path is served from the static assets in dist/.
 *
 * Routes (in order):
 *   /api/image/:token        - handlePublicImage
 *   /api/wall                - handlePublic
 *   /api/templates           - handlePublic (campaign 1 only)
 *   /api/wishes              - handlePublic
 *   /api/about               - handleAbout  (public GET, rate-limited)
 *   /api/auth/...            - handleAuth   (nonce, google sign-in, logout)
 *   /api/me/gifts            - handleMe     (own gifts for a campaign)
 *   /api/me                  - handleMe     (profile read/update/delete)
 *   /api/cards               - handleSubmit
 *   /api/qr/...              - handleQr
 *   /api/campaigns/active    - handleCampaigns
 *   /api/campaigns/<slug>/tree      - handleTree (gift-tree read APIs)
 *   /api/campaigns/<slug>/gifts GET - handleTree (paginated gift list)
 *   /api/campaigns/<slug>/gifts POST - handleGifts (gift create)
 *   /api/campaigns/<slug>/templates - handleTree (campaign templates)
 *   /api/campaigns/...       - handleCampaigns (public campaign read)
 *   /api/gifts/<id> GET      - handleTree  (gift by public id)
 *   /api/gifts/...           - handleGifts (gift delete, heart, report)
 *   /api/admin/campaigns...  - handleAdminCampaigns (Google session required)
 *   /api/admin/gifts*        - handleGiftModeration (Google session, stub)
 *   /api/admin/users*        - handleGiftModeration (Google session, stub)
 *   /api/admin/...           - handleAdmin
 *   /api/...                 - 404
 *   /...                     - ASSETS (SPA)
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
      // /api/me/gifts must be checked before /api/me (more specific path)
      if (pathname === '/api/me/gifts') return await handleMe(request, env as never)
      if (pathname === '/api/me') return await handleMe(request, env as never)
      if (pathname === '/api/cards') return await handleSubmit(request, env)
      if (pathname.startsWith('/api/qr/')) return await handleQr(request, env)

      // Campaign-scoped read APIs (tree, gifts list, templates) — handled by handleTree for GET
      // Gift-tree write paths (/api/campaigns/:slug/gifts POST) — handled by handleGifts
      if (pathname.startsWith('/api/campaigns/')) {
        // /api/campaigns/active and /api/campaigns/<slug> go to handleCampaigns
        if (pathname === '/api/campaigns/active') return await handleCampaigns(request, env)
        // /api/campaigns/<slug>/tree → handleTree (GET only)
        if (/^\/api\/campaigns\/[^/]+\/tree$/.test(pathname)) return await handleTree(request, env as never)
        // /api/campaigns/<slug>/gifts → GET to handleTree, POST to handleGifts
        if (/^\/api\/campaigns\/[^/]+\/gifts$/.test(pathname)) {
          if (request.method === 'POST') return await handleGifts(request, env as never)
          return await handleTree(request, env as never)
        }
        // /api/campaigns/<slug>/templates → handleTree (GET only)
        if (/^\/api\/campaigns\/[^/]+\/templates$/.test(pathname)) return await handleTree(request, env as never)
        // Everything else → handleCampaigns (campaign read by slug)
        return await handleCampaigns(request, env)
      }

      // Gift endpoints: GET /api/gifts/<publicId> → handleTree; writes → handleGifts
      if (pathname.startsWith('/api/gifts/')) {
        // GET /api/gifts/<publicId> (no sub-path like /heart or /report)
        if (request.method === 'GET' && /^\/api\/gifts\/[^/]+$/.test(pathname)) {
          return await handleTree(request, env as never)
        }
        return await handleGifts(request, env as never)
      }

      // Campaign admin CRUD — requires Google session (not legacy email)
      if (pathname.startsWith('/api/admin/campaigns')) {
        const auth = await requireAdmin(request, env)
        if (auth instanceof Response) return auth
        return await handleAdminCampaigns(request, env, auth.email)
      }
      // Gift moderation + user ban (stub; wired before handleAdmin so the route exists)
      if (pathname.startsWith('/api/admin/gifts') || pathname.startsWith('/api/admin/users')) {
        return await handleGiftModeration(request, env as never)
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
