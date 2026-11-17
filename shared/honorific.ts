/**
 * Closed list of valid teacher title prefixes.
 * `isTitle` is the only gate — never accept user strings without checking.
 */
export const TITLES = ['Thầy', 'Cô'] as const
export type Title = (typeof TITLES)[number]

export function isTitle(s: string): s is Title {
  return (TITLES as readonly string[]).includes(s)
}
