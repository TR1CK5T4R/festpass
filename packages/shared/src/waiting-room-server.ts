import type { Redis } from 'ioredis';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { QUEUE_ADMITTED_CHANNEL, redisKeys } from './redis-keys.ts';
import { ADMISSION_TOKEN_TTL_SECONDS } from './waiting-room.ts';

// The waiting room's Redis work and tokens, used by the API (join, status, verify) and the worker (admit).
// A sorted set keeps the line in order however many API instances add to it, and finding a position in
// it (ZRANK) stays fast with a million people in line, where a list would have to walk through them.

export function signAdmissionToken(userId: string, eventId: string, secret: string) {
  return jwt.sign({ eventId }, secret, {
    subject: userId,
    algorithm: 'HS256',
    expiresIn: ADMISSION_TOKEN_TTL_SECONDS,
  });
}

/** True only for an unexpired token signed for this user and this event. */
export function isValidAdmission(
  token: string | undefined,
  userId: string,
  eventId: string,
  secret: string,
) {
  if (!token) return false;
  try {
    const claims = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      subject: userId,
    }) as JwtPayload;
    return claims.eventId === eventId;
  } catch {
    return false;
  }
}

/**
 * KEYS: line, the user's admission, active rooms. ARGV: userId, eventId.
 * NX keeps the first score, so joining again never moves anyone, forwards or back. Someone already
 * admitted stays admitted instead of joining the back of the line. The score is Redis's own clock, so
 * API instances with different clocks still agree on who came first.
 */
const JOIN = `
if redis.call('EXISTS', KEYS[2]) == 0 then
  local now = redis.call('TIME')
  redis.call('ZADD', KEYS[1], 'NX', tonumber(now[1]) * 1000000 + tonumber(now[2]), ARGV[1])
  redis.call('SADD', KEYS[3], ARGV[2])
end
return 'OK'`;

export function joinWaitingRoom(redis: Redis, eventId: string, userId: string): Promise<unknown> {
  return redis.eval(
    JOIN,
    3,
    redisKeys.waitingRoom(eventId),
    redisKeys.admission(eventId, userId),
    redisKeys.activeWaitingRooms,
    userId,
    eventId,
  );
}

/** Where a user stands in Redis: admitted, in line (rank 0 is next), or neither. */
export async function waitingRoomPlace(
  redis: Redis,
  eventId: string,
  userId: string,
): Promise<{ token: string; ttlMs: number } | { rank: number } | null> {
  const key = redisKeys.admission(eventId, userId);
  // MULTI, because admission moves a user between these keys: two separate reads could fall on either
  // side of that move and find them in neither.
  const replies = await redis
    .multi()
    .get(key)
    .pttl(key)
    .zrank(redisKeys.waitingRoom(eventId), userId)
    .exec();
  if (!replies) throw new Error('waiting room read was aborted');
  const [token, ttlMs, rank] = replies.map(([err, value]) => {
    if (err) throw err;
    return value;
  }) as [string | null, number, number | null];
  if (token) return { token, ttlMs };
  return rank === null ? null : { rank };
}

/**
 * KEYS: line, active rooms, then one admission key per user. ARGV: eventId, TTL, the users, their tokens.
 * Removing a user and storing their token happen as one step, so nobody is ever in neither place. Only
 * whoever really removes a user stores a token, so a retried or overlapping run can't admit anyone twice.
 * Removing the room from the active set here too means it can't race a join, which adds both at once.
 */
const ADMIT = `
local count = #KEYS - 2
local admitted = {}
for i = 1, count do
  local user = ARGV[2 + i]
  if redis.call('ZREM', KEYS[1], user) == 1 then
    redis.call('SET', KEYS[2 + i], ARGV[2 + count + i], 'EX', ARGV[2])
    admitted[#admitted + 1] = user
  end
end
if redis.call('ZCARD', KEYS[1]) == 0 then redis.call('SREM', KEYS[2], ARGV[1]) end
return admitted`;

/**
 * Lets the next `count` users in, oldest first, and tells the API instances. Reads, signs, then removes,
 * instead of ZPOPMIN then signing: a crash in between loses nobody's place, and a retry admits nobody extra.
 */
export async function admitNext(redis: Redis, eventId: string, count: number, secret: string) {
  const line = redisKeys.waitingRoom(eventId);
  const users = await redis.zrange(line, '0', String(count - 1));
  const admitted = (await redis.eval(
    ADMIT,
    users.length + 2,
    line,
    redisKeys.activeWaitingRooms,
    ...users.map((userId) => redisKeys.admission(eventId, userId)),
    eventId,
    ADMISSION_TOKEN_TTL_SECONDS,
    ...users,
    ...users.map((userId) => signAdmissionToken(userId, eventId, secret)),
  )) as string[];
  if (admitted.length > 0) {
    const notices = redis.pipeline();
    for (const userId of admitted) {
      notices.publish(QUEUE_ADMITTED_CHANNEL, JSON.stringify({ eventId, userId }));
    }
    // If this is lost, the page still finds out on its next status check.
    await notices.exec();
  }
  return admitted;
}

/** Ends a line. Tokens already issued stay valid until they expire. */
export function closeWaitingRoom(redis: Redis, eventId: string): Promise<unknown> {
  return redis
    .multi()
    .del(redisKeys.waitingRoom(eventId))
    .srem(redisKeys.activeWaitingRooms, eventId)
    .exec();
}

export const activeWaitingRooms = (redis: Redis) => redis.smembers(redisKeys.activeWaitingRooms);
