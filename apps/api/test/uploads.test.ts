import { NotFound } from '@aws-sdk/client-s3';
import { prisma } from '@festpass/db';
import { truncateAll } from '@festpass/db/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { s3 } from '../src/lib/storage.js';
import { addMember, app, makeOrg, makeUser, type TestUser } from './helpers.js';

beforeEach(() => truncateAll(prisma));
afterEach(() => vi.restoreAllMocks());
afterAll(() => prisma.$disconnect());

const DAY = 24 * 60 * 60 * 1000;
const inDays = (d: number) => new Date(Date.now() + d * DAY).toISOString();

let owner: TestUser;
let orgId: string;
let eventId: string;
const eventPath = () => `/api/v1/orgs/${orgId}/events/${eventId}`;

beforeEach(async () => {
  owner = await makeUser('Olivia');
  orgId = await makeOrg(owner);
  const res = await request(app)
    .post(`/api/v1/orgs/${orgId}/events`)
    .set(owner.auth)
    .send({
      title: 'Tech Fest',
      venue: 'MAIT Auditorium',
      startsAt: inDays(30),
      endsAt: inDays(30.4),
      saleStartsAt: inDays(1),
      saleEndsAt: inDays(29),
    });
  eventId = res.body.event.id;
});

const presign = (user: TestUser, body: object) =>
  request(app).post('/api/v1/uploads/presign').set(user.auth).send(body);

// HeadObject is the only S3 call the API makes; signing a POST policy is local and needs no server.
const storageHas = (object: { ContentType: string; ContentLength: number } | null) =>
  vi
    .spyOn(s3, 'send')
    .mockImplementation(async () =>
      object
        ? object
        : Promise.reject(new NotFound({ message: 'NotFound', $metadata: { httpStatusCode: 404 } })),
    );

describe('POST /uploads/presign', () => {
  it('signs a POST for a fixed key with the size and type inside the signed policy', async () => {
    const res = await presign(owner, { eventId, contentType: 'image/png' });

    expect(res.status).toBe(201);
    const { key, fields, url, maxBytes } = res.body.upload;
    expect(key).toMatch(new RegExp(`^orgs/${orgId}/events/${eventId}/banner/[0-9a-f-]{36}\\.png$`));
    expect(url).toBe(`${process.env.S3_ENDPOINT}/${process.env.S3_BUCKET}`);
    expect(fields).toMatchObject({ key, 'Content-Type': 'image/png' });
    expect(maxBytes).toBe(2 * 1024 * 1024);
    const policy = JSON.parse(Buffer.from(fields.Policy, 'base64').toString());
    expect(policy.conditions).toContainEqual(['content-length-range', 1, 2 * 1024 * 1024]);
    expect(policy.conditions).toContainEqual(['eq', '$Content-Type', 'image/png']);
  });

  it('a manager may presign too', async () => {
    const manager = await makeUser('Manav');
    await addMember(orgId, manager.id, 'MANAGER');
    expect((await presign(manager, { eventId, contentType: 'image/webp' })).status).toBe(201);
  });

  it('rejects a content type that is not an image we allow', async () => {
    const res = await presign(owner, { eventId, contentType: 'image/svg+xml' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('a non-member gets 404, the same as for an event that does not exist', async () => {
    const outsider = await makeUser('Eve');
    const res = await presign(outsider, { eventId, contentType: 'image/png' });
    expect(res.status).toBe(404);
    const missing = await presign(owner, {
      eventId: crypto.randomUUID(),
      contentType: 'image/png',
    });
    expect(missing.status).toBe(404);
  });

  it('a scanner of the org gets 403', async () => {
    const scanner = await makeUser('Sam');
    await addMember(orgId, scanner.id, 'SCANNER');
    expect((await presign(scanner, { eventId, contentType: 'image/png' })).status).toBe(403);
  });

  it('needs a login', async () => {
    const res = await request(app)
      .post('/api/v1/uploads/presign')
      .send({ eventId, contentType: 'image/png' });
    expect(res.status).toBe(401);
  });
});

describe('PATCH event bannerKey', () => {
  const newKey = async () =>
    (await presign(owner, { eventId, contentType: 'image/png' })).body.upload.key as string;
  const setBanner = (bannerKey: string | null) =>
    request(app).patch(eventPath()).set(owner.auth).send({ bannerKey });
  const fieldMessage = (res: request.Response) => res.body.error.details.fields[0].message;

  it('saves the key once storage confirms the object, and returns its public URL', async () => {
    const key = await newKey();
    const send = storageHas({ ContentType: 'image/png', ContentLength: 150_000 });

    const res = await setBanner(key);

    expect(res.status).toBe(200);
    expect(res.body.event.bannerKey).toBe(key);
    expect(res.body.event.bannerUrl).toBe(`${process.env.S3_PUBLIC_URL}/${key}`);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0].input).toEqual({ Bucket: process.env.S3_BUCKET, Key: key });
  });

  it('rejects a key with nothing uploaded at it', async () => {
    const key = await newKey();
    storageHas(null);
    const res = await setBanner(key);
    expect(res.status).toBe(400);
    expect(fieldMessage(res)).toMatch(/No file has been uploaded/);
  });

  it('rejects an object over 2 MB', async () => {
    const key = await newKey();
    storageHas({ ContentType: 'image/png', ContentLength: 2 * 1024 * 1024 + 1 });
    const res = await setBanner(key);
    expect(res.status).toBe(400);
    expect(fieldMessage(res)).toMatch(/at most 2 MB/);
  });

  it('rejects an object whose stored type is not an allowed image', async () => {
    const key = await newKey();
    storageHas({ ContentType: 'text/html', ContentLength: 100 });
    expect((await setBanner(key)).status).toBe(400);
  });

  it("rejects another event's key without asking storage", async () => {
    const send = storageHas({ ContentType: 'image/png', ContentLength: 100 });
    const res = await setBanner(
      `orgs/${orgId}/events/${crypto.randomUUID()}/banner/${crypto.randomUUID()}.png`,
    );
    expect(res.status).toBe(400);
    expect(fieldMessage(res)).toMatch(/Not a banner key/);
    expect(send).not.toHaveBeenCalled();
  });

  it('null removes the banner', async () => {
    const key = await newKey();
    storageHas({ ContentType: 'image/png', ContentLength: 100 });
    await setBanner(key);
    const res = await setBanner(null);
    expect(res.status).toBe(200);
    expect(res.body.event).toMatchObject({ bannerKey: null, bannerUrl: null });
  });
});
