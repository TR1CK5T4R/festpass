import sgMail from '@sendgrid/mail';
import type { EmailTemplate } from '@festpass/shared';
import type { EmailMessage, EmailProvider } from './provider.js';

/**
 * SendGrid dynamic templates: the design lives in SendGrid (editable without a deploy), and we send
 * only the template ID and its data. Inline images go as attachments with a Content-ID.
 */
export function sendGridProvider(options: {
  apiKey: string;
  from: string;
  templateIds: Record<EmailTemplate, string>;
}): EmailProvider {
  sgMail.setApiKey(options.apiKey);
  return {
    async send({ to, template, data, inlineImages = [], attachments = [] }: EmailMessage) {
      await sgMail.send({
        to,
        from: options.from,
        templateId: options.templateIds[template],
        dynamicTemplateData: data,
        attachments: [
          ...inlineImages.map((img) => ({
            content: img.content.toString('base64'),
            filename: img.filename,
            type: img.type,
            disposition: 'inline',
            contentId: img.contentId,
          })),
          ...attachments.map((file) => ({
            content: file.content.toString('base64'),
            filename: file.filename,
            type: file.type,
            disposition: 'attachment',
          })),
        ],
      });
    },
  };
}
