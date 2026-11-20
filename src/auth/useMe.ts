/**
 * src/auth/useMe.ts — React hook for the current signed-in user.
 *
 * Fetches GET /api/me on mount and whenever refresh() is called.
 * Returns { user, isAdmin, loading, refresh }.
 *
 * FR-10, ADR-3.
 */
import { useCallback, useEffect, useState } from 'react'
import { getMe } from '../api.ts'
import type { MeUser } from '../api.ts'

export type { MeUser }

export function useMe() {
  const [user, setUser] = useState<MeUser | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    getMe()
      .then((data) => {
        if (!cancelled) {
          setUser(data.user)
          setIsAdmin(data.isAdmin)
          setLoading(false)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUser(null)
          setIsAdmin(false)
          setLoading(false)
        }
      })
    return () => { cancelled = true }
  }, [tick])

  const refresh = useCallback(() => setTick((t) => t + 1), [])

  return { user, isAdmin, loading, refresh }
}
