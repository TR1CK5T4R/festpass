'use client';

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

type Tone = 'success' | 'error';
interface Toast {
  id: number;
  message: string;
  tone: Tone;
}

const ToastContext = createContext<((message: string, tone?: Tone) => void) | null>(null);

/** Short messages after an action ("Club created"). Announced politely to screen readers. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const show = useCallback((message: string, tone: Tone = 'success') => {
    const id = Date.now() + Math.random();
    setToasts((all) => [...all, { id, message, tone }]);
    setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), 4000);
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="fixed right-4 bottom-4 z-50 flex flex-col gap-2"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`rounded-control px-4 py-3 text-sm text-white shadow-lg ${t.tone === 'success' ? 'bg-success' : 'bg-danger'}`}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const show = useContext(ToastContext);
  if (!show) throw new Error('useToast must be used inside ToastProvider');
  return show;
}
