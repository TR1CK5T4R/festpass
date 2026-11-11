import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

interface FieldProps {
  label: string;
  error?: string;
  hint?: string;
}

const control = (error?: string) =>
  `rounded-control border bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:bg-canvas disabled:text-muted ${error ? 'border-danger' : 'border-line'}`;

/** Label, control and error/hint. The error is linked with aria-describedby so screen readers announce it. */
function Field({
  label,
  error,
  hint,
  children,
}: FieldProps & { children: (a11y: Record<string, unknown>) => ReactNode }) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy })}
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

type InputProps = FieldProps &
  InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> };

export function Input({ label, error, hint, className = '', ...props }: InputProps) {
  return (
    <Field label={label} error={error} hint={hint}>
      {(a11y) => <input {...a11y} className={`${control(error)} ${className}`} {...props} />}
    </Field>
  );
}

type TextareaProps = FieldProps &
  TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> };

export function Textarea({ label, error, hint, className = '', ...props }: TextareaProps) {
  return (
    <Field label={label} error={error} hint={hint}>
      {(a11y) => (
        <textarea rows={4} {...a11y} className={`${control(error)} ${className}`} {...props} />
      )}
    </Field>
  );
}

type SelectProps = FieldProps &
  SelectHTMLAttributes<HTMLSelectElement> & { ref?: Ref<HTMLSelectElement> };

export function Select({ label, error, hint, className = '', ...props }: SelectProps) {
  return (
    <Field label={label} error={error} hint={hint}>
      {(a11y) => <select {...a11y} className={`${control(error)} ${className}`} {...props} />}
    </Field>
  );
}

type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  label: string;
  hint?: string;
  ref?: Ref<HTMLInputElement>;
};

export function Checkbox({ label, hint, ...props }: CheckboxProps) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" className="mt-0.5 size-4 accent-brand-600" {...props} />
      <span>
        <span className="font-medium text-ink">{label}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
    </label>
  );
}
