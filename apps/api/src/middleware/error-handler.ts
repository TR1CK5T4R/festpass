import type { ApiErrorBody } from '@festpass/shared';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { env } from '../config/env.js';
import { AppError, NotFoundError } from '../lib/errors.js';

function errorBody(
  code: string,
  message: string,
  details: Record<string, unknown>,
  requestId: unknown,
): ApiErrorBody {
  return { error: { code, message, details, requestId: String(requestId) } };
}

/** Errors from Express's body parser (bad JSON, body too large): they describe the request, so they're safe to show. */
function isClientHttpError(
  err: unknown,
): err is { status: number; type?: string; message: string } {
  const e = err as { status?: unknown; expose?: unknown };
  return typeof e?.status === 'number' && e.status >= 400 && e.status < 500 && e.expose === true;
}

/** Mounted after every route: anything that reaches it matched nothing. */
export const notFound: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`No route for ${req.method} ${req.path}`));
};

/**
 * The only place that turns errors into HTTP responses, so every error has the same shape and nothing
 * internal leaks by accident. Express 5 forwards rejected promises from async handlers here automatically.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err instanceof AppError) {
    res.status(err.status).json(errorBody(err.code, err.message, err.details, req.id));
    return;
  }

  if (isClientHttpError(err)) {
    const invalidJson = err.type === 'entity.parse.failed';
    res
      .status(err.status)
      .json(
        errorBody(
          invalidJson ? 'INVALID_JSON' : 'BAD_REQUEST',
          invalidJson ? 'Request body is not valid JSON' : err.message,
          {},
          req.id,
        ),
      );
    return;
  }

  // A bug or an outage. The full error goes to the logs (tagged with the request ID); the client gets
  // a generic message, except in local development where the message and stack help debugging.
  req.log.error({ err }, 'unhandled error');
  const dev = env.NODE_ENV === 'development';
  const e = err as Error;
  res
    .status(500)
    .json(
      errorBody(
        'INTERNAL_ERROR',
        dev ? e.message : 'Something went wrong',
        dev ? { stack: e.stack } : {},
        req.id,
      ),
    );
};
