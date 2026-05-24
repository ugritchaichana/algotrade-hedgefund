import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Info, X } from 'lucide-react';

type ToastKind = 'success' | 'error' | 'warning' | 'info';

interface ToastEntry {
  id: number;
  kind: ToastKind;
  message: string;
  durationMs: number;
}

interface ToastContextValue {
  show: (message: string, kind?: ToastKind, durationMs?: number) => void;
  success: (message: string, durationMs?: number) => void;
  error: (message: string, durationMs?: number) => void;
  warning: (message: string, durationMs?: number) => void;
  info: (message: string, durationMs?: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // graceful fallback when used outside provider
    return {
      show: (m) => console.log('[toast]', m),
      success: (m) => console.log('[toast.success]', m),
      error: (m) => console.error('[toast.error]', m),
      warning: (m) => console.warn('[toast.warning]', m),
      info: (m) => console.info('[toast.info]', m),
    };
  }
  return ctx;
}

const ICONS: Record<ToastKind, React.ReactNode> = {
  success: <CheckCircle2 size={18} />,
  error: <XCircle size={18} />,
  warning: <AlertTriangle size={18} />,
  info: <Info size={18} />,
};

const COLOR_CLASSES: Record<ToastKind, string> = {
  success: 'bg-success/15 border-success/40 text-success',
  error: 'bg-danger/15 border-danger/40 text-danger',
  warning: 'bg-warning/15 border-warning/40 text-warning',
  info: 'bg-primary/15 border-primary/40 text-primary',
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts(t => t.filter(x => x.id !== id));
  }, []);

  const show = useCallback((message: string, kind: ToastKind = 'info', durationMs = 4000) => {
    const id = Date.now() + Math.random();
    const entry: ToastEntry = { id, kind, message, durationMs };
    setToasts(prev => [...prev, entry]);
    if (durationMs > 0) {
      setTimeout(() => dismiss(id), durationMs);
    }
  }, [dismiss]);

  const value: ToastContextValue = {
    show,
    success: (m, d) => show(m, 'success', d),
    error: (m, d) => show(m, 'error', d ?? 6000),
    warning: (m, d) => show(m, 'warning', d),
    info: (m, d) => show(m, 'info', d),
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none max-w-md">
        {toasts.map(t => (
          <div
            key={t.id}
            className={`pointer-events-auto rounded-lg border px-4 py-3 shadow-lg backdrop-blur flex items-start gap-3 ${COLOR_CLASSES[t.kind]} animate-toast-in`}
          >
            <div className="flex-shrink-0 mt-0.5">{ICONS[t.kind]}</div>
            <div className="flex-1 text-sm">{t.message}</div>
            <button
              onClick={() => dismiss(t.id)}
              className="flex-shrink-0 hover:opacity-70 transition-opacity"
              aria-label="Dismiss"
            >
              <X size={16} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
