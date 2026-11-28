import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { EmailMessage, EmailProvider } from './provider.js';

const escape = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A rough stand-in for each SendGrid template, so a preview shows the same fields. */
function render({ template, data }: EmailMessage, imageSrc: (cid: string) => string): string {
  const d = data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- preview only
  // Functions, so only the template being sent runs: the others' fields aren't in this message.
  const body: Record<EmailMessage['template'], () => string> = {
    'ticket-confirmation': () => `
      <h1>Your tickets for ${escape(d.eventTitle)}</h1>
      <p>Hi ${escape(d.name)}, you're going! ${escape(d.eventDate)} at ${escape(d.venue)}.</p>
      ${(d.tickets as { code: string; tier: string; qrCid: string }[])
        .map(
          (t) =>
            `<p><img src="${imageSrc(t.qrCid)}" width="180" alt="QR code"><br>${escape(t.tier)} · <code>${escape(t.code)}</code></p>`,
        )
        .join('')}
      <p><a href="${escape(d.downloadUrl)}">Download your PDF tickets</a> (link valid until ${escape(d.downloadExpiresAt)})</p>
      <p><a href="${escape(d.ticketsUrl)}">See your tickets on FestPass</a></p>`,
    'order-expired': () => `
      <h1>Your hold on ${escape(d.eventTitle)} ended</h1>
      <p>Hi ${escape(d.name)}, the tickets you held went back on sale because the payment didn't arrive in time. You weren't charged.</p>
      <p><a href="${escape(d.bookAgainUrl)}">Book again</a></p>`,
    'sponsor-report': () => `
      <h1>Your booth report for ${escape(d.eventTitle)}</h1>
      <p>Hi ${escape(d.name)}, here is how ${escape(d.sponsorName)} did: ${escape(d.uniqueVisitors)} visitors (${escape(d.shareOfAttendance)} of everyone who came), ${escape(d.repeatVisitors)} of them more than once, ${escape(d.visits)} visits in all.</p>
      <p>The full report is attached as a PDF.</p>`,
    'refund-issued': () => `
      <h1>Refund issued for ${escape(d.eventTitle)}</h1>
      <p>Hi ${escape(d.name)}, we refunded ${escape(d.amount)}: ${escape(d.reason)}.</p>
      <p>It usually reaches your account in 5 to 7 working days.</p>`,
  };
  return `<!doctype html><meta charset="utf-8"><title>${escape(template)}</title><body style="font-family:sans-serif;max-width:600px">${body[template]()}</body>`;
}

/** Development: logs each email and writes an HTML preview (with its images) to a local folder. */
export function consoleProvider(dir: string, log: Logger): EmailProvider {
  return {
    async send(message) {
      const stamp = new Date().toISOString().replaceAll(':', '-');
      const base = `${stamp}-${message.template}`;
      await mkdir(dir, { recursive: true });
      for (const img of message.inlineImages ?? []) {
        await writeFile(join(dir, `${base}-${img.filename}`), img.content);
      }
      for (const file of message.attachments ?? []) {
        await writeFile(join(dir, `${base}-${file.filename}`), file.content);
      }
      const file = join(dir, `${base}.html`);
      await writeFile(
        file,
        render(message, (cid) => {
          const img = message.inlineImages?.find((i) => i.contentId === cid);
          return img ? `${base}-${img.filename}` : '';
        }),
      );
      log.info(
        { to: message.to.email, template: message.template, preview: file },
        'email (console provider)',
      );
    },
  };
}
