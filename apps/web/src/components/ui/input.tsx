import { useId, type InputHTMLAttributes, type Ref } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  hint?: string;
  ref?: Ref<HTMLInputElement>;
}

/** A labelled input. The error is linked with aria-describedby so screen readers announce it. */
export function Input({ label, error, hint, className = '', ...props }: InputProps) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`rounded-control border bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 ${error ? 'border-danger' : 'border-line'} ${className}`}
        {...props}
      />
      {error ? (
        <p id={`${id}-error`} className="text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
