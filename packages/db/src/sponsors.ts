import { prisma } from './index.js';

// What the worker needs for a sponsor's post-event report, and the per-recipient send log. The log
// works like email_log (see emails.ts): one row per (sponsor, user), sent_at records success, and
// claimed_at is a 5-minute lease so two runs of the job never both send to the same person.

const LEASE = '5 minutes';

/** The sponsor, its event, booths and users. Users' emails are only used to send them their report. */
export function findSponsorForReport(sponsorId: string) {
  return prisma.sponsor.findUnique({
    where: { id: sponsorId },
    select: {
      id: true,
      name: true,
      tier: true,
      event: { select: { id: true, title: true, startsAt: true, venue: true, status: true } },
      booths: { select: { id: true, name: true }, orderBy: { name: 'asc' } },
      members: {
        select: { user: { select: { id: true, name: true, email: true } } },
        orderBy: { user: { email: 'asc' } },
      },
    },
  });
}
export type SponsorForReport = NonNullable<Awaited<ReturnType<typeof findSponsorForReport>>>;

/** The right to send this sponsor's report to this user: false if sent, or being sent right now. */
export async function claimSponsorReport(sponsorId: string, userId: string): Promise<boolean> {
  await prisma.$executeRaw`
    INSERT INTO sponsor_report_log (sponsor_id, user_id) VALUES (${sponsorId}::uuid, ${userId}::uuid)
    ON CONFLICT (sponsor_id, user_id) DO NOTHING`;
  const claimed = await prisma.$executeRaw`
    UPDATE sponsor_report_log SET claimed_at = now()
    WHERE sponsor_id = ${sponsorId}::uuid AND user_id = ${userId}::uuid AND sent_at IS NULL
      AND (claimed_at IS NULL OR claimed_at < now() - ${LEASE}::interval)`;
  return claimed === 1;
}

export async function markSponsorReportSent(sponsorId: string, userId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE sponsor_report_log SET sent_at = now()
    WHERE sponsor_id = ${sponsorId}::uuid AND user_id = ${userId}::uuid`;
}

/** After a failed send: drop the lease, so the job's retry can claim it again at once. */
export async function releaseSponsorReportClaim(sponsorId: string, userId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE sponsor_report_log SET claimed_at = NULL
    WHERE sponsor_id = ${sponsorId}::uuid AND user_id = ${userId}::uuid AND sent_at IS NULL`;
}
