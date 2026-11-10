import type { RequestHandler } from 'express';
import * as uploads from './service.js';

export const presign: RequestHandler = async (req, res) => {
  res.status(201).json({ upload: await uploads.presignBanner(req.user!.id, req.body) });
};
