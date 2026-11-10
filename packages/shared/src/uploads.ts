import { z } from 'zod';

export const BANNER_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type BannerContentType = (typeof BANNER_CONTENT_TYPES)[number];
export const BANNER_MAX_BYTES = 2 * 1024 * 1024;

export const presignUploadSchema = z.object({
  eventId: z.uuid(),
  contentType: z.enum(BANNER_CONTENT_TYPES),
});
export type PresignUploadInput = z.infer<typeof presignUploadSchema>;

/**
 * A pre-signed POST: send a multipart form to `url` with every entry of `fields` first, then the file
 * as the last field named `file`. Afterwards PATCH the event with `{ bannerKey: key }`.
 */
export interface PresignedUpload {
  url: string;
  fields: Record<string, string>;
  key: string;
  maxBytes: number;
  expiresAt: string;
}
