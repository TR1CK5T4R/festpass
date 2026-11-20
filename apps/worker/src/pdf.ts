import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

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
