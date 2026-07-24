import { Component } from 'react'

/**
 * Root error boundary.
 *
 * Without one, a runtime error anywhere in the tree unmounts everything and
 * leaves a silent black screen with no clue what happened — exactly the failure
 * this was added in response to. Now a crash shows a themed message and a
 * reload, and logs the error so it's visible rather than swallowed.
 *
 * Must be a class: React only exposes componentDidCatch / getDerivedStateFrom-
 * Error to class components.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // Surface it; a monitoring hook can replace this later.
    console.error('Uncaught render error:', error, info?.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg px-5">
        <div className="w-full max-w-md space-y-5 text-center">
          <div className="space-y-2">
            <h1 className="text-xl font-semibold text-pri">Something broke</h1>
            <p className="text-sm text-sec">
              The app hit an unexpected error and couldn&rsquo;t continue.
              Reloading usually clears it.
            </p>
          </div>
          <button onClick={() => window.location.reload()} className="btn-primary">
            Reload
          </button>
          {import.meta.env.DEV && (
            <pre className="overflow-x-auto rounded-xl bg-surface2 p-3 text-left text-xs text-warning">
              {String(this.state.error?.stack || this.state.error)}
            </pre>
          )}
        </div>
      </div>
    )
  }
}
