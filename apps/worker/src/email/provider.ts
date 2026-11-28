import type { EmailTemplate } from '@festpass/shared';

// The worker sends email through this interface only. Jobs say *what* to send (a template name and its
// data); a provider decides *how*. SendGrid in production, the console in development and a fake in
// tests: swapping one changes no job code, and tests check emails without a network or an account.

/** An image the email shows inline: the HTML refers to it as <img src="cid:{contentId}">. */
export interface InlineImage {
  contentId: string;
  filename: string;
  content: Buffer;
  type: 'image/png';
}

/** A file sent with the email, e.g. a PDF report. */
export interface Attachment {
  filename: string;
  content: Buffer;
  type: 'application/pdf';
}

export interface EmailMessage {
  to: { email: string; name: string };
  template: EmailTemplate;
  /** The dynamic template data: the fields each SendGrid template uses (see README "Email setup"). */
  data: Record<string, unknown>;
  inlineImages?: InlineImage[];
  attachments?: Attachment[];
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}
