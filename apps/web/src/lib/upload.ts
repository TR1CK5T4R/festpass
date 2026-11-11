import {
  BANNER_CONTENT_TYPES,
  BANNER_MAX_BYTES,
  type EventView,
  type PresignedUpload,
} from '@festpass/shared';
import { api } from './api';

/**
 * The Day 8 flow: ask the API to sign an upload, send the file straight to storage, then tell the API
 * the key so it can check the object and save it. The file never passes through the API.
 */
export async function uploadBanner(
  orgId: string,
  eventId: string,
  file: File,
  onProgress: (fraction: number) => void,
): Promise<EventView> {
  // Checked here only to fail fast; storage enforces both limits through the signed policy anyway.
  if (!(BANNER_CONTENT_TYPES as readonly string[]).includes(file.type)) {
    throw new Error('Choose a JPEG, PNG or WebP image.');
  }
  if (file.size > BANNER_MAX_BYTES) throw new Error('The image must be at most 2 MB.');

  const { upload } = await api.request<{ upload: PresignedUpload }>('/uploads/presign', {
    method: 'POST',
    body: { eventId, contentType: file.type },
  });
  await postToStorage(upload, file, onProgress);
  const { event } = await api.request<{ event: EventView }>(`/orgs/${orgId}/events/${eventId}`, {
    method: 'PATCH',
    body: { bannerKey: upload.key },
  });
  return event;
}

// XMLHttpRequest rather than fetch: fetch has no upload progress events.
function postToStorage(upload: PresignedUpload, file: File, onProgress: (f: number) => void) {
  const form = new FormData();
  // The policy fields must come before the file: storage stops reading the form at the file.
  for (const [name, value] of Object.entries(upload.fields)) form.append(name, value);
  form.append('file', file);

  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', upload.url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status < 300) return resolve();
      // S3 errors are XML: <Error><Code>EntityTooLarge</Code><Message>...</Message></Error>
      const message = /<Message>(.*?)<\/Message>/.exec(xhr.responseText)?.[1];
      reject(new Error(`Storage rejected the file: ${message ?? `HTTP ${xhr.status}`}`));
    };
    xhr.onerror = () =>
      reject(new Error('The upload failed. Check your connection and try again.'));
    xhr.send(form);
  });
}
