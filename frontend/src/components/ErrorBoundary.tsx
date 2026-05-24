import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: React.ReactNode;
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Log so devs can see in console + future remote logging
    console.error('[ErrorBoundary]', error, info);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.reset);
      }
      return (
        <div className="bg-danger/10 border border-danger/30 rounded-lg p-6 text-danger">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle size={20} />
            <span className="font-bold text-lg">Something went wrong</span>
          </div>
          <div className="text-sm font-mono bg-background/40 rounded p-3 mb-4 max-h-40 overflow-auto custom-scrollbar">
            {this.state.error.message}
          </div>
          <button
            onClick={this.reset}
            className="flex items-center gap-2 px-4 py-2 bg-danger/20 hover:bg-danger/30 border border-danger/40 rounded font-semibold transition-colors"
          >
            <RefreshCw size={14} />
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
