// The Idempotency-Key for a booking attempt. Generated once in the browser and kept in sessionStorage,
// so every retry of the same attempt (a double click, a timeout, a reload of the page) sends the same
// key, and the API answers with the order it already made instead of holding more tickets.

const PREFIX = 'festpass:booking:';

const slot = (eventSlug: string, tierId: string, qty: number) =>
  `${PREFIX}${eventSlug}:${tierId}:${qty}`;

export function bookingKey(
  eventSlug: string,
  tierId: string,
  qty: number,
  store: Storage = sessionStorage,
) {
  const name = slot(eventSlug, tierId, qty);
  const existing = store.getItem(name);
  if (existing) return existing;
  const key = crypto.randomUUID();
  store.setItem(name, key);
  return key;
}

/** After a hold ends (expired, cancelled), the next booking is a new attempt and needs a new key. */
export function forgetBookingKeys(eventSlug: string, store: Storage = sessionStorage) {
  for (const name of Object.keys(store)) {
    if (name.startsWith(`${PREFIX}${eventSlug}:`)) store.removeItem(name);
  }
}
