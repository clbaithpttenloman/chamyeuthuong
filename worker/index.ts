import { handleCard } from './cards.ts'
import { handleAdmin } from './admin.ts'
import { handlePublicImage } from './images.ts'
import { error } from './http.ts'
import type { Env, ExecutionContext } from './types.ts'

/**
 * The site's Worker. Cloudflare runs it only for /api/* (`assets.run_worker_first` in wrangler.jsonc);
 * every other path is served from the static assets in dist/.
 */
export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url)

    try {
      if (pathname.startsWith('/api/image/')) return await handlePublicImage(request, env, ctx)
      if (pathname.startsWith('/api/card/')) return await handleCard(request, env)
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
