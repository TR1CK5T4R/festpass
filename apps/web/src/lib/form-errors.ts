import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { isApiError } from './api';

interface FieldIssue {
  path: string;
  message: string;
}

/**
 * Shows a server error on the form: field errors (400 VALIDATION_FAILED) next to their inputs,
 * a known field conflict (e.g. EMAIL_TAKEN on "email") on that input, anything else above the form.
 */
export function showApiError<T extends FieldValues>(
  err: unknown,
  setError: UseFormSetError<T>,
  fieldForCode: Record<string, Path<T>> = {},
) {
  if (!isApiError(err)) {
    setError('root.server', { message: 'Could not reach the server. Check your connection.' });
    return;
  }
  const fields = (err.details.fields ?? []) as FieldIssue[];
  if (err.code === 'VALIDATION_FAILED' && fields.length > 0) {
    for (const f of fields) setError(f.path as Path<T>, { message: f.message });
    return;
  }
  const field = fieldForCode[err.code];
  if (field) setError(field, { message: err.message });
  else setError('root.server', { message: err.message });
}
