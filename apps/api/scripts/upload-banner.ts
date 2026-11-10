// Uploads a banner the way the web app will: presign with the API, POST the file straight to storage,
// then PATCH the event with the key. Logs in as the seeded organizer by default.
// Usage: pnpm storage:upload-banner <image.jpg|png|webp> [email] [password]
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

const [file, email = 'organizer@festpass.dev', password = 'festpass-dev'] = process.argv.slice(2);
if (!file) throw new Error('usage: upload-banner <image> [email] [password]');
const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';
const types: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};
const contentType = types[extname(file).toLowerCase()] ?? 'application/octet-stream';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a throwaway script reading JSON it just asked for
async function api(path: string, init: RequestInit & { token?: string } = {}): Promise<any> {
  const res = await fetch(API + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
    },
  });
  const body = res.status === 204 ? null : await res.json();
  if (!res.ok)
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${JSON.stringify(body)}`);
  return body;
}

const { accessToken: token } = await api('/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email, password }),
});
const { orgs } = await api('/orgs/mine', { token });
const orgId = orgs[0]?.id;
if (!orgId) throw new Error(`${email} is not in any org`);
const event = (await api(`/orgs/${orgId}/events`, { token })).items[0];
if (!event) throw new Error('that org has no events');
console.log(`event: ${event.title}`);

const { upload } = await api('/uploads/presign', {
  method: 'POST',
  token,
  body: JSON.stringify({ eventId: event.id, contentType }),
});

// Policy fields first, the file last: storage stops reading the form at the file field.
const form = new FormData();
for (const [k, v] of Object.entries(upload.fields as Record<string, string>)) form.append(k, v);
form.append('file', new Blob([await readFile(file)], { type: contentType }));
const stored = await fetch(upload.url, { method: 'POST', body: form });
const reply = await stored.text(); // read it all, or the open socket keeps the script running
if (!stored.ok) throw new Error(`storage rejected the upload: ${stored.status} ${reply}`);
console.log(`uploaded to ${upload.key}`);

const { event: updated } = await api(`/orgs/${orgId}/events/${event.id}`, {
  method: 'PATCH',
  token,
  body: JSON.stringify({ bannerKey: upload.key }),
});
const check = await fetch(updated.bannerUrl, { method: 'HEAD' });
console.log(`banner: ${updated.bannerUrl} (public GET -> ${check.status})`);
