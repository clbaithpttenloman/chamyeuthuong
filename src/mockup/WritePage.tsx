/**
 * WritePage — /mockup/viet-loi-chuc
 *
 * Legacy route redirector: preserves any query string and forwards to the
 * new /mockup/gui-thiep route.
 */
import { Navigate, useSearchParams } from 'react-router-dom'

export default function WritePage() {
  const [searchParams] = useSearchParams()
  const qs = searchParams.toString()
  return <Navigate to={qs ? `/mockup/gui-thiep?${qs}` : '/mockup/gui-thiep'} replace />
}
