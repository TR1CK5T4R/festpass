import type { Server as HttpServer } from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import {
  AVAILABILITY_CHANNEL,
  joinEventSchema,
  redisKeys,
  SOCKET_UNAUTHORIZED,
  type ClientToServerEvents,
  type JoinEventInput,
  type JoinResult,
  type LiveScan,
  type ServerToClientEvents,
} from '@festpass/shared';
import { Server, type Socket } from 'socket.io';
import { logger } from '../lib/logger.js';
import { redis } from '../lib/redis.js';
import { verifyAccessTokenClaims } from '../modules/auth/service.js';
import { findEventOrg } from '../modules/events/repository.js';
import { findMembership } from '../modules/orgs/repository.js';
import {
  createAvailabilityReader,
  createAvailabilityThrottle,
  THROTTLE_WINDOW_MS,
} from './availability.js';

interface SocketData {
  /** Set by the handshake when a valid token came with it; anonymous otherwise. */
  userId?: string;
  tokenExpiresAt?: number;
}
type IoServer = Server<ClientToServerEvents, ServerToClientEvents, never, SocketData>;
type IoSocket = Socket<ClientToServerEvents, ServerToClientEvents, never, SocketData>;

const publicRoom = (eventId: string) => `event:${eventId}:public`;
const staffRoom = (eventId: string) => `event:${eventId}:staff`;

/**
 * Handshake auth. No token means anonymous, which is fine for public rooms. A token that is present must
 * be valid: refusing it tells the client to refresh, where quietly treating it as anonymous would leave
 * a logged-in organizer wondering why the feed is empty.
 */
function authenticate(socket: IoSocket, next: (err?: Error) => void) {
  const { token } = socket.handshake.auth as { token?: unknown };
  if (token === undefined) return next();
  try {
    if (typeof token !== 'string') throw new Error('token must be a string');
    const claims = verifyAccessTokenClaims(token);
    socket.data.userId = claims.userId;
    socket.data.tokenExpiresAt = claims.exp && claims.exp * 1000;
    next();
  } catch {
    next(new Error(SOCKET_UNAUTHORIZED));
  }
}

/**
 * A connection can outlive its token. Ending it when the token expires means the client has to come
 * back with a fresh one and pass the membership check again, so someone removed from a club loses the
 * staff feed within one token lifetime (15 minutes).
 */
function disconnectWhenTokenExpires(socket: IoSocket) {
  const { tokenExpiresAt } = socket.data;
  if (!tokenExpiresAt) return;
  const timer = setTimeout(() => socket.disconnect(true), tokenExpiresAt - Date.now());
  socket.on('disconnect', () => clearTimeout(timer));
}

async function canJoinStaff(eventId: string, userId: string) {
  const event = await findEventOrg(eventId);
  return Boolean(event && (await findMembership(event.orgId, userId)));
}

let current: IoServer | null = null;

/** Sends a scan to the event's staff room. Does nothing if this process has no sockets (tests, scripts). */
export function emitScan(eventId: string, scan: LiveScan) {
  current?.to(staffRoom(eventId)).emit('scan', scan);
}

/** Attaches Socket.IO to the API's HTTP server. */
export function attachSockets(httpServer: HttpServer) {
  const io: IoServer = new Server(httpServer, {
    // WebSocket only: long polling would need sticky sessions, because its requests must all reach the
    // same instance. There is no CORS to configure either: browsers don't apply CORS to WebSockets, and
    // the token travels in the handshake rather than a cookie, so another site can't borrow a session.
    transports: ['websocket'],
    serveClient: false,
    // Clients only ever send a small join message.
    maxHttpBufferSize: 10_000,
  });
  current = io;

  // Without the adapter, io.to(room).emit() reaches only the sockets connected to this one process.
  // Subscribed clients can't run other commands, hence the separate connections.
  const adapterPub = redis.duplicate();
  const adapterSub = redis.duplicate();
  const changes = redis.duplicate();
  for (const client of [adapterPub, adapterSub, changes]) {
    client.on('error', (err) => logger.warn({ err: err.message }, 'socket redis error'));
  }
  io.adapter(createAdapter(adapterPub, adapterSub));

  const reader = createAvailabilityReader();

  async function join(
    socket: IoSocket,
    { eventId, room }: JoinEventInput,
    reply: (result: JoinResult) => void,
  ) {
    try {
      if (room === 'staff') {
        if (!socket.data.userId) return reply({ ok: false, code: 'UNAUTHORIZED' });
        // Same answer for "no such event" and "not your club", so event IDs can't be probed.
        if (!(await canJoinStaff(eventId, socket.data.userId))) {
          return reply({ ok: false, code: 'NOT_FOUND' });
        }
        await socket.join(staffRoom(eventId));
        return reply({ ok: true });
      }
      // In the room first, so a change that lands while the snapshot is being read still arrives.
      await socket.join(publicRoom(eventId));
      reply({ ok: true });
      const snapshot = await reader.snapshot(eventId);
      if (snapshot) socket.emit('availability', snapshot);
    } catch (err) {
      logger.error({ err: (err as Error).message, eventId, room }, 'socket join failed');
      reply({ ok: false, code: 'INTERNAL' });
    }
  }

  io.use(authenticate);
  // shortcut: no limit on connections per IP or rooms per socket; add one if a sale ever draws abuse.
  io.on('connection', (socket) => {
    disconnectWhenTokenExpires(socket);
    socket.on('event:join', (raw, ack) => {
      const reply = typeof ack === 'function' ? ack : () => undefined;
      const input = joinEventSchema.safeParse(raw);
      if (!input.success) return reply({ ok: false, code: 'VALIDATION_FAILED' });
      void join(socket, input.data, reply);
    });
  });

  const changed = createAvailabilityThrottle({
    windowMs: THROTTLE_WINDOW_MS,
    // The claim lives in Redis, so the limit holds per event, not per event per API instance.
    claim: async (eventId, windowMs) =>
      (await redis.set(redisKeys.availabilityThrottle(eventId), '1', 'PX', windowMs, 'NX')) ===
      'OK',
    send: (eventId) => {
      reader.fresh(eventId).then(
        (update) => {
          if (update) io.to(publicRoom(eventId)).emit('availability', update);
        },
        (err: Error) => logger.warn({ err: err.message, eventId }, 'availability read failed'),
      );
    },
  });
  changes.on('message', (_channel, eventId) => {
    changed(eventId).catch((err: Error) =>
      logger.warn({ err: err.message, eventId }, 'availability throttle failed'),
    );
  });
  changes
    .subscribe(AVAILABILITY_CHANNEL)
    .catch((err: Error) =>
      logger.error({ err: err.message }, 'could not subscribe to availability changes'),
    );

  return {
    io,
    /** Ends every connection and closes the HTTP server, after in-flight requests finish. */
    async close() {
      if (current === io) current = null;
      await io.close();
      // quit, not disconnect: a subscribe still in flight finishes instead of rejecting with nobody to catch it.
      await Promise.allSettled([adapterPub.quit(), adapterSub.quit(), changes.quit()]);
    },
  };
}
