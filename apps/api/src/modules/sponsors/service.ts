import { findTicketForGate } from '@festpass/db/tickets';
import { sponsorAnalytics, type ScanEventData } from '@festpass/mongo';
import {
  can,
  JOBS,
  verifyTicket,
  type BoothOption,
  type BoothScanInput,
  type BoothVisit,
  type CreateSponsorInput,
  type SponsorAnalytics,
  type Sponsorship,
  type SponsorView,
} from '@festpass/shared';
import { ticketPublicKey } from '@festpass/shared/server';
import { env } from '../../config/env.js';
import { cached } from '../../lib/cache.js';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { reportsQueue } from '../../lib/queues.js';
import { gateRedis } from '../../lib/redis.js';
import { withTimeout } from '../orders/gate.js';
import { persistScan } from '../checkins/service.js';
import { findMembership, findUserIdByEmail } from '../orgs/repository.js';
import * as repo from './repository.js';

const publicKey = ticketPublicKey(env.TICKET_SIGNING_PRIVATE_KEY);

type SponsorRecord = NonNullable<Awaited<ReturnType<typeof repo.findEventSponsor>>>;
const toView = (s: SponsorRecord): SponsorView => ({
  id: s.id,
  name: s.name,
  tier: s.tier,
  booths: s.booths,
  members: s.members.map(({ user }) => ({ userId: user.id, name: user.name, email: user.email })),
});

// ---- Organizer side (event:update in the event's club) ----

async function assertEventInOrg(orgId: string, eventId: string) {
  if (!(await repo.eventInOrg(orgId, eventId))) throw new NotFoundError('Event not found');
}

async function loadSponsor(orgId: string, eventId: string, sponsorId: string) {
  await assertEventInOrg(orgId, eventId);
  const sponsor = await repo.findEventSponsor(eventId, sponsorId);
  if (!sponsor) throw new NotFoundError('Sponsor not found');
  return sponsor;
}

export async function listSponsors(orgId: string, eventId: string) {
  await assertEventInOrg(orgId, eventId);
  return (await repo.listEventSponsors(eventId)).map(toView);
}

export async function createSponsor(orgId: string, eventId: string, input: CreateSponsorInput) {
  await assertEventInOrg(orgId, eventId);
  const sponsor = await repo.createSponsor(eventId, input.name, input.tier);
  if (!sponsor)
    throw new ConflictError('SPONSOR_NAME_TAKEN', 'This event already has that sponsor');
  return toView(sponsor);
}

export async function createBooth(orgId: string, eventId: string, sponsorId: string, name: string) {
  await loadSponsor(orgId, eventId, sponsorId);
  const booth = await repo.createBooth(sponsorId, name);
  if (!booth)
    throw new ConflictError('BOOTH_NAME_TAKEN', 'This sponsor already has a booth with that name');
  return booth;
}

export async function addMember(orgId: string, eventId: string, sponsorId: string, email: string) {
  await loadSponsor(orgId, eventId, sponsorId);
  const user = await findUserIdByEmail(email);
  if (!user)
    throw new NotFoundError('No FestPass account uses this email; ask them to sign up first');
  if (!(await repo.addSponsorMember(sponsorId, user.id))) {
    throw new ConflictError('ALREADY_MEMBER', 'This user is already one of the sponsor’s users');
  }
  return toView((await repo.findEventSponsor(eventId, sponsorId))!);
}

export async function removeMember(
  orgId: string,
  eventId: string,
  sponsorId: string,
  userId: string,
) {
  await loadSponsor(orgId, eventId, sponsorId);
  if (!(await repo.removeSponsorMember(sponsorId, userId)))
    throw new NotFoundError('Not a sponsor user');
}

/**
 * When an event closes: one report job per sponsor. The job ID makes queuing twice harmless.
 * shortcut: if Redis is down at that moment the reports aren't queued (logged); add a sweep of closed
 * events without sent reports if that ever happens in practice.
 */
export async function queueSponsorReports(eventId: string, requestId?: string) {
  for (const { id: sponsorId } of await repo.sponsorIdsOfEvent(eventId)) {
    try {
      await withTimeout(
        reportsQueue.add(
          JOBS.sendSponsorReport,
          { sponsorId, requestId },
          { jobId: `sponsor-report-${sponsorId}` },
        ),
        1000,
      );
    } catch (err) {
      logger.error({ err: (err as Error).message, sponsorId }, 'could not queue sponsor report');
    }
  }
}

// ---- Booths at the event (checkin:scan) ----

export async function listBooths(eventId: string): Promise<BoothOption[]> {
  return (await repo.listEventBooths(eventId)).map((b) => ({
    id: b.id,
    name: b.name,
    sponsorName: b.sponsor.name,
  }));
}

const REPLAY_TTL_SECONDS = 60 * 60;
const replayKey = (clientScanId: string) => `boothscan:${clientScanId}`;

/**
 * A visit to a booth. The ticket must be genuine, current and already through the gate: a booth visit
 * by someone who never entered would be a forged or shared QR. Nothing changes in Postgres; the
 * visit's only trace is the BOOTH scan event, written before answering (unlike the gate, where the
 * decision lives in Postgres and the history can trail behind).
 */
export async function boothScan(
  boothId: string,
  userId: string,
  { qr, deviceId, clientScanId }: BoothScanInput,
): Promise<BoothVisit> {
  const booth = await repo.findBoothForScan(boothId);
  const event = booth?.sponsor.event;
  const membership = event && (await findMembership(event.orgId, userId));
  if (!event || !membership) throw new NotFoundError('Booth not found');
  if (!can(membership.role, 'checkin:scan')) throw new ForbiddenError();
  if (event.status !== 'PUBLISHED')
    throw new ConflictError('EVENT_NOT_OPEN', 'This event is not running');

  // The phone re-sent a scan whose answer it lost: same answer, counted once.
  // shortcut: two copies arriving at the very same moment could both count; a SET NX claim would close it.
  if (clientScanId) {
    const previous = await withTimeout(gateRedis.get(replayKey(clientScanId)), 50).catch(
      () => null,
    );
    if (previous) return JSON.parse(previous) as BoothVisit;
  }

  const ts = new Date();
  const record = (fields: Partial<ScanEventData> & Pick<ScanEventData, 'result'>) =>
    persistScan({
      ts,
      meta: { eventId: event.id, type: 'BOOTH', gateOrBoothId: boothId },
      scannerUserId: userId,
      deviceId,
      offline: false,
      ticketId: null,
      college: null,
      branch: null,
      graduationYear: null,
      tierName: null,
      ...fields,
    });

  const verified = await verifyTicket(qr, publicKey);
  if (!verified.valid) {
    await record({ result: 'INVALID' });
    throw new AppError(400, 'INVALID_QR', 'This is not a valid FestPass ticket');
  }
  const { t: ticketId, e: qrEventId, v: qrVersion } = verified.payload;
  const ticket = qrEventId === event.id ? await findTicketForGate(ticketId) : null;
  if (!ticket || ticket.order.eventId !== event.id) {
    await record({ result: 'INVALID', ticketId });
    throw new ConflictError('WRONG_EVENT', 'This ticket is for a different event');
  }
  const attendee = {
    ticketId,
    college: ticket.owner.college,
    branch: ticket.owner.branch,
    graduationYear: ticket.owner.graduationYear,
    tierName: ticket.tier.name,
  };
  if (qrVersion !== ticket.qrVersion) {
    await record({ result: 'REVOKED', ...attendee });
    throw new ConflictError(
      'QR_REVOKED',
      'This QR was replaced by a newer one; ask for the latest',
    );
  }
  if (!ticket.checkedInAt) {
    await record({ result: 'INVALID', ...attendee });
    throw new ConflictError('NOT_CHECKED_IN', 'This ticket has not been through the gate yet');
  }

  await record({ result: 'ACCEPTED', ...attendee });
  const visit: BoothVisit = { boothId, tierName: ticket.tier.name, at: ts.toISOString() };
  if (clientScanId) {
    await withTimeout(
      gateRedis.set(replayKey(clientScanId), JSON.stringify(visit), 'EX', REPLAY_TTL_SECONDS),
      50,
    ).catch((err: Error) => logger.warn({ err: err.message }, 'could not remember booth scan'));
  }
  return visit;
}

// ---- Sponsor portal (the sponsor's own users only) ----

export async function mySponsorships(userId: string): Promise<Sponsorship[]> {
  return (await repo.listSponsorships(userId)).map((s) => ({
    sponsorId: s.id,
    name: s.name,
    tier: s.tier,
    event: { ...s.event, startsAt: s.event.startsAt.toISOString() },
    booths: s.booths,
  }));
}

/**
 * Only the sponsor's own users get an answer; for anyone else this sponsor doesn't exist (404), so
 * sponsor IDs can't be probed. The booth list comes from the sponsor's own row, never from the
 * request, so a sponsor can't ask about another sponsor's booths. Cached for 30 s.
 */
export async function analyticsFor(userId: string, sponsorId: string): Promise<SponsorAnalytics> {
  const sponsor = await repo.findSponsorForMember(sponsorId, userId);
  if (!sponsor) throw new NotFoundError('Sponsor not found');
  const result = await cached<SponsorAnalytics>(`cache:sponsor:${sponsorId}`, () =>
    sponsorAnalytics(sponsor),
  );
  return result!;
}
