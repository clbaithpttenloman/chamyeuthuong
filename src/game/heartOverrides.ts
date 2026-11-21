/**
 * src/game/heartOverrides.ts — optimistic heart-count overrides for the gift tree (ADR-7).
 *
 * When the user hearts a gift, the client immediately shows the incremented count
 * (the override) rather than waiting for the next tree poll. The override is released
 * once the server confirms: a later tree response (`newServerAsOf > override.serverAsOf`)
 * with a count ≥ the local value. The override is also dropped if the gift disappears
 * from the tree entirely (e.g. deleted or hidden by moderation).
 *
 * Key improvement over the previous `Date.now()` approach (review finding):
 *   The override stores the server's `asOf` timestamp (from the tree response that was
 *   current when the heart was given), not the client clock. This avoids clock-skew
 *   problems where the client's clock is ahead of the server.
 *
 * All exports are pure functions — no side effects.
 */

/** A single optimistic override entry. */
export interface HeartOverride {
  /** The local heart count optimistically applied by the client. */
  count: number
  /**
   * The server `asOf` (epoch ms) of the tree response that was in effect when
   * the heart was given. Used to determine when the server has caught up.
   */
  serverAsOf: number
}

export type OverrideMap = ReadonlyMap<string, HeartOverride>

/**
 * Returns the heartCount to display for a gift, applying the override if present.
 * Always returns at least the server count (overrides are optimistic, never subtractive).
 */
export function applyOverride(
  publicId: string,
  serverCount: number,
  overrides: OverrideMap,
): number {
  const local = overrides.get(publicId)
  if (!local) return serverCount
  return Math.max(serverCount, local.count)
}

/**
 * Returns a new OverrideMap with one entry added or updated.
 *
 * @param publicId   Gift's public id.
 * @param count      The heartCount returned by the server for this heart action.
 * @param serverAsOf The `asOf` epoch-ms of the tree response most recently
 *                   received by the client (i.e. the response that was current
 *                   when the user pressed the heart button).
 */
export function addOverride(
  overrides: OverrideMap,
  publicId: string,
  count: number,
  serverAsOf: number,
): OverrideMap {
  const next = new Map(overrides)
  next.set(publicId, { count, serverAsOf })
  return next
}

/**
 * Reconciles the override map against a fresh tree response.
 *
 * Rules:
 *  - If the gift is absent from the tree and NOT pinned → drop the override.
 *  - If the gift is absent but its publicId is in `pinnedIds` → keep the override.
 *    (Use this for the currently-open solo gift so its optimistic count survives polls.)
 *  - If `newServerAsOf > override.serverAsOf` AND `serverCount >= override.count`
 *    → server has confirmed → release the override.
 *  - Otherwise → keep the override.
 *
 * Returns the same map object (referential equality) when nothing changed,
 * allowing React's bailout on `prev === next`.
 *
 * @param pinnedIds  Optional set of publicIds to retain even when absent from the tree.
 */
export function reconcileOverrides(
  overrides: OverrideMap,
  treeGifts: ReadonlyArray<{ publicId: string; heartCount: number }>,
  newServerAsOf: number,
  pinnedIds?: ReadonlySet<string>,
): OverrideMap {
  if (overrides.size === 0) return overrides

  const giftMap = new Map(treeGifts.map((g) => [g.publicId, g.heartCount]))
  let changed = false
  const next = new Map<string, HeartOverride>()

  for (const [pid, local] of overrides) {
    const serverCount = giftMap.get(pid)
    if (serverCount === undefined) {
      // Gift absent from tree — keep if pinned (e.g. current solo gift), otherwise drop
      if (pinnedIds?.has(pid)) {
        next.set(pid, local)
      } else {
        changed = true
      }
      continue
    }
    // Release when server has a strictly later asOf and confirmed the count
    if (newServerAsOf > local.serverAsOf && serverCount >= local.count) {
      changed = true
      continue
    }
    next.set(pid, local)
  }

  return changed ? next : overrides
}
