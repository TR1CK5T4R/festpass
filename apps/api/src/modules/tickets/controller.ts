import type { RequestHandler } from 'express';
import * as tickets from './service.js';

export const listMine: RequestHandler = async (req, res) => {
  res.json({ tickets: await tickets.listMyTickets(req.user!.id) });
};

export const get: RequestHandler = async (req, res) => {
  res.json({ ticket: await tickets.getMyTicket(req.user!.id, String(req.params.ticketId)) });
};

export const reissue: RequestHandler = async (req, res) => {
  res.json({ ticket: await tickets.reissueQr(req.user!.id, String(req.params.ticketId)) });
};
