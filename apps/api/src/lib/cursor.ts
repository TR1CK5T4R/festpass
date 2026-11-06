import { ValidationError } from './errors.js';

// Keyset pagination: the cursor is the (startsAt, id) of the last row on the page, base64url-encoded so
// clients treat it as opaque. id breaks ties between events that start at the same moment.

export interface EventCursor {
  startsAt: Date;
  id: string;
}

export function encodeCursor({ startsAt, id }: EventCursor): string {
  return Buffer.from(`${startsAt.toISOString()}|${id}`).toString('base64url');
}

export function decodeCursor(cursor: string): EventCursor {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const startsAt = new Date(iso ?? '');
  if (!id || Number.isNaN(startsAt.getTime())) {
    throw new ValidationError('Request validation failed', {
      fields: [{ location: 'query', path: 'cursor', message: 'Invalid cursor' }],
    });
  }
  return { startsAt, id };
}
