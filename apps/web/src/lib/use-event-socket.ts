'use client';

import {
  SOCKET_UNAUTHORIZED,
  type AvailabilityUpdate,
  type ClientToServerEvents,
  type JoinEventInput,
  type LiveScan,
  type ServerToClientEvents,
} from '@festpass/shared';
import { useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';

/** connecting: first attempt. reconnecting: was or is failing, retrying. denied: the server said no. */
export type SocketStatus = 'connecting' | 'live' | 'reconnecting' | 'denied';

export interface EventSocketOptions {
  /** Null keeps it disconnected, e.g. for an event that has nothing live to show. */
  eventId: string | null;
  room: JoinEventInput['room'];
  /** For the staff room. Passed in so public pages never load the auth client. */
  session?: { token: () => string | null; refresh: () => Promise<boolean> };
  onAvailability?: (update: AvailabilityUpdate) => void;
  onScan?: (scan: LiveScan) => void;
  /** After every successful join, so a page can catch up on what it missed while disconnected. */
  onJoined?: () => void;
}

const SOCKET_URL = new URL(process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1')
  .origin;
const RETRY_AFTER_REFRESH_MS = 2_000;

export function useEventSocket(options: EventSocketOptions): SocketStatus {
  const { eventId, room } = options;
  const [status, setStatus] = useState<SocketStatus>('connecting');
  // The socket lives as long as the event and room; handlers change on every render.
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  useEffect(() => {
    if (!eventId) return;
    let stopped = false;
    let socket: Socket<ServerToClientEvents, ClientToServerEvents> | undefined;

    // Socket.IO doesn't retry after the server turned the token down or ended the connection itself
    // (its token expired), so get a new token and try again. A dead session stops here.
    async function reconnectWithFreshToken() {
      const refreshed = await latest.current.session?.refresh();
      if (stopped) return;
      if (!refreshed) {
        setStatus('denied');
        return;
      }
      setTimeout(() => {
        if (!stopped) socket?.connect();
      }, RETRY_AFTER_REFRESH_MS);
    }

    // Loaded on demand, so the event page's first paint doesn't pay for it.
    void import('socket.io-client').then(({ io }) => {
      if (stopped) return;
      socket = io(SOCKET_URL, {
        transports: ['websocket'],
        auth: (send) => {
          const token = latest.current.session?.token();
          send(token ? { token } : {});
        },
        // Socket.IO already backs off with random jitter. A longer ceiling spreads out the crowd
        // reconnecting at once if an API instance restarts during a sale.
        reconnectionDelayMax: 15_000,
      });
      socket.on('availability', (update) => latest.current.onAvailability?.(update));
      socket.on('scan', (scan) => latest.current.onScan?.(scan));
      // Rooms belong to a connection, so every reconnect has to join again.
      socket.on('connect', () => {
        socket?.emit('event:join', { eventId, room }, (result) => {
          setStatus(result.ok ? 'live' : 'denied');
          if (result.ok) latest.current.onJoined?.();
        });
      });
      socket.on('disconnect', (reason) => {
        setStatus('reconnecting');
        if (reason === 'io server disconnect') void reconnectWithFreshToken();
      });
      socket.on('connect_error', (err) => {
        setStatus('reconnecting');
        if (err.message === SOCKET_UNAUTHORIZED) void reconnectWithFreshToken();
      });
    });

    return () => {
      stopped = true;
      socket?.disconnect();
    };
  }, [eventId, room]);

  return status;
}
