/**
 * ErrorBoundary — catches render errors in lazy-loaded pages or any subtree.
 *
 * Renders a fallback with a reload button when an error is caught.
 * Used around lazy-loaded Noel page chunks and campaign route components.
 */
import { Component, type ReactNode, type ErrorInfo } from 'react'

interface Props {
  /** Content to protect. */
  children: ReactNode
  /** Optional custom fallback. Defaults to a standard error panel with "Tải lại". */
  fallback?: ReactNode
}

interface State {
  hasError: boolean
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(_err: unknown): State {
    return { hasError: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Log to console (not to an external service — no PII concern here)
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback !== undefined) return this.props.fallback
      return (
        <section className="wall-hero">
          <p>Đã có lỗi xảy ra khi tải trang.</p>
          <button
            type="button"
            className="btn-primary-link"
            onClick={() => this.setState({ hasError: false })}
          >
            Tải lại
          </button>
        </section>
      )
    }
    return this.props.children
  }
}
