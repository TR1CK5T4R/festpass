# FestPass frontend (`apps/web`)

The Next.js app every FestPass user touches: attendees browsing and buying tickets, organizers running events, volunteers scanning passes at the gate, and sponsors checking their booth numbers.

Back to the [project README](../../README.md) · See also the [backend README](../api/README.md)

## Status

| Area | Who uses it | Route(s) | Status |
|---|---|---|---|
| Placeholder home page | everyone | `/` | Done (Day 1) |
| Design tokens, base components, auth screens | everyone | `/login`, `/register` | Planned (Day 7) |
| Organizer dashboard: events, tiers, members | organizers | `/dashboard/...` | Planned (Day 9) |
| Banner uploads straight to storage | organizers | inside the event editor | Planned (Days 8–9) |
| Public event list and event pages (SSR + ISR) | attendees | `/`, `/e/[slug]` | Planned (Day 10) |
| Checkout with a hold countdown and Razorpay | attendees | `/checkout/[orderId]` | Planned (Day 15) |
| My Tickets with QR codes and PDF download | attendees | `/tickets` | Planned (Day 18) |
| Scanner PWA with offline mode | volunteers | `/scan` | Planned (Day 20) |
| Live availability and check-in counter | attendees, organizers | event page, dashboard | Planned (Day 21) |
| Virtual waiting room | attendees | `/e/[slug]/queue` | Planned (Day 22) |
| Analytics charts | organizers | dashboard | Planned (Day 25) |
| Sponsor dashboard and booth-mode scanning | sponsors, volunteers | `/sponsor`, `/scan` | Planned (Day 26) |
| AI copilot chat | organizers | dashboard | Planned (Day 27) |

Only rows marked **Done** exist in the code. Everything else describes the design and is filled in as it is built.

## Tech

- **Next.js 16** with the App Router and Turbopack, **React 19**, **TypeScript** (strict).
- **Tailwind CSS 4** through PostCSS (`postcss.config.mjs`, `src/app/globals.css`).
- Forms will use the same Zod schemas as the API, imported from `packages/shared`.

## Folder layout (today)

```
apps/web/
  src/app/
    layout.tsx     Root layout: <html>, metadata, global styles
    page.tsx       Placeholder home page
    globals.css    Tailwind entry point
  next.config.ts
  postcss.config.mjs
  tsconfig.json    Extends the root config, switches to bundler module resolution for Next.js
```

Planned route groups: `(public)` for event pages, `(auth)` for login and register, `(dashboard)` for organizer and sponsor screens, plus `/scan` for the scanner.

## How the frontend talks to the backend

_Planned (Day 7). Described here so the design is clear before it lands._

- All calls go to the REST API under `/api/v1` through one typed API client.
- **Access token:** a short-lived JWT kept **in memory only**, never in `localStorage`, so a cross-site scripting bug can't steal it from storage.
- **Refresh token:** an `httpOnly` cookie the JavaScript can't read. On page load and on any 401, the client calls `/auth/refresh` once, then retries the original request.
- **Errors** come back in one shape, `{ "error": { "code", "message", "details", "requestId" } }`, which the client turns into typed errors. Field errors appear next to the matching form field.

## Rendering strategy

_Planned (Day 10)._

| Page | Rendering | Why |
|---|---|---|
| Event list and event pages | Server-rendered, cached with ISR (60 s), revalidated on demand when an organizer edits | Fast first load and good SEO; the page can be slightly stale because booking always rechecks availability on the server |
| Dashboards, checkout, tickets | Client-rendered behind login | Personal data, no SEO value |
| Scanner | Client-only PWA with a service worker | Must work when the venue's network drops |

## The scanner app

_Planned (Day 20)._

- Runs on a volunteer's phone as a PWA and reads QR codes with the camera.
- **Online:** sends each scan to the check-in API, which decides entry.
- **Offline:** checks the QR signature locally with the public key, rejects tickets already scanned on that phone (IndexedDB), queues the scan and syncs it later.
- **What offline mode can't guarantee:** two phones that are both offline can each accept the same ticket. After sync, the server keeps the first scan and flags the other as a conflict.

## Conventions

- Money arrives from the API in integer paise and is converted to rupees only for display.
- Times arrive in UTC and are formatted in the browser.
- No validation rules are written twice: forms import the shared Zod schemas.
- The UI hides buttons a user can't use, but the API is always the security boundary.

## Running it

From the repo root (see the [project README](../../README.md#getting-started) for full setup):

```bash
pnpm dev                               # web on http://localhost:3000 (plus API and worker)
pnpm --filter @festpass/web dev        # only the web app
pnpm --filter @festpass/web build      # production build
pnpm --filter @festpass/web typecheck  # generates route types, then runs tsc
```

## Environment variables

None yet. Browser-visible variables (for example the API URL and the ticket public key) will use the `NEXT_PUBLIC_` prefix and be listed here and in `.env.example`.

## Change history

- **Day 1:** Next.js app with Tailwind and a placeholder home page on port 3000.
