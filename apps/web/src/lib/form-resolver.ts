import type { FieldErrors, FieldValues, Resolver } from 'react-hook-form';
import type { z } from 'zod';

/**
 * Validates a form with a schema from packages/shared, the same one the API runs. What people type
 * isn't always what the API takes (a local date instead of ISO with an offset, rupees instead of paise),
 * so `toApi` converts first, and `formField` moves errors from the API's field name back to the input
 * that produced it (pricePaise -> price). The submit handler gets exactly what the API will accept.
 */
export function sharedSchemaResolver<TForm extends FieldValues, TSchema extends z.ZodType>(
  schema: TSchema,
  toApi: (values: TForm) => unknown,
  formField: Record<string, string> = {},
): Resolver<TForm, unknown, z.output<TSchema>> {
  return async (values) => {
    const result = schema.safeParse(toApi(values));
    if (result.success) return { values: result.data, errors: {} };

    const errors: Record<string, unknown> = {};
    for (const issue of result.error.issues) {
      const path = issue.path.join('.');
      const error = { type: issue.code, message: issue.message };
      // A rule about the whole form (no path) shows above the form, like a server error.
      if (!path) errors.root ??= { server: error };
      else errors[formField[path] ?? path] ??= error;
    }
    return { values: {}, errors: errors as FieldErrors<TForm> };
  };
}

/** '' -> NaN so the schema says "Enter a whole number" instead of silently using 0. */
export const toNumber = (value: string) => (value.trim() === '' ? NaN : Number(value));
