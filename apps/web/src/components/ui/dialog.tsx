'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { errorMessage } from '@/lib/form-errors';
import { Button } from './button';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** Runs on confirm. If it throws, the server's message is shown in the dialog and it stays open. */
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

/**
 * Asks before an action that is hard to undo (publish, close, remove). Built on the native <dialog>:
 * showModal() gives focus trapping, Escape to cancel and an inert page behind it for free.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (open && !dialog?.open) dialog?.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open]);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={ref}
      onClose={() => {
        setError(null);
        onClose();
      }}
      aria-labelledby="confirm-title"
      className="m-auto w-full max-w-md rounded-card border border-line bg-surface p-6 shadow-xl backdrop:bg-ink/40"
    >
      <h2 id="confirm-title" className="mb-2 text-lg font-semibold text-ink">
        {title}
      </h2>
      <div className="text-sm text-muted">{children}</div>
      {error && (
        <p role="alert" className="mt-4 rounded-control bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant={danger ? 'danger' : 'primary'}
          onClick={() => void confirm()}
          loading={busy}
        >
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
