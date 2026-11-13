import type { RequestHandler } from 'express';
import type { z } from 'zod';
import { ValidationError } from '../lib/errors.js';

type Location = 'params' | 'headers' | 'query' | 'body';
type Schemas = Partial<Record<Location, z.ZodType>>;

export interface FieldError {
  location: Location;
  path: string;
  message: string;
}

/**
 * Validates params, headers, query and body against Zod schemas (from @festpass/shared) before the controller runs.
 * Reports every invalid field at once, and replaces the raw values with the parsed ones
 * (defaults applied, query strings coerced to numbers), so controllers only ever see valid data.
 */
export function validate(schemas: Schemas): RequestHandler {
  return (req, _res, next) => {
    const fields: FieldError[] = [];
    const parsed: Partial<Record<Location, unknown>> = {};

    for (const location of ['params', 'headers', 'query', 'body'] as const) {
      const schema = schemas[location];
      if (!schema) continue;
      const result = schema.safeParse(req[location]);
      if (result.success) {
        parsed[location] = result.data;
      } else {
        for (const issue of result.error.issues) {
          fields.push({ location, path: issue.path.map(String).join('.'), message: issue.message });
        }
      }
    }

    if (fields.length > 0)
      return next(new ValidationError('Request validation failed', { fields }));

    // Headers are only checked, never replaced: the schema lists a few, and the rest must survive.
    if ('params' in parsed) req.params = parsed.params as typeof req.params;
    if ('body' in parsed) req.body = parsed.body;
    // Express 5 makes req.query a getter with no setter, so the parsed copy is defined over it.
    if ('query' in parsed)
      Object.defineProperty(req, 'query', { value: parsed.query, enumerable: true });
    next();
  };
}
