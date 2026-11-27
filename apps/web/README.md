# FestPass frontend (`apps/web`)

The Next.js app every FestPass user touches: attendees browsing and buying tickets, organizers running events, volunteers scanning passes at the gate, and sponsors checking their booth numbers.

Back to the [project README](../../README.md) · See also the [backend README](../api/README.md)

## Status

| Area | Who uses it | Route(s) | Status |
|---|---|---|---|
| Design tokens, base components, auth screens | everyone | `/login`, `/register` | Done (Day 7) |
| Protected dashboard shell: org switcher, create club | organizers | `/dashboard`, `/dashboard/orgs/new` | Done (Day 7) |
| Organizer dashboard: events list, event editor, tier editor, publish/close, members | organizers | `/dashboard`, `/dashboard/events/new`, `/dashboard/orgs/[orgId]/events/[eventId]`, `/dashboard/members` | Done (Day 9) |
| Banner uploads straight to storage, with preview and progress | organizers | inside the event editor | Done (Day 9; API Day 8) |
| Public event list and event pages (SSR + ISR, on-demand revalidation) | attendees | `/`, `/e/[slug]` | Done (Day 10); Book button wired up on Days 11 and 15 |
| Booking and checkout with a hold countdown and Razorpay (test mode) | attendees | `/book/[slug]`, `/checkout/[orderId]` | Done (Day 15); payment confirmation by webhook on Day 16 |
| My Tickets with QR codes and PDF download | attendees | `/tickets` | Done (Day 18) |
| Scanner PWA with offline mode | volunteers | `/scan` | Done (Day 20) |
| Live availability and check-in counter | attendees, organizers | event page, dashboard | Done (Day 21) |
| Virtual waiting room | attendees | `/queue/[slug]` | Done (Day 22) |
| Analytics charts | owners, managers | `/dashboard/orgs/[orgId]/events/[eventId]` | Done (Day 25) |
| Sponsor dashboard and booth-mode scanning | sponsors, volunteers | `/sponsor`, `/scan` | Planned (Day 26) |
| AI copilot chat | organizers | dashboard | Planned (Day 27) |

Only rows marked **Done** exist in the code. Everything else describes the design and is filled in as it is built.

## Tech

- **Next.js 16** with the App Router and Turbopack, **React 19**, **TypeScript** (strict).
- **Tailwind CSS 4** through PostCSS (`postcss.config.mjs`, `src/app/globals.css`).
- **Forms:** react-hook-form, validated by the same Zod schemas the API runs (`registerSchema`, `loginSchema`, `createOrgSchema`, `addMemberSchema`, `createEventSchema`, `createTierSchema` from `packages/shared`). Simple forms use `@hookform/resolvers/zod`; forms whose inputs differ from the API's shape (local dates, rupees) use `sharedSchemaResolver` (below). No validation rule is written in the web app.
- **Tests:** Vitest for plain TypeScript modules (`src/lib/api.test.ts`, `src/lib/form-helpers.test.ts`).

## Folder layout (today)

```
apps/web/
  src/app/
    layout.tsx                      Root layout: <html>, metadata (title template "%s · FestPass"), global styles
    providers.tsx                   AuthProvider + ToastProvider (client), used only by (app)
    globals.css                     Tailwind entry point and design tokens (@theme)
    (public)/layout.tsx             Header and footer; no client providers
    (public)/page.tsx               `/`: upcoming events (Server Component, ISR 60 s)
    (public)/loading.tsx, error.tsx Skeleton while rendering; message if the API is down and nothing is cached
    (public)/e/[slug]/page.tsx      `/e/[slug]`: event page, generateMetadata (Open Graph banner), tier cards
    (public)/e/[slug]/loading.tsx, not-found.tsx  Skeleton; 404 for unknown slugs and drafts
    api/revalidate/route.ts         POST, called by the API: checks the secret, revalidates /e/{slug} and /
    api/revalidate/route.test.ts    401 for a wrong or missing secret, 400 for a bad slug, revalidation otherwise
    (app)/(buyer)/layout.tsx        Login guard for booking and checkout (sends logged-out visitors to /login?next=...)
    (app)/(buyer)/book/[slug]/page.tsx       Choose a quantity of one tier and hold it (POST /events/:id/orders with an Idempotency-Key)
    (app)/(buyer)/tickets/page.tsx  My Tickets: QR codes drawn in the browser (qrcode), grouped by order, Download PDF
    (app)/scan/layout.tsx, page.tsx  `/scan`: manifest link and theme colour; opens the saved gate or asks for one
    (app)/(buyer)/checkout/[orderId]/page.tsx  Summary, countdown, Razorpay Checkout, "Confirming payment…" polling, expiry
    (app)/layout.tsx                Wraps login, register and the dashboard in <Providers>
    (app)/(auth)/layout.tsx         Centered card layout
    (app)/(auth)/login/page.tsx     Login form
    (app)/(auth)/register/page.tsx  Register form
    (app)/(buyer)/queue/[slug]/page.tsx            Waiting room: place in line, estimated wait, moves on to booking automatically
    (app)/(dashboard)/dashboard/layout.tsx         Login guard, header, org switcher, Events | Members tabs, log out
    (app)/(dashboard)/dashboard/page.tsx           The club's events (status, sold / capacity, load more) or "create your first club"
    (app)/(dashboard)/dashboard/events/new/page.tsx            New event form (creates a draft)
    (app)/(dashboard)/dashboard/orgs/[orgId]/events/[eventId]/page.tsx  Event editor: banner, tiers, details, publish/close
    (app)/(dashboard)/dashboard/members/page.tsx   Add by email with a role, change roles, remove
    (app)/(dashboard)/dashboard/orgs/new/page.tsx  Create-club form
    (app)/(dashboard)/dashboard/queues/page.tsx    For admins: gets the API's admin cookie, then opens Bull Board (/admin/queues on the API)
  src/components/ui/                Button, Input/Textarea/Select/Checkbox, Card, Badge, Toast, EmptyState, ConfirmDialog
  src/components/events/event-analytics.tsx  Four Recharts charts (tickets per day, tier fill, entries at the gate, who came in), stat tiles, table views
  src/components/events/live-tiers.tsx, live-checkins.tsx  Tier cards that update live; the organizer's counter and scan feed
  src/components/scan/              GateSetup, GateView (result panel, queue count, Needs a look list), Camera
  public/                           manifest.webmanifest, sw.js (the scanner's service worker), icons/
  src/components/events/            EventForm, TierEditor, BannerUploader, EventActions (publish/close), StatusBadge
  src/lib/
    api.ts                          API client: in-memory token, refresh-once-and-retry, ApiError
    api.test.ts                     Client unit tests (fake fetch)
    auth.tsx                        AuthProvider / useAuth: silent refresh on load
    orgs.tsx                        OrgsProvider / useOrgs: my clubs and the selected one
    form-errors.ts                  Puts API errors on the right form fields; errorMessage() for dialogs and toasts
    form-resolver.ts                sharedSchemaResolver: convert form values, validate with a shared schema
    dates.ts                        datetime-local <-> UTC ISO, date formatting
    upload.ts                       Banner upload: presign, XHR POST to storage with progress, PATCH bannerKey
    waiting-room.ts                 formatWait(), pollDelayMs() (tested in waiting-room.test.ts)
    use-event-socket.ts             useEventSocket(): joins an event's room, rejoins after a reconnect, refreshes an expired token
    use-api-data.ts                 useApiData(path): load, reload and replace one API resource
    booking.ts (+ .test.ts)         bookingKey(): one Idempotency-Key per booking attempt, kept in sessionStorage for retries
    razorpay.ts                     Loads checkout.js once and opens Razorpay Checkout
    next-path.ts (+ .test.ts)       safeNextPath(): where to go after login, same-site paths only
    form-helpers.test.ts            Resolver and date conversion tests
    public-api.ts                   Server-side reads for public pages, cached with `next: { revalidate: 60 }`
    scan/offline.ts, store.ts, use-gate.ts, register-worker.ts  The scanner: offline rules and sync, IndexedDB, gate state, service worker
    tier-state.ts (+ .test.ts)      On sale / opens at / ended / sold out / closed, for a tier at a given time
  next.config.ts                    Loads the root .env, transpiles @festpass/shared
  tsconfig.json                     Extends the root config, switches to bundler module resolution
```

Route groups (folders in parentheses) organise pages without appearing in URLs: `(public)` for pages anyone sees, and `(app)` for everything that needs the auth client: `(auth)` for login and register and `(dashboard)` for screens behind login. Keeping public pages out of `(app)` means they ship no auth code and never call `/auth/refresh`. `/scan` comes later.

**Design tokens** live in `src/app/globals.css` under `@theme`: brand colours (`brand-50` to `brand-700`), text and surface colours (`ink`, `muted`, `line`, `canvas`, `surface`, `danger`, `success`, `warning`), radii (`rounded-control`, `rounded-card`) and the font stack. Components use only these, so a colour change is one line.

## How the frontend talks to the backend

- **One client** (`src/lib/api.ts`): every call goes through `api.request(path, { method, body })` against `NEXT_PUBLIC_API_URL`, with `credentials: 'include'` so the browser sends the refresh cookie to the API's origin. The API allows exactly this origin with credentials (`WEB_ORIGINS`, CORS).
- **Access token:** kept in a variable inside the client, **in memory only**, never in `localStorage` or `sessionStorage`. Any script on the page can read storage, so one XSS bug or a malicious dependency could steal a stored token, and it would outlive the tab; memory dies with the tab.
- **Refresh token:** the API's `httpOnly` `fp_refresh` cookie (`SameSite=Lax`, path `/api/v1/auth`). Page scripts can't read it; the browser attaches it to `/auth/refresh`.
- **Silent refresh on load:** `AuthProvider` (`src/lib/auth.tsx`) starts in `loading`, calls `api.refresh()` once on mount and becomes `authenticated` (new access token in memory) or `anonymous`. The dashboard layout waits for that answer before redirecting, so a hard reload never flashes the login page.
- **Expired token:** on a 401 the client calls `/auth/refresh` once and retries the request once. If the refresh fails or the retry is still 401, it gives up with the error, so it can't loop. Concurrent 401s share one refresh request, because the API treats a second use of the same refresh token as theft.
- **Errors** come back in one shape and become an `ApiError` with `status`, `code`, `details` and `requestId`. `showApiError()` puts `VALIDATION_FAILED` fields on their inputs, maps codes like `EMAIL_TAKEN` or `SLUG_TAKEN` to a field, and shows anything else above the form.
- **Server validation errors:** the API reports every invalid field as `{ path, message }`. `showApiError()` calls react-hook-form's `setError` for each, so the message appears under the same input a client-side error would, linked with `aria-describedby`. Rules only the server can check (a tier's sale window against the stored event, a duplicate tier name, `PRICE_LOCKED`) land on their field the same way. Errors from actions without a form (publish, close, remove) are shown inside the confirmation dialog, which stays open.
- **Protection:** the dashboard layout only decides what to render. The API rejects every request without a valid token and checks org permissions on the server.

## Booking and checkout (Day 15)

- **Book** on a public event page is a plain link to `/book/[slug]?tier=...`, so the public page stays server-rendered with no auth code. Booking pages sit in the `(buyer)` group, whose layout sends logged-out visitors to `/login?next=<this page>`; login and register return there (`safeNextPath()` accepts only same-site paths, so `?next=` can't become an open redirect).
- **Holding tickets:** the booking page posts the order with `Idempotency-Key: bookingKey(slug, tier, qty)`. The key is generated once per attempt with `crypto.randomUUID()` and kept in `sessionStorage`, so a double click, a timeout, a "Try again" or a reload sends the same key and gets the same order back. Another tier or quantity is another attempt with another key; "Book again" after a hold ends forgets the keys for that event.
- **Checkout** shows the items, total and a countdown to `expiresAt` (ticking every second). **Pay** asks the API for the Razorpay order (`POST /orders/:id/pay`), loads Razorpay's `checkout.js` once and opens Checkout; card or UPI details go to Razorpay, never to FestPass.
- **After paying:** the success callback is only a hint. The page shows "Confirming payment…" and polls `GET /orders/:id` every 2 s until the order is `PAID`/`TICKETED` (moved there only by the webhook, Day 16) or ended; after 3 minutes it says confirmation is taking longer.
- **When the countdown reaches zero** (or the order is `EXPIRED`), Pay disappears and "Book again" links back to the event.

## My Tickets (Day 18)

- `/tickets` (logged in) lists `GET /me/tickets`, grouped by order. The API sends each QR as its signed `FP1.…` text; the page draws it with `qrcode` (`toDataURL`), so the same string makes the same code in the email, the PDF and here.
- **Download PDF** asks `GET /orders/:id/tickets-pdf` for a new 5-minute pre-signed link on every click and navigates to it; the PDF itself is private in storage. Until the worker has built it, the API answers `PDF_NOT_READY` and the page says so.
- The header of booking pages links to My tickets, and checkout links there once the order is `TICKETED`.

## Organizer dashboard

- **Events list** (`/dashboard`): the selected club's events from `GET /orgs/:orgId/events`, with a status badge and sold / capacity summed over the tiers by the API. "Load more" follows `nextCursor`. The list component is keyed by club, so switching clubs never shows the previous club's events.
- **Event editor** (`/dashboard/orgs/[orgId]/events/[eventId]`): the org is in the URL, not only in the switcher, so a link works for any teammate and survives a reload. Banner, tiers and details are separate cards; each saves on its own and replaces the page's copy of the event with the server's response. A closed event (or a SCANNER) sees everything read-only.
- **Forms with converted inputs:** people type local times and rupees; the API takes ISO times with an offset and integer paise. `sharedSchemaResolver(schema, toApi, formField)` converts the form values with `toApi` (`fromLocalInput`, `rupeesToPaise` from `packages/shared`), validates them with the shared schema, and moves errors from the API's name to the input (`pricePaise` -> `price`). The submit handler receives exactly what the API accepts. The event form validates with `createEventSchema` for both create and edit, so the date rules run on the whole event.
- **Money:** prices are typed as rupees ("99.99"), converted with `rupeesToPaise` (string parsing, never `* 100` on a float), shown with `formatPaise` ("₹1,23,456.00"), and edited with `paiseToRupees`. A price with more than 2 decimals is rejected, not rounded.
- **Banner uploader:** checks type and size first (fast feedback; storage enforces both anyway), shows the chosen image immediately from an object URL, uploads with `XMLHttpRequest` (fetch has no upload progress) and shows a progress bar, then "Checking the file…" while the API runs HeadObject. Storage errors are read from S3's XML.
- **Publish and close** use `ConfirmDialog`, built on the native `<dialog>` (`showModal()` traps focus and handles Escape). If the API refuses (`NO_TIERS`, `EVENT_IN_PAST`), its message is shown in the dialog.
- **Members** (`/dashboard/members`): add by email with a role (`addMemberSchema`; an unknown email shows the API's message under the field), change roles inline, remove with confirmation. Demoting the last owner shows the API's `LAST_OWNER` message and the select goes back. Controls are hidden without `member:manage` (from the shared permission matrix), but the API checks every call.

## Live updates (Day 21)

- **The hook** (`src/lib/use-event-socket.ts`): `useEventSocket({ eventId, room, session, onAvailability, onScan, onJoined })` returns `connecting`, `live`, `reconnecting` or `denied`. It uses WebSocket only and loads `socket.io-client` on demand, so the event page's first paint doesn't pay for it. Rooms belong to a connection, so it joins again on every connect.
- **Staying signed in:** the staff room passes a `session` with the current token and a refresh function. Socket.IO doesn't retry after the server refuses a token or ends a connection whose token expired, so the hook refreshes the token and connects again. If the refresh fails, the status is `denied`. Public pages pass no session, so they never load the auth client.
- **Event page** (`components/events/live-tiers.tsx`): a client component that starts from the server-rendered tiers and overlays live numbers, so without JavaScript or a connection the page still works. Joining sends the current numbers at once, which replaces a cached page's up-to-a-minute-old ones. The note under the tiers says whether the numbers are live.
- **Organizer dashboard** (`components/events/live-checkins.tsx`): loads `GET /events/:id/checkins/summary`, then raises the counter on each `ACCEPTED` scan and adds each scan to the feed. It loads the summary again after a reconnect, because scans sent while disconnected never arrive.

## Waiting room (Day 22)

- **Getting there:** tier cards still link to `/book/[slug]`. That page reads the event from the API; if `queueMode` is on and the user isn't admitted, it sends them to `/queue/[slug]?tier=...`. So a stale cached event page can't skip the line.
- **The page** (`app/(app)/(buyer)/queue/[slug]/page.tsx`) asks `GET /queue/status` and calls `POST /queue/join` only if the user isn't in line yet, so reloading doesn't use up the join rate limit. Nothing is kept in the browser: position and token live on the server, which is why a reload or a second tab shows the same place. The wait shown comes from the API (position ÷ admit rate).
- **Moving on:** `useEventSocket` gained `onQueueAdmitted`, which triggers a status check at once. `pollDelayMs()` also checks every 2 to 30 seconds depending on the wait, with up to 20% random spread, in case the message is missed or the organizer turned queue mode off. A sale that ended or an event that closed stops the checks and shows the reason; a busy or unreachable API keeps the last position and tries again.
- **Booking:** the book page fetches the token from `GET /queue/status`, shows the time to book by, and sends it as `X-Admission-Token`. A `403 ADMISSION_REQUIRED` (token expired, or queue mode just turned on) goes back to the waiting page.
- **Organizer controls:** the event form's existing "Waiting room for the sale" checkbox and "People admitted per second" field, which take effect within a second.

## Analytics (Day 25)

- **Where:** on the organizer's event page, under the live check-ins, for roles with `analytics:read` and events that aren't drafts (`components/events/event-analytics.tsx`).
- **Data:** `GET .../analytics/sales` and `/analytics/checkins` for both bucket sizes. Both are loaded, so switching between 5 and 15 minutes never blanks the chart while it waits for the API.
- **Charts (Recharts 3):** each card holds one series in `brand-600`, which passes the dataviz palette checks on the white surface, with no legend because the title says what is plotted.
  - Columns for tickets per day and for entries per bucket.
  - Horizontal bars on a `brand-100` track for tier fill, labelled with the percentage.
  - Horizontal bars for who came in, with a selector for college, branch, year or tier.
- **Details:** bars are capped at 24 px with 4 px rounded ends and hairline gridlines, and animation is off. Tooltips put the value first. Each card has a "Show as a table" view, so no number needs a mouse. When the entries span more than one day, the time axis adds the date.

## Rendering strategy

| Page | Rendering | Why |
|---|---|---|
| `/` and `/e/[slug]` (Day 10) | Server Components that fetch from the API, cached with ISR (`export const revalidate = 60`), revalidated on demand when an organizer changes a published event | Fast first load, full HTML for search engines and link previews; availability can be up to a minute old because booking rechecks it on the server |
| Dashboards (Days 7–9), checkout, tickets | Client-rendered behind login | Personal data, no SEO value, must always be current |
| Scanner (Day 20) | Client-only PWA with a service worker | Must work when the venue's network drops |

**How the public pages are cached (Day 10):**
- `/e/[slug]` has `generateStaticParams()` returning `[]`: nothing is built at deploy time, each event page is rendered on its first visit and then served from the cache (`x-nextjs-cache: HIT`). A new event never waits for a deploy, and `next build` doesn't need the API.
- `/` is prerendered at build. If the API isn't reachable during `next build` (CI), `listUpcomingEvents()` builds an empty list instead of failing, and the next refresh fills it in.
- After 60 s the next visitor still gets the cached page instantly while Next renders a fresh one in the background. If that render fails, the last good page keeps being served.
- **On demand:** when a published or closed event, its tiers or its banner change, the API POSTs `{ slug }` to `/api/revalidate` with `Authorization: Bearer <REVALIDATE_SECRET>`. The route compares the secret in constant time, validates the slug with the shared `revalidateEventSchema`, and calls `revalidatePath` for `/e/{slug}` and `/`. The next request renders fresh HTML. Measured locally against `next start`: an edit saved in the dashboard was on the public page at the first check after "Changes saved" (27 ms later).
- **404s:** the API answers 404 for unknown slugs and drafts, and the page calls `notFound()`. Publishing revalidates the path, so a 404 cached while the event was a draft is replaced.
- **Metadata:** `generateMetadata` sets the title, a 160-character description and Open Graph / Twitter tags with the banner, so shared links show a preview. The page and `generateMetadata` make the same `fetch`, which Next de-duplicates into one API call.
- **Times** on these pages are formatted on the server in `Asia/Kolkata` with "IST" shown, because the server's own time zone says nothing about the reader. Dashboards format in the browser's time zone.
- **Images:** banners go through `next/image` (resized, modern formats, `preload` for the hero). `remotePatterns` allows only the storage bucket from `S3_PUBLIC_URL`; `dangerouslyAllowLocalIP` is on only when that bucket is on localhost.
- **Book button:** shown with the tier's state (on sale, opens at, ended, sold out, closed) but not wired up yet: booking arrives on Day 11 and checkout on Day 15.

## The scanner app

Usage is in the [project README](../../README.md#scanner-app). How it works:

- **Page** (`src/app/(app)/scan/page.tsx`): a saved gate opens straight away, whatever the auth state, because with no network the session can't be refreshed. Choosing a gate is what needs a login (`components/scan/gate-setup.tsx`). `api.onSessionChange` now reports whether "no session" means logged out or just unreachable, and `useAuth()` carries that as `unreachable`.
- **Gate logic** (`src/lib/scan/use-gate.ts`): a scan is checked against this phone's history first, because a queued scan is something the server hasn't heard about. Then, if the API is reachable, `POST /checkins` with a 4-second limit; no answer falls back to the offline path with the same `clientScanId`. An accepted scan is also recorded locally, so the phone still refuses it if the network dies a minute later. A timer syncs every 30 s (on reconnect too) and re-downloads the ticket list every 5 minutes.
- **Offline rules** (`src/lib/scan/offline.ts`): `scanOffline()` and `syncQueue()`, free of React and IndexedDB behind a small `ScanStore` interface, so they are tested with plain objects. `src/lib/scan/store.ts` is the IndexedDB implementation (`idb`, database `festpass-scanner`): manifests, scans, and settings (saved gate, device ID).
- **Camera** (`components/scan/camera.tsx`): `BrowserQRCodeReader` from `@zxing/browser`, using the rear camera. The same code counts again only after being out of frame for 3 s. If the camera isn't available, a message and the paste field take over. The result panel always says its answer in words as well as colour, and clears after 5 s, so a green panel can't be mistaken for the next person's.
- **Service worker** (`public/sw.js`, hand-written, registered in `src/lib/scan/register-worker.ts`, production builds only): scope `/scan`. Pages are network-first with the cached `/scan` as fallback; `/_next/static/*`, the manifest and icons are cache-first. It never touches API calls. The first visit loads before the worker is in control, so the page sends the worker the URLs it already loaded.
- **What offline mode can't guarantee:** two offline phones can each accept the same ticket, and nothing that changed after the last ticket list download is known. After sync, the first scan to reach the server wins and the other phone lists its scan under "Needs a look". The screen says this too.

## Conventions

- Money arrives from the API in integer paise and is converted to rupees only for display.
- Times arrive in UTC and are formatted in the browser.
- No validation rules are written twice: forms import the shared Zod schemas.
- Inputs have real `<label>`s, errors are linked with `aria-describedby`, and toasts are announced through an `aria-live` region.
- The UI hides buttons a user can't use, but the API is always the security boundary.

## Running it

From the repo root (see the [project README](../../README.md#getting-started) for full setup):

```bash
pnpm dev                               # web on http://localhost:3000 (plus API and worker)
pnpm --filter @festpass/web dev        # only the web app
pnpm --filter @festpass/web build      # production build
pnpm --filter @festpass/web typecheck  # generates route types, then runs tsc
pnpm --filter @festpass/web test       # API client, resolver, date, tier-state and revalidate-route tests
pnpm build && pnpm --filter @festpass/web start   # production server: the only mode where ISR caching happens
```

## Environment variables

Read from the root `.env` (loaded in `next.config.ts`).

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_API_URL` | Base URL of the API, e.g. `http://localhost:4000/api/v1` (the default). Used by the browser and by Server Components. `NEXT_PUBLIC_` values are inlined into the browser bundle at build time, so they must never be secrets |
| `REVALIDATE_SECRET` | Shared with the API; `/api/revalidate` only accepts `Authorization: Bearer <this>`. At least 32 characters. Server-only |
| `S3_PUBLIC_URL` | Where banners are served from; becomes the only `next/image` remote pattern |
| `NEXT_PUBLIC_TICKET_PUBLIC_KEY` | Verifies ticket signatures in the scanner when offline. From `pnpm keys:generate`. Public by design: it can only verify, and the private key never reaches this app |

`next.config.ts` validates these with Zod whenever `next dev`, `next build` or `next start` loads it, and stops with a list of problems if any is missing or malformed.

The API must list the web app's origin in `WEB_ORIGINS` for CORS.

## Change history

- **Day 1:** Next.js app with Tailwind and a placeholder home page on port 3000.
- **Day 7:** route groups, design tokens and base components, API client with in-memory token and refresh-once retry, AuthProvider with silent refresh, register and login with shared Zod schemas, protected dashboard with org switcher and create-club flow.
- **Day 9:** organizer dashboard: events list with status and sold / capacity, create and edit event (dates, sale window, waiting-room toggle and admit rate), tier editor in rupees with paise sent to the API, banner uploader with preview and progress, publish and close behind confirmation dialogs, members page; `sharedSchemaResolver`, Textarea/Select/Checkbox/ConfirmDialog components, `warning` colour token; resolver and date tests.
- **Day 10:** public pages: `/` and `/e/[slug]` as Server Components with ISR (60 s) and on-demand revalidation through a secret-protected `POST /api/revalidate`; `generateMetadata` with Open Graph banner; tier cards with sale state; loading, error and not-found states; `next/image` for banners; env validation in `next.config.ts`; auth and dashboard moved under an `(app)` group so public pages don't load the auth client.
- **Day 13:** `/dashboard/queues` opens the job dashboard: it trades the in-memory login for the API's 15-minute admin cookie (only for `ADMIN_EMAILS`) and navigates to Bull Board on the API.
- **Day 15:** booking and checkout: **Book** link on public pages, `(buyer)` route group with a login guard and `?next=` return, `/book/[slug]` with a per-attempt Idempotency-Key in `sessionStorage`, `/checkout/[orderId]` with countdown, Razorpay Checkout (test mode) and confirmation polling; the API client can send extra headers.
- **Day 18:** My Tickets page (`/tickets`) with browser-drawn QR codes and a Download PDF button that fetches a fresh pre-signed link; links to it from checkout and the booking header.
- **Day 20:** scanner PWA at `/scan`: gate setup, camera scanning with `@zxing/browser` and a paste fallback, online check-in with an offline fallback (signature, event, version and on-this-phone checks; IndexedDB queue via `idb`), ticket list download, sync with a "Needs a look" list, web app manifest and hand-written service worker; the API client tells "unreachable" from "logged out"; Scanner link in the dashboard.
- **Day 25:** analytics on the organizer's event page: four Recharts charts with stat tiles and table views, for owners and managers.
- **Day 22:** waiting room at `/queue/[slug]`: place in line, estimated wait, automatic redirect and a place that survives a reload; the book page sends the admission token and redirects when it has none; `onQueueAdmitted` on `useEventSocket`.
- **Day 21:** live updates: `useEventSocket`, tier cards on `/e/[slug]` that update live (moved into the `LiveTiers` client component), a check-in counter and scan feed on the organizer's event page, `api.accessToken()` for the WebSocket handshake.
