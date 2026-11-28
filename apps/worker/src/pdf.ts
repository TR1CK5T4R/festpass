import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import type { SponsorAnalytics } from '@festpass/shared';

export interface PdfTicket {
  code: string;
  tierName: string;
  /** The signed FP1.… string the gate scans. */
  qr: string;
}

export interface TicketsPdfInput {
  eventTitle: string;
  eventDate: string;
  venue: string;
  attendeeName: string;
  tickets: PdfTicket[];
}

/** The QR image of a ticket, as a PNG. Medium error correction survives a cracked phone screen. */
export const qrPng = (qr: string) =>
  QRCode.toBuffer(qr, { errorCorrectionLevel: 'M', margin: 1, width: 600 });

/** One A5 page per ticket: event, attendee, tier, the QR and the short code to read out. */
export async function buildTicketsPdf(input: TicketsPdfInput): Promise<Buffer> {
  const images = await Promise.all(input.tickets.map((t) => qrPng(t.qr)));
  const doc = new PDFDocument({
    size: 'A5',
    margin: 40,
    info: { Title: `Tickets: ${input.eventTitle}` },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) =>
    doc.on('end', () => resolve(Buffer.concat(chunks))),
  );

  input.tickets.forEach((ticket, i) => {
    if (i > 0) doc.addPage();
    doc.fontSize(10).fillColor('#5b6577').text('FESTPASS TICKET', { characterSpacing: 2 });
    doc.moveDown(0.5).fontSize(20).fillColor('#0f172a').text(input.eventTitle);
    doc.fontSize(11).fillColor('#5b6577').text(`${input.eventDate} · ${input.venue}`);
    doc.moveDown().fontSize(12).fillColor('#0f172a').text(input.attendeeName);
    doc
      .fontSize(11)
      .fillColor('#5b6577')
      .text(`${ticket.tierName} · ticket ${i + 1} of ${input.tickets.length}`);
    doc.image(images[i]!, (doc.page.width - 260) / 2, doc.y + 20, { width: 260 });
    doc.y += 300;
    doc
      .fontSize(16)
      .fillColor('#0f172a')
      .text(ticket.code, { align: 'center', characterSpacing: 3 });
    doc
      .fontSize(9)
      .fillColor('#5b6577')
      .text('Show this QR at the entrance. Each ticket gets in once.', { align: 'center' });
  });
  doc.end();
  return done;
}

const percent = (share: number | null) => (share === null ? 'n/a' : `${Math.round(share * 100)}%`);

/**
 * The sponsor's post-event report, one A4 page of counts. Like the dashboard it holds no names, emails
 * or ticket IDs, and small groups are already folded into "Other" by the aggregation.
 */
export async function buildSponsorReportPdf(
  report: SponsorAnalytics,
  eventDate: string,
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 50,
    info: { Title: `${report.sponsor.name} at ${report.event.title}` },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) =>
    doc.on('end', () => resolve(Buffer.concat(chunks))),
  );
  const ink = '#0f172a';
  const muted = '#5b6577';
  const heading = (text: string) => doc.moveDown(1.2).fontSize(13).fillColor(ink).text(text);
  const row = (label: string, value: string | number) =>
    doc
      .fontSize(11)
      .fillColor(muted)
      .text(`${label}: `, { continued: true })
      .fillColor(ink)
      .text(String(value));
  const { totals } = report;

  doc.fontSize(10).fillColor(muted).text('FESTPASS SPONSOR REPORT', { characterSpacing: 2 });
  doc.moveDown(0.5).fontSize(22).fillColor(ink).text(report.sponsor.name);
  doc.fontSize(12).fillColor(muted).text(`${report.event.title} · ${eventDate}`);

  heading('Visitors');
  row('People who visited your booths', totals.uniqueVisitors);
  row('Share of everyone who came', `${percent(totals.shareOfAttendance)} of ${totals.attendance}`);
  row('Came back more than once', totals.repeatVisitors);
  row('Visits in all', totals.visits);

  heading('Booths');
  for (const booth of report.booths) {
    row(booth.name, `${booth.uniqueVisitors} visitors, ${booth.visits} visits`);
  }

  const perHour = new Map<string, number>();
  for (const cell of report.heatmap)
    perHour.set(cell.hour, (perHour.get(cell.hour) ?? 0) + cell.visits);
  const busiest = [...perHour].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (busiest) {
    const hour = new Date(busiest[0]).toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: 'numeric',
      hour12: true,
    });
    heading('Busiest hour');
    row(`From ${hour}`, `${busiest[1]} visits`);
  }

  const label = (value: string | number | null) => (value === null ? 'Not given' : String(value));
  heading('Visitors by branch');
  for (const b of report.breakdown.branch) row(label(b.value), b.count);
  heading('Visitors by graduation year');
  for (const y of report.breakdown.graduationYear) row(label(y.value), y.count);

  doc
    .moveDown(2)
    .fontSize(9)
    .fillColor(muted)
    .text(
      `Counts only: no names or contact details are shared. Groups smaller than ${report.minGroupSize} people are counted under "Other".`,
    );
  doc.end();
  return done;
}
