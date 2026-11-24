import type { RequestHandler } from 'express';

/**
 * CORS for the web app. Credentials (the refresh cookie) only work with an exact origin, never "*",
 * so the request's Origin is echoed back only if it is on the allow-list. Other origins get no CORS
 * headers, and the browser refuses to let their pages read our responses.
 */
export function cors(allowedOrigins: readonly string[]): RequestHandler {
  return (req, res, next) => {
    // Responses differ per Origin, so caches must not share them across origins.
    res.vary('Origin');
    const origin = req.headers.origin;
    if (!origin || !allowedOrigins.includes(origin)) return next();

    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    // Response headers the web app may read (others are hidden from cross-origin scripts).
    res.setHeader(
      'Access-Control-Expose-Headers',
      'X-Request-Id, Idempotent-Replayed, Retry-After, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset',
    );
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE');
      // Every custom request header the web app sends must be listed, or the browser blocks the request.
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-Request-Id, Idempotency-Key, X-Admission-Token',
      );
      res.setHeader('Access-Control-Max-Age', '600');
      res.status(204).end();
      return;
    }
    next();
  };
}
