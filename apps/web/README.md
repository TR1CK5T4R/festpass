# FestPass frontend (`apps/web`)

The Next.js app every FestPass user touches: attendees browsing and buying tickets, organizers running events, volunteers scanning passes at the gate, and sponsors checking their booth numbers.

Back to the [project README](../../README.md) · See also the [backend README](../api/README.md)

## Status

| Area | Who uses it | Route(s) | Status |
|---|---|---|---|
| Home page | everyone | `/` | Done (Day 1, links added Day 7) |
| Design tokens, base components, auth screens | everyone | `/login`, `/register` | Done (Day 7) |
| Protected dashboard shell: org switcher, create club | organizers | `/dashboard`, `/dashboard/orgs/new` | Done (Day 7) |
| Organizer dashboard: events list, event editor, tier editor, publish/close, members | organizers | `/dashboard`, `/dashboard/events/new`, `/dashboard/orgs/[orgId]/events/[eventId]`, `/dashboard/members` | Done (Day 9) |
| Banner uploads straight to storage, with preview and progress | organizers | inside the event editor | Done (Day 9; API Day 8) |
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
- **Forms:** react-hook-form, validated by the same Zod schemas the API runs (`registerSchema`, `loginSchema`, `createOrgSchema`, `addMemberSchema`, `createEventSchema`, `createTierSchema` from `packages/shared`). Simple forms use `@hookform/resolvers/zod`; forms whose inputs differ from the API's shape (local dates, rupees) use `sharedSchemaResolver` (below). No validation rule is written in the web app.
- **Tests:** Vitest for plain TypeScript modules (`src/lib/api.test.ts`, `src/lib/form-helpers.test.ts`).

## Folder layout (today)

```
apps/web/
  src/app/
    layout.tsx                      Root layout: <html>, metadata, global styles, <Providers>
    providers.tsx                   AuthProvider + ToastProvider (client)
    globals.css                     Tailwind entry point and design tokens (@theme)
    (public)/page.tsx               Home page
    (auth)/layout.tsx               Centered card layout
    (auth)/login/page.tsx           Login form
    (auth)/register/page.tsx        Register form
    (dashboard)/dashboard/layout.tsx         Login guard, header, org switcher, Events | Members tabs, log out
    (dashboard)/dashboard/page.tsx           The club's events (status, sold / capacity, load more) or "create your first club"
    (dashboard)/dashboard/events/new/page.tsx            New event form (creates a draft)
    (dashboard)/dashboard/orgs/[orgId]/events/[eventId]/page.tsx  Event editor: banner, tiers, details, publish/close
    (dashboard)/dashboard/members/page.tsx   Add by email with a role, change roles, remove
    (dashboard)/dashboard/orgs/new/page.tsx  Create-club form
  src/components/ui/                Button, Input/Textarea/Select/Checkbox, Card, Badge, Toast, EmptyState, ConfirmDialog
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
    use-api-data.ts                 useApiData(path): load, reload and replace one API resource
    form-helpers.test.ts            Resolver and date conversion tests
  next.config.ts                    Loads the root .env, transpiles @festpass/shared
  tsconfig.json                     Extends the root config, switches to bundler module resolution
```

Route groups (folders in parentheses) organise pages without appearing in URLs: `(public)` for pages anyone sees, `(auth)` for login and register, `(dashboard)` for screens behind login. `/scan` comes later.

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

## Organizer dashboard

- **Events list** (`/dashboard`): the selected club's events from `GET /orgs/:orgId/events`, with a status badge and sold / capacity summed over the tiers by the API. "Load more" follows `nextCursor`. The list component is keyed by club, so switching clubs never shows the previous club's events.
- **Event editor** (`/dashboard/orgs/[orgId]/events/[eventId]`): the org is in the URL, not only in the switcher, so a link works for any teammate and survives a reload. Banner, tiers and details are separate cards; each saves on its own and replaces the page's copy of the event with the server's response. A closed event (or a SCANNER) sees everything read-only.
- **Forms with converted inputs:** people type local times and rupees; the API takes ISO times with an offset and integer paise. `sharedSchemaResolver(schema, toApi, formField)` converts the form values with `toApi` (`fromLocalInput`, `rupeesToPaise` from `packages/shared`), validates them with the shared schema, and moves errors from the API's name to the input (`pricePaise` -> `price`). The submit handler receives exactly what the API accepts. The event form validates with `createEventSchema` for both create and edit, so the date rules run on the whole event.
- **Money:** prices are typed as rupees ("99.99"), converted with `rupeesToPaise` (string parsing, never `* 100` on a float), shown with `formatPaise` ("₹1,23,456.00"), and edited with `paiseToRupees`. A price with more than 2 decimals is rejected, not rounded.
- **Banner uploader:** checks type and size first (fast feedback; storage enforces both anyway), shows the chosen image immediately from an object URL, uploads with `XMLHttpRequest` (fetch has no upload progress) and shows a progress bar, then "Checking the file…" while the API runs HeadObject. Storage errors are read from S3's XML.
- **Publish and close** use `ConfirmDialog`, built on the native `<dialog>` (`showModal()` traps focus and handles Escape). If the API refuses (`NO_TIERS`, `EVENT_IN_PAST`), its message is shown in the dialog.
- **Members** (`/dashboard/members`): add by email with a role (`addMemberSchema`; an unknown email shows the API's message under the field), change roles inline, remove with confirmation. Demoting the last owner shows the API's `LAST_OWNER` message and the select goes back. Controls are hidden without `member:manage` (from the shared permission matrix), but the API checks every call.

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
- Inputs have real `<label>`s, errors are linked with `aria-describedby`, and toasts are announced through an `aria-live` region.
- The UI hides buttons a user can't use, but the API is always the security boundary.

## Running it

From the repo root (see the [project README](../../README.md#getting-started) for full setup):

```bash
pnpm dev                               # web on http://localhost:3000 (plus API and worker)
pnpm --filter @festpass/web dev        # only the web app
pnpm --filter @festpass/web build      # production build
pnpm --filter @festpass/web typecheck  # generates route types, then runs tsc
pnpm --filter @festpass/web test       # API client, resolver and date tests
```

## Environment variables

Read from the root `.env` (loaded in `next.config.ts`).

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_API_URL` | Base URL of the API, e.g. `http://localhost:4000/api/v1` (the default). `NEXT_PUBLIC_` values are inlined into the browser bundle at build time, so they must never be secrets |

The API must list the web app's origin in `WEB_ORIGINS` for CORS.

## Change history

- **Day 1:** Next.js app with Tailwind and a placeholder home page on port 3000.
- **Day 7:** route groups, design tokens and base components, API client with in-memory token and refresh-once retry, AuthProvider with silent refresh, register and login with shared Zod schemas, protected dashboard with org switcher and create-club flow.
- **Day 9:** organizer dashboard: events list with status and sold / capacity, create and edit event (dates, sale window, waiting-room toggle and admit rate), tier editor in rupees with paise sent to the API, banner uploader with preview and progress, publish and close behind confirmation dialogs, members page; `sharedSchemaResolver`, Textarea/Select/Checkbox/ConfirmDialog components, `warning` colour token; resolver and date tests.
