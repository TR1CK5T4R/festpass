import { randomUUID } from 'node:crypto';
import {
  BANNER_CONTENT_TYPES,
  BANNER_MAX_BYTES,
  can,
  type BannerContentType,
  type PresignedUpload,
  type PresignUploadInput,
} from '@festpass/shared';
import { bodyFieldErrors, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import * as storage from '../../lib/storage.js';
import { findEventOrg } from '../events/repository.js';
import { findMembership } from '../orgs/repository.js';

// Long enough to pick a file on a slow phone connection, short enough that a leaked form is useless soon.
const PRESIGN_TTL_SECONDS = 5 * 60;

const EXTENSIONS: Record<BannerContentType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** The only keys a banner may have: orgs/{orgId}/events/{eventId}/banner/{uuid}.{ext}. */
const bannerKeyPattern = (orgId: string, eventId: string) =>
  new RegExp(`^orgs/${orgId}/events/${eventId}/banner/${UUID}\\.(jpg|png|webp)$`);

/**
 * Signs an upload for one new key. The key is chosen here, never by the client, so an upload can only
 * land under this event's banner prefix. A fresh UUID per upload means a replaced banner never serves
 * a stale cached copy.
 */
export async function presignBanner(
  userId: string,
  { eventId, contentType }: PresignUploadInput,
): Promise<PresignedUpload> {
  const event = await findEventOrg(eventId);
  const membership = event && (await findMembership(event.orgId, userId));
  // Same answer for "no such event" and "not your org", like requireOrgPermission, so IDs can't be probed.
  if (!event || !membership) throw new NotFoundError('Event not found');
  if (!can(membership.role, 'event:update')) throw new ForbiddenError();

  const key = `orgs/${event.orgId}/events/${eventId}/banner/${randomUUID()}.${EXTENSIONS[contentType]}`;
  const { url, fields } = await storage.presignPost(
    key,
    contentType,
    BANNER_MAX_BYTES,
    PRESIGN_TTL_SECONDS,
  );
  const expiresAt = new Date(Date.now() + PRESIGN_TTL_SECONDS * 1000).toISOString();
  return { url, fields, key, maxBytes: BANNER_MAX_BYTES, expiresAt };
}

/**
 * Called before an event's bannerKey is saved. The client only *says* it uploaded something; storage is
 * asked directly whether the object exists and what it really is.
 * shortcut: the content type is the one the uploader declared, not sniffed from the bytes; add a worker
 * that checks magic bytes (or re-encodes the image) if banners ever come from untrusted users.
 */
export async function verifyBanner(orgId: string, eventId: string, key: string) {
  const fail = (message: string) => bodyFieldErrors([{ path: 'bannerKey', message }]);
  // Without this, an organizer could point their event at another org's file.
  if (!bannerKeyPattern(orgId, eventId).test(key)) throw fail('Not a banner key for this event');

  const head = await storage.headObject(key);
  if (!head) throw fail('No file has been uploaded at this key');
  if (!(BANNER_CONTENT_TYPES as readonly string[]).includes(head.contentType)) {
    throw fail('The banner must be a JPEG, PNG or WebP image');
  }
  if (head.size > BANNER_MAX_BYTES) throw fail('The banner must be at most 2 MB');
}
