import type { EventStatus } from '@festpass/shared';
import { ConflictError } from '../../lib/errors.js';

// The only ways an event's status may change. Anything else (re-opening a closed event,
// un-publishing) is refused, so attendees never see an event appear, vanish and come back.
const TRANSITIONS: Record<EventStatus, readonly EventStatus[]> = {
  DRAFT: ['PUBLISHED'],
  PUBLISHED: ['CLOSED'],
  CLOSED: [],
};

export function canTransition(from: EventStatus, to: EventStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: EventStatus, to: EventStatus): void {
  if (!canTransition(from, to)) {
    throw new ConflictError('INVALID_TRANSITION', `An event can't go from ${from} to ${to}`);
  }
}
