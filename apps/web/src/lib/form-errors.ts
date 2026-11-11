import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { isApiError } from './api';

interface FieldIssue {
  path: string;
  message: string;
}

const OFFLINE = 'Could not reach the server. Check your connection.';

/** One readable line for any error, for places without a form (dialogs, toasts, the uploader). */
export function errorMessage(err: unknown): string {
  if (!isApiError(err)) return err instanceof Error && err.message ? err.message : OFFLINE;
  const fields = (err.details.fields ?? []) as FieldIssue[];
  return fields.length > 0 ? fields.map((f) => f.message).join('. ') : err.message;
}

/**
 * Shows a server error on the form: field errors (400 VALIDATION_FAILED) next to their inputs,
 * a known field conflict (e.g. EMAIL_TAKEN on "email") on that input, anything else above the form.
 * `formField` maps API field names to the input that produced them (pricePaise -> price).
 */
export function showApiError<T extends FieldValues>(
  err: unknown,
  setError: UseFormSetError<T>,
  fieldForCode: Record<string, Path<T>> = {},
  formField: Record<string, Path<T>> = {},
) {
  if (!isApiError(err)) {
    setError('root.server', { message: OFFLINE });
    return;
  }
  const fields = (err.details.fields ?? []) as FieldIssue[];
  if (err.code === 'VALIDATION_FAILED' && fields.length > 0) {
    for (const f of fields) {
      const field = formField[f.path] ?? (f.path as Path<T>);
      setError(f.path ? field : 'root.server', { message: f.message });
    }
    return;
  }
  const field = fieldForCode[err.code];
  if (field) setError(field, { message: err.message });
  else setError('root.server', { message: err.message });
}
