# FestPass

> Flash-sale-safe ticketing and entry for college fests. Built to stay correct when thousands of students hit "Book" at the same second.

<!-- CI badge goes here on Day 28 -->

**Status:** in development. See the [30-day progress](#30-day-progress) tracker and the [build log](#build-log).

![Organizer dashboard: a club's events with status and sold / capacity](.github/screenshots/organizer-events.png)

<details>
<summary>More screenshots: public event page, event editor, team</summary>

![Public event page: server-rendered with the banner, times in IST and ticket tiers](.github/screenshots/public-event.png)

![Event editor: banner, ticket tiers in rupees, details with the waiting-room setting](.github/screenshots/organizer-event.png)

![Team page: add a member by email, change roles, remove](.github/screenshots/organizer-members.png)

</details>

**Deeper docs:** [Frontend README](apps/web/README.md) · [Backend README](apps/api/README.md)

## Why I built this

As Sponsorship Coordinator at MAIT's Alumni Cell, I watched fest registrations run on Google Forms and spreadsheets: duplicate entries, passes shared as screenshots, and no way to show sponsors what their money got them. FestPass is the system I wish we'd had.

## Features

| Feature | Status |
|---|---|
| Accounts, clubs (organizations) and roles | Done: API (Days 4–5); register, login and create-club screens (Day 7); members page (Day 9) |
| Web app: auth screens, silent refresh, organizer dashboard | Done (Days 7, 9) |
| Events and ticket tiers, SEO-friendly public pages | API (Day 6) and organizer UI (Day 9) done: create, edit, tiers in rupees, publish and close; public pages with ISR and on-demand revalidation (Day 10) |
| Event banners uploaded straight from the browser to S3-compatible storage | Done: API and storage (Day 8), uploader with preview and progress (Day 9) |
| Oversell-proof booking engine (Postgres + Redis gate) | Done (API): Postgres booking with idempotent retries (Day 11), Redis gate with compensation, fallback and reconciliation (Day 12) |
| Automatic hold expiry and rate limiting | Planned (Days 13–14) |
| Razorpay payments with idempotent webhooks | Planned (Days 15–16) |
| Ed25519-signed QR tickets, PDF + email delivery | Planned (Days 17–18) |
| Exactly-once check-in and an offline-capable scanner PWA | Planned (Days 19–20) |
| Live availability and check-in dashboards | Planned (Day 21) |
| Virtual waiting room for flash sales | Planned (Day 22) |
| Caching and load-tested performance | Planned (Days 23–24) |
| Organizer analytics, sponsor booth analytics and reports | Planned (Days 25–26) |
| AI organizer copilot with permission-scoped tools | Planned (Day 27) |
| Security hardening, observability and CI | Planned (Day 28) |
| Live deployment | Planned (Day 29) |

## Architecture

```mermaid
flowchart TB
  web["Web app (Next.js)"] --> api["API + Socket.IO (Express)"]
  scan["Scanner PWA"] --> api
  rzp["Razorpay"] -- webhooks --> api
  api --> redis[("Redis: holds, limits, queues")]
  api --> pg[("PostgreSQL: orders, tickets")]
  api --> mongo[("MongoDB: scans, analytics")]
  redis -- jobs --> worker["Worker (BullMQ)"]
  worker --> pg
  worker --> ext["SendGrid / S3-compatible storage"]
  web -- "banner upload (pre-signed POST)" --> s3[("S3 storage: banners")]
  api -- "sign, HeadObject" --> s3
```

- **PostgreSQL** holds anything involving money or capacity, because it needs transactions and constraints.
- **MongoDB** holds high-volume, append-only scan events that are read through aggregations.
- **Redis** holds fast, temporary state: the inventory gate, rate limits, the waiting room and job queues.

## How it works

FestPass has four kinds of users: **organizers** (college clubs) who run events, **attendees** who buy tickets, **volunteers** who scan passes at the gate and at sponsor booths, and **sponsors** who want to know how many people visited their booth.

One ticket's journey, end to end. The last column shows what works today; everything else is the design being built day by day.

| Step | What happens | Why it's built this way | Status |
|---|---|---|---|
| 1. Publish | An organizer creates an event with ticket tiers (Early bird, Regular, VIP) and publishes it. | Drafts never show on public pages; prices lock once a ticket sells. | Done (API Day 6, dashboard Day 9) |
| 2. Browse | Attendees open a server-rendered event page that is cached and revalidated when the organizer edits it. | Fast, shareable and indexable; availability shown there is only a hint. | Done (Day 10) |
| 3. Queue | For hot sales, attendees join a virtual waiting room and are admitted at a fixed rate. | Turns a stampede into a line so the database isn't flooded. | Planned (Day 22) |
| 4. Hold | Clicking **Book** reserves tickets for 10 minutes. Redis rejects the crowd quickly; Postgres makes the final decision with a single conditional `UPDATE`. | Two layers: Redis is fast, Postgres is correct. A CHECK constraint makes overselling impossible even if code has a bug. | Done in the API (Days 11–12); the Book button is wired up on Day 15 |
| 5. Pay | The attendee pays through Razorpay (test mode). Only the signed webhook marks the order paid, never the browser. | Webhooks can arrive twice, late or out of order, so every step is idempotent. Unpaid holds expire and return their tickets automatically. | Planned (Days 13–16) |
| 6. Ticket | A background worker issues tickets with Ed25519-signed QR codes, builds a PDF and emails it. | Signed QR codes can't be forged, and a phone can verify them without internet. | Planned (Days 17–18) |
| 7. Enter | A volunteer scans the QR at the gate. The ticket is accepted exactly once, even if two phones scan it at the same moment, and the scanner keeps working offline. | One guarded `UPDATE ... WHERE checked_in_at IS NULL` decides entry; offline scans sync later and conflicts are flagged. | Planned (Days 19–20) |
| 8. Measure | Booth scans feed sponsor dashboards (totals only, never names), organizers get live and post-event analytics, and an AI copilot answers questions using permission-checked tools. | Scan events are stored with the fields analytics needs, so dashboards are single aggregation queries. | Planned (Days 21–27) |

## Project structure

```
apps/
  web/       Next.js frontend: public pages, dashboards, checkout, scanner PWA   -> apps/web/README.md
  api/       Express REST API + Socket.IO                                         -> apps/api/README.md
  worker/    BullMQ background jobs (hold expiry, tickets, emails, reports)       -> apps/api/README.md
packages/
  shared/    Zod schemas, types and constants used by frontend and backend
  db/        Prisma schema, migrations and the raw-SQL booking path
  mongo/     Mongoose models for scan events and copilot conversations
infra/
  docker-compose.yml   Postgres, MongoDB, Redis and SeaweedFS (S3) for local development
scripts/     Small developer scripts
```

The [frontend README](apps/web/README.md) covers every screen, how pages are rendered and how the browser talks to the API. The [backend README](apps/api/README.md) covers the API, worker, databases, and the booking and payment flows.

## Tech stack

| Layer | Technology |
|---|---|
| Web | Next.js 16.4 (App Router), React 19.3, TypeScript 6.0, Tailwind CSS 4.3, react-hook-form 7.91 with the shared Zod schemas |
| API | Node.js 22, Express 5.3, Zod 4.6, pino 10.4 + pino-http 11, bcrypt 6, jsonwebtoken 9, Socket.IO |
| Jobs | BullMQ worker |
| Data | PostgreSQL 16 (Prisma 7.10 + raw SQL), MongoDB 7 (Mongoose 9.11), Redis 7 (ioredis 6.0) |
| Storage and email | S3-compatible storage via AWS SDK v3 (SeaweedFS 4.50 locally, Cloudflare R2 in production), SendGrid dynamic templates |
| Payments | Razorpay (test mode) |
| Testing | Vitest 5.0, Supertest 7.3, k6 |
| CI/CD | GitHub Actions, Docker |
| Tooling | pnpm 12 workspaces, ESLint 9 + typescript-eslint 8, Prettier 3 |

Versions are the ones installed so far; rows without a version arrive on later days. TypeScript is pinned to 6.0 because typescript-eslint does not support TypeScript 7 yet, and ESLint stays on 9 because the plugins inside `eslint-config-next` do not support ESLint 10 yet.

## Engineering decisions

_Filled in as each piece is built. Each entry covers the problem, the approach, alternatives considered, and how it is tested._

### Database constraints as the last line of defence (Day 2)

**Problem:** capacity and money rules are checked in application code, but code has bugs, and the booking path (Day 11) uses raw SQL that skips every ORM-level check. One wrong `UPDATE` during a flash sale would oversell a tier.

**Approach:** Postgres itself enforces the invariants with CHECK constraints in a hand-written migration (`packages/db/prisma/migrations/*_check_constraints`): `sold_count` between 0 and `capacity`, `capacity > 0`, prices and amounts `>= 0`, `per_user_limit` between 1 and 10, `qty > 0`, and `ends_at > starts_at`. Unique constraints cover the retry paths: one payment per `razorpay_payment_id`, one ticket per `(order_id, seq)`. If the app tries to write bad data, the statement fails and the transaction rolls back.

**Alternatives:** relying only on application checks (one bug away from overselling) or triggers (harder to read and test than a one-line CHECK).

**Tested by:** `packages/db/test/constraints.test.ts` runs raw `UPDATE`s against a real Postgres and asserts that `sold_count = capacity` succeeds while `capacity + 1` and `-1` are rejected by name.

### Auth: short-lived JWT + rotating refresh tokens (Day 4)

**Problem:** a single long-lived JWT can't be revoked: if it leaks, it works until it expires. But very short sessions make students log in again every few minutes, in the middle of a flash sale.

**Approach** (`apps/api/src/modules/auth/`):
- **Access token:** a JWT (HS256, 15 minutes) sent as `Authorization: Bearer`. It is checked without a database lookup, and if stolen it is only useful for minutes. `requireAuth` verifies it with the algorithm pinned to HS256 and sets `req.user`.
- **Refresh token:** 256 random bits in an `httpOnly`, `SameSite=Lax` cookie scoped to `/api/v1/auth` (`Secure` in production), so page scripts can't read it and it is never sent to the rest of the API. The database stores only its SHA-256, a `family_id` and a 7-day expiry.
- **Rotation:** every refresh revokes the presented token and issues a new one in the same family, inside one transaction. The revoke is a guarded `UPDATE ... WHERE revoked_at IS NULL`, so two concurrent refreshes with the same token can't both succeed.
- **Reuse detection:** a revoked token should never come back. If one does, someone kept a copy, so the whole family is revoked (attacker and user are both logged out, the user logs in again) and a warning is logged with the user and family IDs, never the token.
- **Passwords:** bcrypt cost 12, at most 72 bytes (bcrypt ignores the rest). Wrong password and unknown email return the same `INVALID_CREDENTIALS` error, and an unknown email still runs a bcrypt compare against a dummy hash so the response time doesn't reveal which emails exist.

**Alternatives:** server-side sessions in Redis (simple to revoke, but every request needs a lookup and the API stops being stateless); one long JWT (can't be revoked); refresh tokens in `localStorage` (readable by any XSS).

**Trade-off:** rotation is strict. If two tabs refresh with the same token at the same moment, the second is treated as reuse and the session ends. A short grace window could soften this later.

**Tested by:** `apps/api/test/auth.test.ts`: rotation revokes the old token and keeps the family; replaying an old token returns `REFRESH_TOKEN_REUSED` and kills the newest token too; only hashes are stored; expired and forged access tokens are rejected.

### Direct-to-storage uploads with pre-signed URLs (Day 8)

**Problem:** event banners are images of up to 2 MB. Streaming them through the API would tie up an Express worker and its memory for the whole upload, on every slow phone connection, and every byte would cross the network twice.

**Approach** (`apps/api/src/modules/uploads/`, `apps/api/src/lib/storage.ts`):
- **Sign, don't receive:** `POST /uploads/presign` checks that the caller may edit the event (OWNER or MANAGER), picks the key itself (`orgs/{orgId}/events/{eventId}/banner/{uuid}.{ext}`) and returns a pre-signed POST valid for 5 minutes. The browser sends the file straight to storage. The API never receives file bytes.
- **Limits enforced by storage:** the signed policy contains `content-length-range 1..2 MB` and `Content-Type` equal to the type that was signed. Storage checks the form against the policy, so a 3 MB file gets `400 EntityTooLarge` and a swapped type gets `403 AccessDenied` before anything is stored. Changing the policy breaks the signature.
- **Verify before saving:** the client then PATCHes the event with `bannerKey`. The API checks the key has this event's banner pattern (so nobody can point their event at another org's file), then runs `HeadObject`. It saves the key only if the object exists, has an allowed type and is within 2 MB. This storage call runs before the database write, never inside a transaction.
- **Public banners, private everything else:** `pnpm storage:init` grants anonymous `GetObject` on `orgs/*/events/*/banner/*` only. Banners appear on public event pages, so a plain URL (`bannerUrl` in every event response) can be cached by browsers and a CDN. Each upload gets a new UUID key, so a replaced banner never serves a stale copy.
- **Why ticket PDFs (Day 18) will be private:** a ticket PDF carries an attendee's name and a QR code that gets someone through the gate. A public URL can be guessed, forwarded or indexed and never expires. So ticket PDFs will sit outside the public prefix and be handed out only as short-lived pre-signed GET links to the ticket's owner.

**Alternatives:** multipart upload through the API with `multer` (simple, but the API carries every byte and needs its own size limit); a pre-signed PUT (one request, but a PUT URL can't enforce a size range, only a fixed `Content-Length`); trusting the client after upload (it could send any key, or a key it never uploaded).

**Limits:** the content type is the one the uploader declared; nothing sniffs the bytes yet. Replaced banners stay in storage until a cleanup job exists. Cloudflare R2 has no bucket policies, so in production banners will go in a bucket with public access turned on (planned, Day 29).

**Tested by:** `apps/api/test/uploads.test.ts` (S3 mocked): the signed policy contains the size range and type; a bad content type returns 400; a non-member gets 404 and a scanner 403; a PATCH with a missing object, a 2 MB + 1 byte object, a non-image type or another event's key is rejected. The real limits were also checked against SeaweedFS: 3 MB upload `400 EntityTooLarge`, swapped type `403 AccessDenied`, anonymous GET outside the banner prefix `403`.

### Money as integer paise, converted at the edge (Day 9)

**Problem:** prices are typed and read in rupees ("₹99.99"), but rupees with decimals are floats in JavaScript, and `99.99 * 100` is `9998.999999999998`. A float price can lose a paisa on the way in, and sums of floats drift.

**Approach:** everything behind the form (API, database, booking maths, Razorpay amounts) uses integer paise (`price_paise INT`, Zod `.int()`). Rupees exist only in the input box and on screen. `packages/shared/src/money.ts` is the only crossing: `rupeesToPaise` parses the text (`"99.99"` -> `99 * 100 + 99`) instead of multiplying a float and rejects more than 2 decimals rather than guessing; `paiseToRupees` and `formatPaise` go back with integer division. The web forms call it inside `sharedSchemaResolver`, so the shared `createTierSchema` validates the paise value and its errors are shown on the rupee input.

**Alternatives:** storing `NUMERIC(10,2)` rupees (exact in Postgres, but JavaScript would still see floats); converting with `Math.round(rupees * 100)` (works for 99.99 but hides typos like 1.005).

**Tested by:** `packages/shared/test/money.test.ts`: ₹99.99, ₹0.29 and ₹1.1 convert exactly; `1.005`, `-5`, `1,299`, `.5` and huge values are rejected; every amount from ₹0.00 to ₹1,000.00 round-trips. In the browser walk-through, typing ₹99.99 stored `price_paise = 9999`.

### Public pages: SSR + ISR with on-demand revalidation (Day 10)

**Problem:** event pages get the traffic spike: everyone opens the shared link the minute the sale is announced. Rendering each request on the server and calling the API means the spike hits the API and Postgres; client-side rendering would hide the content from search engines and link previews and show a spinner first.

**Approach** (`apps/web/src/app/(public)/`, `apps/web/src/app/api/revalidate/route.ts`, `apps/api/src/lib/revalidate.ts`):
- `/` and `/e/[slug]` are Server Components that fetch from the public API and send complete HTML (title, Open Graph banner, tiers) in the first response.
- **ISR** (`export const revalidate = 60`): the rendered HTML is cached and served to everyone; at most once a minute a request triggers a background re-render, and visitors keep getting the cached page meanwhile. A failed re-render keeps the last good page.
- **On-demand revalidation:** after a published event, its tiers or banner change, the API calls `POST /api/revalidate` on the web app with a shared secret (`Authorization: Bearer`, compared in constant time) and `{ slug }`. The route calls `revalidatePath('/e/{slug}')` and `revalidatePath('/')`, so the next visit renders fresh HTML. The call is fire-and-forget, made after the database work and never inside a transaction; if it fails, the 60 s timer still refreshes the page.
- **Availability is a hint:** the "12 left" on a cached page can be up to a minute old. The booking endpoint (Day 11) checks live stock in Postgres, so a stale number can only mean "you thought there were tickets and there weren't", which the booking response says clearly, never an oversell.

**Alternatives:** SSR on every request (always fresh, but every visitor during a spike costs an API call and a Postgres query); fully static at build time (needs a deploy per edit); client-side fetching (no HTML for crawlers or link previews, spinner on first load); tag-based revalidation (`revalidateTag`), which is finer-grained but needs every fetch tagged, while two paths per event are enough here.

**Tested by:** `route.test.ts` (wrong or missing secret 401, right secret revalidates both paths, bad slug 400); `events.test.ts` checks the API calls the route after publish and edits but not for drafts, and that an unreachable web app doesn't fail the request. Measured locally under [Performance](#performance).

### Preventing oversells (Day 11)

**Problem:** 200 students press **Book** on the last 10 tickets in the same second. The naive code, `SELECT sold_count`, check it in JavaScript, then `UPDATE`, lets every request read "10 left" before any of them writes, so all 200 succeed. The same gap lets one student send 20 requests at once and slip past a "2 per person" limit.

**Approach** (`packages/db/src/booking.ts`, one transaction in hand-written SQL, called by `apps/api/src/modules/orders/service.ts` after it checks that the event is published and on sale):

```sql
-- 1. One user's requests for one event take turns; released automatically at COMMIT or ROLLBACK.
SELECT pg_advisory_xact_lock(hashtextextended(:userId || ':' || :eventId, 0));

-- 2. A retry that waited on the lock finds the first request's stored answer and returns it.
SELECT request_hash, status, response FROM idempotency_keys WHERE user_id = :userId AND key = :key;

-- 3. Per-user limit: tickets this user already holds in the tier (PENDING, PAID, TICKETED) + this request.
SELECT t.id, t.per_user_limit, COALESCE(SUM(held qty), 0) ... FROM ticket_tiers t WHERE t.id = ANY(:tierIds);

-- 4. For each item, sorted by tier ID: take the tickets only if they still exist.
UPDATE ticket_tiers SET sold_count = sold_count + :qty
WHERE id = :tierId AND sold_count + :qty <= capacity
RETURNING price_paise;          -- no row: sold out, ROLLBACK TO SAVEPOINT, answer 409 SOLD_OUT

-- 5. The hold, and the answer stored under the key, in the same transaction.
INSERT INTO orders (..., status, expires_at) VALUES (..., 'PENDING', now() + make_interval(mins => :hold));
INSERT INTO order_items ...;  INSERT INTO idempotency_keys (..., status, response) VALUES (..., 201, :body);
```

- **The conditional UPDATE is the whole check.** The `WHERE` clause is evaluated while holding the tier's row lock, against the latest committed `sold_count`, so there is no gap between reading and writing for another request to slip into. Under READ COMMITTED, a request that waited for the lock re-checks the condition against the winner's committed value.
- **Tier IDs are sorted** so every transaction locks rows in the same order: two orders for {Day pass, Workshop} and {Workshop, Day pass} can't each hold one row while waiting for the other.
- **The advisory lock** is per (user, event), so it serialises one user's parallel requests (making the per-user count trustworthy) without slowing anyone else down.
- **Idempotency:** the answer (`201` with the order, or a `409` like `SOLD_OUT`) is stored with the order in one transaction, so they commit or fail together. A retry is answered from the table, even after the sale closes. If two requests use the same key for different events at once, the unique `(user_id, key)` index stops the second, its whole transaction (order included) rolls back, and it gets `422`.
- The CHECK constraint `sold_count <= capacity` from Day 2 stays underneath as the last line of defence.

**Alternatives:** `SELECT ... FOR UPDATE` then `UPDATE` (correct, but two round trips holding the lock and easy to get wrong); SERIALIZABLE isolation (correct, but losers fail with serialization errors that need retry loops); checking stock in Redis only (fast, but Redis is not the source of truth; it becomes the fast gate on Day 12).

**Tested by** `apps/api/test/orders.test.ts` (real Postgres, requests through the HTTP API with `Promise.all`), run 5 times in a row, same result every time:

| Test | Result |
|---|---|
| 200 different users, 1 ticket each, tier capacity 10 | 10 × `201`, 190 × `409 SOLD_OUT`, `sold_count` = 10, 10 orders |
| 1 user, 20 parallel requests, `perUserLimit` 2 | 2 × `201`, 18 × `409 PER_USER_LIMIT`, `sold_count` = 2 |
| Same user, advisory lock removed (manual check, not committed) | 11 × `201` against a limit of 2, in 3 out of 3 runs: the lock is what makes the limit hold |
| 60 users, half ordering {A, B} and half {B, A} | 60 × `201`, no deadlock |
| Same key and body twice; 10 parallel copies of one request | one order, every response identical, `Idempotent-Replayed: true` on retries |
| Same key, different body | `422 IDEMPOTENCY_KEY_REUSED`, nothing booked |
| Second tier sold out in a two-tier order | `409 SOLD_OUT` naming it; the first tier's tickets are given back |

`packages/db/test/booking.test.ts` forces the unique-index case deterministically (another transaction holds the same key uncommitted) and checks the booking rolls back completely and reports the key as reused.

#### Two layers: the Redis gate in front of Postgres (Day 12)

Postgres alone is correct, but in a flash sale every refused request still costs a transaction, a connection and a wait on the same tier row. A Redis gate turns most of the crowd away in memory first. It may only ever say **no** early; every **yes** is decided again by Postgres.

```mermaid
sequenceDiagram
  participant B as Browser
  participant A as API
  participant R as Redis (gate)
  participant P as Postgres (truth)
  B->>A: POST /events/:id/orders + Idempotency-Key
  A->>P: stored answer for this key? (replay)
  A->>R: reserve script: stock and per-user limit, all items or none
  alt Redis says no
    R-->>A: SOLD_OUT or LIMIT
    A-->>B: 409 (no Postgres transaction)
  else Redis says yes, or no answer within 50 ms
    A->>P: one transaction: advisory lock, conditional UPDATE per tier, order + stored answer
    alt Postgres booked it
      A-->>B: 201 order
    else Postgres refused or failed
      A->>R: release script (compensation)
      A-->>B: 409 or error
    end
  end
  Note over R,P: every minute the worker resets inv:* from Postgres (reconciliation)
```

- **Keys:** `inv:{tierId}` = tickets left (`capacity - sold_count`), set when an event is published and whenever a tier changes; `usr:{eventId}:{userId}:{tierId}` = tickets the user holds. Names live in `packages/shared/src/redis-keys.ts`.
- **One Lua script** (`apps/api/src/modules/orders/gate.ts`) checks every item's stock and per-user limit, then decrements all of them or none. Redis runs a script as one step, so no other request can run between the check and the write; separate `GET` and `DECRBY` calls from Node would reopen the exact race the conditional `UPDATE` closes in Postgres.
- **Compensation:** if Redis said yes but Postgres didn't book (sold out after all, over the limit, a replay, an error), a matching `release` script gives the stock back.
- **Duplicates:** a request that passes the gate leaves a 60-second `req:{userId}:{key}` marker, so copies of the same request (double click) skip the gate instead of taking stock twice; Postgres gives them the first answer.
- **Refusals from the gate aren't stored** under the Idempotency-Key (that would be a Postgres write per refusal, which is what the gate avoids). Nothing was booked, so a retry simply asks again.
- **Reconciliation:** `reconcileInventory()` (`packages/db/src/inventory.ts`) sets every `inv:*` of events still on sale from Postgres and reports what it fixed. The worker runs it every minute as a BullMQ job scheduler; the API runs it for one event after publishing or a tier change.
- **Counters:** the API logs `booked`, `rejectedAtGate`, `rejectedAtPostgres`, `gateSkipped` and `compensated` once a minute. In the 200-buyer test with the gate on: 190 refused at Redis, 0 at Postgres.

#### When Redis is down

- The gate uses its own client with no offline queue and a 50 ms limit, so a dead or slow Redis costs at most 50 ms. The API logs a warning and books through **Postgres only**, which is always correct, just with more load on the database.
- Tested: the whole booking suite runs three times, with Redis working, with every Redis command failing, and with Redis never answering. All three give exactly 10 orders for 10 tickets and the same answers.
- Publishing still works: syncing `inv:*` has a 1 s limit and only logs if Redis is unreachable.
- When Redis comes back empty (restarted without data), a tier with no `inv:` key is booked through Postgres and its key is filled in right after; the worker refills the rest within a minute.
- Ways Redis can drift from Postgres, and how each heals: a release that failed while Redis was down (Redis too low until reconciliation), a script that timed out but still ran (too low), reconciliation racing a booking in flight (briefly too high, which Postgres refuses). Too high only costs a Postgres refusal; too low would show "sold out" for tickets that exist, which reconciliation fixes within a minute.

**Planned:**

- Load test of the two-layer design (Day 24)
- Hold expiry (Day 13)
- Rate limiting (Day 14)
- Payment idempotency and the order state machine (Days 15–16)
- Forgery-proof QR tickets and offline scanning (Days 17, 20)
- Exactly-once entry (Day 19)
- Real-time updates (Day 21)
- Virtual waiting room (Day 22)
- Sponsor analytics and privacy (Day 26)
- AI copilot safety (Day 27)

## Roles and permissions

A college club is an **organization**; each member has one role in it. The matrix is data in `packages/shared/src/permissions.ts`, so the API (which enforces it) and the web app (which uses it to hide buttons) read the same table.

| Action | OWNER | MANAGER | SCANNER |
|---|:-:|:-:|:-:|
| `org:read`: see the org and its members | ✓ | ✓ | ✓ |
| `member:manage`: add, change and remove members | ✓ | | |
| `event:create` / `event:update` | ✓ | ✓ | |
| `event:publish` | ✓ | ✓ | |
| `checkin:scan`: scan tickets at the gate | ✓ | ✓ | ✓ |

- Enforced by `requireOrgPermission(action)` (`apps/api/src/middleware/require-org-permission.ts`) on every org route. The UI may hide buttons, but the API is the boundary.
- Not a member of the org: **404**, exactly like an org that doesn't exist, so org IDs can't be probed. A member without the permission: **403**.
- An org always keeps at least one OWNER: demoting or removing the last one returns `409 LAST_OWNER`, and the check locks the org's OWNER rows so two owners demoting each other at once can't both succeed.

## Data model

Schema: `packages/db/prisma/schema.prisma`. Tables and columns are snake_case, IDs are UUIDs generated by Postgres, money is integer paise and every timestamp is `timestamptz` (UTC).

```mermaid
erDiagram
  users ||--o{ refresh_tokens : has
  users ||--o{ org_members : "belongs to"
  organizations ||--o{ org_members : has
  organizations ||--o{ events : runs
  events ||--o{ ticket_tiers : sells
  events ||--o{ orders : receives
  users ||--o{ orders : places
  orders ||--o{ order_items : contains
  ticket_tiers ||--o{ order_items : "priced by"
  orders ||--o{ payments : "paid by"
  orders ||--o{ tickets : issues
  ticket_tiers ||--o{ tickets : grants
  users ||--o{ tickets : owns
  events ||--o{ sponsors : has
  sponsors ||--o{ sponsor_members : has
  users ||--o{ sponsor_members : "belongs to"
  sponsors ||--o{ booths : runs

  ticket_tiers {
    uuid id PK
    uuid event_id FK
    int price_paise "CHECK >= 0"
    int capacity "CHECK > 0"
    int sold_count "CHECK 0..capacity"
    int per_user_limit "CHECK 1..10"
  }
  orders {
    uuid id PK
    uuid user_id FK
    uuid event_id FK
    order_status status
    int amount_paise
    timestamptz expires_at
    text razorpay_order_id UK
  }
  tickets {
    uuid id PK
    uuid order_id FK
    int seq "unique with order_id"
    text code UK
    int qr_version
    timestamptz checked_in_at
  }
  payments {
    uuid id PK
    uuid order_id FK
    text razorpay_payment_id UK
    jsonb raw_payload
  }
```

- **Orders vs tickets:** an order is a purchase (amount, hold expiry, payment status). A ticket is one entry right (QR code, owner, check-in). An order for 3 tickets has one order row and three ticket rows, and a ticket can later change owner without touching the payment.
- **Idempotency keys:** `idempotency_keys(user_id, key UNIQUE, request_hash, status, response jsonb)` stores the answer to each booking request (HTTP status and body) in the same transaction as the order, so a retry gets exactly that answer.
- **Hot-path indexes:** `orders(user_id, status)`, `orders(status, expires_at)` for the hold-expiry sweep, `tickets(owner_user_id)`, `events(org_id, status)`, `events(status, starts_at, id)` for the public event list. `tickets(order_id)` is served by the unique `(order_id, seq)` index, so it has no separate index.

## Getting started

**Prerequisites**

- Node.js 22 (`.nvmrc`)
- pnpm 12 (`npm i -g pnpm`)
- Docker Desktop or OrbStack (for Postgres, MongoDB, Redis and SeaweedFS)

**Run it locally**

```bash
pnpm install
cp .env.example .env
pnpm infra:up   # starts the four services and waits until all are healthy
pnpm db:migrate  # creates the tables and CHECK constraints
pnpm db:seed     # demo org, users, a published event with three tiers, a sponsor
pnpm storage:init  # creates the bucket, public-read for banners, CORS for the web app
pnpm dev        # web on :3000, API on :4000, worker in the background
```

Seed accounts (`organizer@`, `scanner@`, `sponsor@` and `attendee@festpass.dev`) all log in with the password `festpass-dev`.

Check it: open http://localhost:3000 to see the published seed events, open one (`/e/mait-alumni-meet-2026`), then register (or log in with a seed account), create a club and reload the page: you stay logged in. Then click **New event**, add tiers and a banner, and publish it from the event page. `curl http://localhost:4000/api/v1/health/ready` should return `{"status":"ok","checks":{"postgres":"up","redis":"up","mongo":"up"}}`.

Upload a banner end to end (with `pnpm dev` running): `pnpm storage:upload-banner ./some-image.png`. It logs in as the seed organizer, presigns, uploads straight to storage, PATCHes the event and prints the public URL.

Local S3 storage is [SeaweedFS](https://github.com/seaweedfs/seaweedfs), because MinIO's free Docker images can no longer be pulled. The API only speaks the S3 protocol through AWS SDK v3, so any S3-compatible server (MinIO, R2) works by changing the `S3_*` variables.

The containers use host ports 5433, 27018 and 6380 instead of the defaults, so they don't clash with a Postgres, MongoDB or Redis already installed on your machine; storage is on 9000. Change them in `.env` if needed.

## Environment variables

| Variable | Used by | Description |
|---|---|---|
| `API_PORT` | api | Port the API listens on (default 4000) |
| `WEB_ORIGINS` | api | Comma-separated browser origins allowed to call the API with cookies (CORS); default `http://localhost:3000` |
| `NEXT_PUBLIC_API_URL` | web | API base URL the browser and the public pages' Server Components call (default `http://localhost:4000/api/v1`). Inlined into the bundle at build time, so never a secret |
| `WEB_REVALIDATE_URL` | api | The web app's revalidation route (default `http://localhost:3000/api/revalidate`), called when a published event changes |
| `REVALIDATE_SECRET` | api, web | Shared secret for `POST /api/revalidate`, sent as `Authorization: Bearer ...`. At least 32 characters; generate with `openssl rand -base64 48`. Server-only on the web side (no `NEXT_PUBLIC_`) |
| `NODE_ENV` | api | `development`, `test` or `production` (default `development`). Only `development` shows error messages and stacks in responses |
| `LOG_LEVEL` | api | pino level: `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent` (default `info`) |
| `JWT_ACCESS_SECRET` | api | Secret that signs access tokens (HS256). Required, at least 32 characters; generate one with `openssl rand -base64 48` |
| `ACCESS_TOKEN_TTL_SECONDS` | api | Access-token lifetime (default 900 = 15 minutes) |
| `REFRESH_TOKEN_TTL_DAYS` | api | Refresh-token lifetime; each refresh starts a new period (default 7) |
| `POSTGRES_PORT` | docker compose | Host port for Postgres (default 5433) |
| `DATABASE_URL` | api, db (Prisma CLI, seed) | Postgres connection string |
| `DATABASE_URL_TEST` | tests (`packages/db`, `apps/api`) | Separate Postgres database for tests; must end in `_test`, because tests truncate every table |
| `MONGO_PORT` | docker compose | Host port for MongoDB (default 27018) |
| `MONGODB_URI` | api | MongoDB connection string |
| `REDIS_PORT` | docker compose | Host port for Redis (default 6380) |
| `REDIS_URL` | api, worker | Redis connection string (booking gate, BullMQ queues). Tests use database 15 of the same server |
| `HOLD_MINUTES` | api | How long a booking holds its tickets before they go back on sale if unpaid (1–60, default 10) |
| `S3_PORT` | docker compose | Host port for the local SeaweedFS S3 API (default 9000) |
| `S3_ENDPOINT` | api | S3-compatible endpoint: `http://localhost:9000` locally, `https://<account>.r2.cloudflarestorage.com` for R2 |
| `S3_REGION` | api | Signing region (default `us-east-1`; `auto` for R2) |
| `S3_BUCKET` | api | Bucket for uploads (`festpass`) |
| `S3_ACCESS_KEY_ID` | api, docker compose | Storage access key; docker compose also uses it as the local SeaweedFS admin key |
| `S3_SECRET_ACCESS_KEY` | api, docker compose | Storage secret key (never logged) |
| `S3_PUBLIC_URL` | api, web | Base URL public objects are served from, used to build `bannerUrl` (api) and as the only allowed `next/image` source (web): `http://localhost:9000/festpass` locally, the R2 public domain in production |

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Runs web, API and worker in parallel with hot reload |
| `pnpm build` | Builds every package and app |
| `pnpm lint` | ESLint over the whole repo |
| `pnpm typecheck` | TypeScript checks in every package |
| `pnpm test` | Runs all test suites (Vitest) |
| `pnpm format` | Formats code with Prettier |
| `pnpm infra:up` | Starts Postgres, MongoDB, Redis and SeaweedFS and waits for healthchecks |
| `pnpm infra:down` | Stops the containers (data stays in named volumes) |
| `pnpm db:migrate` | Applies pending Prisma migrations (and creates a new one if the schema changed) |
| `pnpm db:reset` | Drops the database and re-applies every migration (destroys local data) |
| `pnpm db:seed` | Inserts demo data; safe to run repeatedly |
| `pnpm db:studio` | Opens Prisma Studio to browse the tables |
| `pnpm storage:init` | Creates the bucket, makes `orgs/*/events/*/banner/*` publicly readable and allows `WEB_ORIGINS` to POST uploads (CORS); safe to run repeatedly |
| `pnpm storage:upload-banner <image> [email] [password]` | Uploads an image as the banner of the first event of that user's first org (default: the seed organizer) and prints its public URL |

## API reference

### Conventions

- **Base path:** every endpoint lives under `/api/v1` and speaks JSON.
- **Errors** always have one shape, produced by a single error handler (`apps/api/src/middleware/error-handler.ts`):
  ```json
  { "error": { "code": "VALIDATION_FAILED", "message": "Request validation failed", "details": { "fields": [{ "location": "body", "path": "email", "message": "Invalid email address" }] }, "requestId": "6f1c..." } }
  ```
  Codes so far: `VALIDATION_FAILED` (400), `INVALID_JSON` (400), `UNAUTHORIZED`, `INVALID_CREDENTIALS`, `INVALID_ACCESS_TOKEN`, `INVALID_REFRESH_TOKEN`, `REFRESH_TOKEN_REUSED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `EMAIL_TAKEN`, `SLUG_TAKEN`, `ALREADY_MEMBER`, `LAST_OWNER`, `INVALID_TRANSITION`, `NO_TIERS`, `EVENT_IN_PAST`, `EVENT_CLOSED`, `TIER_NAME_TAKEN`, `PRICE_LOCKED`, `CAPACITY_LOCKED`, `TIER_HAS_SALES`, `SALE_NOT_STARTED`, `SALE_ENDED`, `PER_USER_LIMIT`, `SOLD_OUT` (409), `IDEMPOTENCY_KEY_REUSED` (422), `RATE_LIMITED` (429), `INTERNAL_ERROR` (500). Outside development, a 500 never includes the internal message or stack.
- **Request IDs:** send `X-Request-Id` (up to 64 letters, digits, `_` or `-`) to reuse your own; otherwise the API generates a UUID. It comes back in the `X-Request-Id` response header, in every error body and in every log line for that request.
- **Validation:** params, query and body are validated with Zod schemas from `packages/shared`; every invalid field is reported at once.
- **CORS:** only origins in `WEB_ORIGINS` get CORS headers, with credentials allowed, so only the web app can call the API from a browser with the refresh cookie.
- **Auth:** protected endpoints need `Authorization: Bearer <accessToken>`. The refresh token is only ever an `fp_refresh` cookie; it never appears in a response body.
- **Pagination:** list endpoints take `?cursor=&limit=` (`limit` 1–100, default 20) and return `{ items, nextCursor }`; pass `nextCursor` back to get the next page (`null` on the last page). Cursors are opaque and keyset-based on `(startsAt, id)`, so pages stay correct when events are added between requests.
- **Idempotency:** `POST /events/:eventId/orders` requires an `Idempotency-Key` header (a UUID the client generates once per booking attempt). Retrying with the same key and body returns the stored answer, with `Idempotent-Replayed: true`, and books nothing new; the same key with a different body is a `422`.
- **Dates:** ISO 8601 with a timezone, e.g. `2026-12-12T10:00:00+05:30`; stored and returned in UTC.
- **Banners:** every event response includes `bannerKey` and `bannerUrl` (a public URL, or `null`).

### Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/v1/orgs` | Bearer | Body `{ name, slug? }` (slug derived from the name if missing). Creates the org with the caller as OWNER. `201 { org }`; `409 SLUG_TAKEN` |
| GET | `/api/v1/orgs/mine` | Bearer | `200 { orgs: [{ id, name, slug, role }] }`: every org the caller belongs to, with their role |
| GET | `/api/v1/orgs/:orgId` | Bearer, `org:read` | `200 { org, members: [{ userId, name, email, role }] }`; `404` for non-members |
| POST | `/api/v1/orgs/:orgId/members` | Bearer, `member:manage` | Body `{ email, role }` adds an existing user. `201 { member }`; `404` if no account has that email; `409 ALREADY_MEMBER` |
| PATCH | `/api/v1/orgs/:orgId/members/:userId` | Bearer, `member:manage` | Body `{ role }`. `200 { member }`; `409 LAST_OWNER` if it would leave no OWNER |
| DELETE | `/api/v1/orgs/:orgId/members/:userId` | Bearer, `member:manage` | `204`; `409 LAST_OWNER` for the last OWNER |
| POST | `/api/v1/orgs/:orgId/events` | `event:create` | Body `{ title, description?, venue, startsAt, endsAt, saleStartsAt, saleEndsAt, queueMode?, admitRatePerSec? }` (ends after start, sales end by the event's end; waiting room off and 50/s by default, rate 1–1000). Creates a DRAFT; the slug comes from the title, with a 4-character suffix if taken. `201 { event }` |
| GET | `/api/v1/orgs/:orgId/events` | `org:read` | All of the org's events, any status, `{ items, nextCursor }`; each item has `capacity` and `soldCount` summed over its tiers |
| GET | `/api/v1/orgs/:orgId/events/:eventId` | `org:read` | `200 { event }` with its tiers (`soldCount`, `available`) |
| PATCH | `/api/v1/orgs/:orgId/events/:eventId` | `event:update` | Partial update; dates re-checked together, tier sale windows must still fit. The slug never changes. `bannerKey` (from presign) is saved only after `HeadObject` confirms the object exists, is JPEG/PNG/WebP and at most 2 MB, else `400` on `bannerKey`; `null` removes the banner. `409 EVENT_CLOSED` once closed |
| POST | `/api/v1/uploads/presign` | Bearer, `event:update` on the event's org | Body `{ eventId, contentType: image/jpeg \| image/png \| image/webp }`. `201 { upload: { url, fields, key, maxBytes, expiresAt } }`: POST a multipart form to `url` with every `fields` entry, then the file as `file`, within 5 minutes. `400` for another type, `404` for non-members (same as a missing event), `403` for scanners |
| POST | `/api/v1/orgs/:orgId/events/:eventId/publish` | `event:publish` | DRAFT → PUBLISHED. `409 NO_TIERS` without tiers, `409 EVENT_IN_PAST` if it already started, `409 INVALID_TRANSITION` otherwise |
| POST | `/api/v1/orgs/:orgId/events/:eventId/close` | `event:publish` | PUBLISHED → CLOSED (stays public, no longer bookable) |
| POST | `/api/v1/orgs/:orgId/events/:eventId/tiers` | `event:update` | Body `{ name, pricePaise ≥ 0, capacity > 0, perUserLimit 1–10 (default 4), saleStartsAt?, saleEndsAt? }`; the tier's sale window must sit inside the event's. `201 { tier }`; `409 TIER_NAME_TAKEN` |
| PATCH | `/api/v1/orgs/:orgId/events/:eventId/tiers/:tierId` | `event:update` | Partial update. After the first sale: `409 PRICE_LOCKED` for a new price, `409 CAPACITY_LOCKED` for less capacity |
| DELETE | `/api/v1/orgs/:orgId/events/:eventId/tiers/:tierId` | `event:update` | `204`; `409 TIER_HAS_SALES` once anything is sold |
| GET | `/api/v1/events` | none | Published events that haven't ended, soonest first. `?cursor=&limit=&orgId=`. `{ items, nextCursor }` |
| GET | `/api/v1/events/:slug` | none | A published or closed event with its org and tiers, each with `available = capacity - soldCount`. Drafts: `404` |
| POST | `/api/v1/events/:eventId/orders` | Bearer, `Idempotency-Key: <uuid>` | Body `{ items: [{ tierId, qty 1–10 }] }` (1–10 items, each tier once). Holds the tickets and creates a `PENDING` order that expires after `HOLD_MINUTES`: `201 { order: { id, eventId, status, amountPaise, expiresAt, items: [{ tierId, tierName, qty, unitPricePaise }] } }`. `409 SOLD_OUT` (names the tier, nothing is held), `409 PER_USER_LIMIT` (counts the user's pending, paid and ticketed orders), `409 SALE_NOT_STARTED` / `SALE_ENDED` / `EVENT_CLOSED`, `404` for drafts, `400` for a tier of another event, `422 IDEMPOTENCY_KEY_REUSED` |
| GET | `/api/v1/health/live` | none | Liveness: `200 { "status": "ok" }` whenever the process can answer. Checks no dependencies |
| POST | `/api/v1/auth/register` | none | Body `{ email, password (8+ chars, max 72 bytes), name, college?, branch?, graduationYear? }`. `201 { user, accessToken }` and sets the `fp_refresh` cookie. `409 EMAIL_TAKEN` if the email (case-insensitive) exists |
| POST | `/api/v1/auth/login` | none | Body `{ email, password }`. `200 { user, accessToken }` and a new `fp_refresh` cookie (a new token family). `401 INVALID_CREDENTIALS` for a wrong password or unknown email alike |
| POST | `/api/v1/auth/refresh` | `fp_refresh` cookie | Rotates the refresh token: `200 { user, accessToken }` and a new cookie. `401 INVALID_REFRESH_TOKEN` if missing, unknown or expired; `401 REFRESH_TOKEN_REUSED` (and the whole family is revoked) if the token was already used |
| POST | `/api/v1/auth/logout` | `fp_refresh` cookie | Revokes this session's token family and clears the cookie. Always `204` |
| GET | `/api/v1/auth/me` | Bearer | `200 { user }`. `401` without a valid access token |
| GET | `/api/v1/health/ready` | none | Readiness: pings Postgres, Redis and MongoDB in parallel (1 s timeout each). `200` with `{ "status": "ok", "checks": { "postgres": "up", ... } }`, or `503` with `"status": "unavailable"` and the down dependency marked `"down"` |

## Testing

_How to run the tests and what the key tests prove._

Run `pnpm test`. The `packages/db` tests need Postgres running, because constraints can only be proven by the real database. They use a separate database (`DATABASE_URL_TEST`, default `festpass_test`): Vitest's global setup creates and migrates it automatically, and `truncateAll` (`packages/db/src/testing.ts`) empties it between tests. `truncateAll` refuses to run on any database whose name doesn't end in `_test`, so tests can never wipe dev data.

- `apps/api/test/errors.test.ts`: a bad body or query returns 400 with every invalid field and the request ID; unknown routes return 404 in the standard shape; invalid JSON returns 400; an `AppError` keeps its status and code; an unexpected error returns a generic 500 with no internal message or stack; incoming `X-Request-Id` values are reused only when safe.
- `apps/api/test/health.test.ts`: liveness; readiness returns 200 when all checks pass, and 503 naming the dependency when a check fails or hangs (checks are injected fakes, so no real outage is needed).
- `apps/api/test/auth.test.ts` (against the test database): register stores a cost-12 bcrypt hash and only the SHA-256 of the refresh token, and sets an `HttpOnly`, `SameSite=Lax`, `/api/v1/auth` cookie; duplicate email (any case) returns 409; wrong password and unknown email return the same 401; `/me` rejects a missing, expired or forged token; refresh rotates the token within its family; replaying an old token revokes the whole family; logout makes the refresh token stop working.
- `apps/api/test/orgs.test.ts` (against the test database): loops over every role × action and checks both `can()` and the real `requireOrgPermission` middleware against a hand-written policy table; a non-member gets 404 for every action, identical to a nonexistent org; creating an org makes the creator OWNER; owners add members by email, managers get 403; the last OWNER can't be demoted or removed; two owners demoting each other concurrently leave exactly one OWNER.
- `apps/api/test/orders.test.ts` (against the test database, parallel HTTP requests): every booking test runs three times, with Redis working, failing and hanging (both Redis states mocked on the gate client), with identical results; see the table under [Preventing oversells](#preventing-oversells-day-11). The gate tests check publishing fills `inv:*`, compensation gives stock back when Postgres refuses, a gate refusal isn't stored under the key, a missing key is refilled after the booking, and reconciliation fixes a corrupted and a missing key (and finds nothing on a second run). Also a missing or non-UUID `Idempotency-Key` (400 on the header), no login (401), a tier of another event and duplicate tiers (400), drafts (404), `SALE_NOT_STARTED` and `EVENT_CLOSED`, and that the hold lasts `HOLD_MINUTES` and copies the tier price.
- `packages/db/test/booking.test.ts`: when another transaction stores the same idempotency key first, the booking rolls back completely (no order, `sold_count` unchanged) and returns `key-reused`.
- `apps/api/test/events.test.ts` (against the test database): the full organizer flow ends with the event on `GET /events`; slug collisions get a suffix; every tier rule (capacity, price, per-user limit, sale window) returns 400 on its field; after a sale (soldCount set directly) the price is locked, capacity only grows and the tier can't be deleted; publishing needs tiers and a future start; DRAFT → PUBLISHED → CLOSED only; drafts never appear publicly; queue settings default to off at 50/s and survive unrelated edits, and a rate of 0 is a 400; the org list sums sold and capacity over tiers; paging through 7 events (3 with the same start time) with `limit=3` returns each exactly once in order, even when a new event is inserted between pages.
- `packages/shared/test/money.test.ts`: rupee↔paise conversion, including ₹99.99 (`9999`, where a float multiply gives `9998.999…`), ₹0.29 and ₹1.1; amounts with 3 decimals, signs, commas or symbols are rejected; every amount up to ₹1,000.00 round-trips.
- `apps/web/src/lib/form-helpers.test.ts`: `sharedSchemaResolver` returns exactly what the API accepts and puts the shared schema's messages on the typed-in fields (`pricePaise` -> `price`); `datetime-local` values round-trip through UTC.
- `apps/web/src/lib/api.test.ts` (Vitest, fake `fetch`): on a 401 the client refreshes once and retries with the new token; a retry that is still 401 is not retried again; a failed refresh stops immediately and reports the logout; two requests failing at once share one refresh call; error bodies become a typed `ApiError`.
- `apps/api/test/uploads.test.ts` (S3 mocked with a spy on the client's `send`): presign signs a fixed key under the event's banner prefix with `content-length-range` and `Content-Type` in the policy; a bad content type returns 400, a non-member 404, a scanner 403, no login 401; PATCH saves a confirmed `bannerKey` and returns `bannerUrl`, rejects a missing object, an object over 2 MB and a non-image type, rejects another event's key without calling storage, and `null` clears the banner.
- `apps/web/src/app/api/revalidate/route.test.ts` (`next/cache` mocked): a wrong secret, no header, or the secret without `Bearer` get 401 and revalidate nothing; the right secret revalidates `/e/{slug}` and `/`; a slug like `../dashboard` is a 400.
- `apps/web/src/lib/tier-state.test.ts`: a tier follows the event's sale window unless it has its own (early bird); exact boundaries; closed beats sold out beats the window.
- `apps/api/test/events.test.ts` › public page revalidation (`fetch` spied): editing a draft calls nothing; publishing and editing a published event POST `{ slug }` with the Bearer secret to `WEB_REVALIDATE_URL`; a web app that can't be reached never fails the organizer's request.
- `apps/api/test/cors.test.ts`: the web origin gets a preflight with credentials allowed; any other origin gets no CORS headers.
- `apps/api/test/env.test.ts`: env parsing applies defaults, coerces numbers and lists every invalid variable in one message.
- `packages/db/test/constraints.test.ts`: Postgres rejects `sold_count` above capacity or below zero and an out-of-range `per_user_limit`, even through raw SQL.
- `packages/db/test/seed.test.ts`: on an empty database the seed creates exactly the demo rows, and a second run changes nothing; seed users log in with `festpass-dev`; `truncateAll` refuses a non-`_test` database.

## Performance

**Public pages (Day 10), measured** on a MacBook Air (Apple M2, 8 GB, macOS 27.2), everything local: `next start` (production build), the API in dev mode, Postgres in Docker.

| What | Result |
|---|---|
| Event page served from the ISR cache | `x-nextjs-cache: HIT` on the second request; a title changed directly in the database (bypassing the API) stays hidden until revalidation, proving the page is cached |
| Edit through the API → public page updated | new title visible 137 ms after the PATCH was sent (first poll that saw it) |
| Edit saved in the dashboard → public page updated | visible on the first check after "Changes saved", 27 ms later |

**Lighthouse:** not measured yet. To record it, run against the production build with a published event:

```bash
pnpm build && pnpm --filter @festpass/web start
npx lighthouse http://localhost:3000/e/mait-alumni-meet-2026 --only-categories=performance,accessibility,best-practices,seo --view
```

and note the Lighthouse version, mobile or desktop preset, throttling and machine next to the scores.

## Load test results

_Day 24. Only measured numbers, with the exact setup used._

## Deployment

_Day 29._

## 30-day progress

The project is built in 30 daily slices. Each day ships working, tested code and adds an entry to the build log below.

<!-- TRACKER:START -->
- [x] Day 01 (Fri 30 Oct): Monorepo and local infrastructure
- [x] Day 02 (Sat 31 Oct): Database schema v1
- [x] Day 03 (Sun 01 Nov): API foundation
- [x] Day 04 (Mon 02 Nov): Authentication with refresh-token rotation
- [x] Day 05 (Tue 03 Nov): Organizations and role-based access
- [x] Day 06 (Wed 04 Nov): Events and ticket tiers API
- [x] Day 07 (Thu 05 Nov): Web foundation and auth UI
- [x] Day 08 (Fri 06 Nov): Banner uploads with pre-signed URLs
- [x] Day 09 (Sat 07 Nov): Organizer dashboard UI
- [x] Day 10 (Sun 08 Nov): Public event pages with SSR and ISR
- [x] Day 11 (Mon 09 Nov): Booking engine I: Postgres correctness
- [x] Day 12 (Tue 10 Nov): Booking engine II: the Redis gate
- [ ] Day 13 (Wed 11 Nov): Hold expiry with BullMQ
- [ ] Day 14 (Thu 12 Nov): Rate limiting with a token bucket
- [ ] Day 15 (Fri 13 Nov): Razorpay checkout (test mode)
- [ ] Day 16 (Sat 14 Nov): Webhooks and the order state machine
- [ ] Day 17 (Sun 15 Nov): Signed QR tickets
- [ ] Day 18 (Mon 16 Nov): PDF tickets and email delivery
- [ ] Day 19 (Tue 17 Nov): Check-in API and scan events
- [ ] Day 20 (Wed 18 Nov): Scanner PWA with offline mode
- [ ] Day 21 (Thu 19 Nov): Real-time updates with Socket.IO
- [ ] Day 22 (Fri 20 Nov): Virtual waiting room
- [ ] Day 23 (Sat 21 Nov): Caching and query performance
- [ ] Day 24 (Sun 22 Nov): Load testing with k6
- [ ] Day 25 (Mon 23 Nov): Analytics pipelines and dashboards
- [ ] Day 26 (Tue 24 Nov): Sponsor portal, booth scans and reports
- [ ] Day 27 (Wed 25 Nov): AI organizer copilot
- [ ] Day 28 (Thu 26 Nov): Security, observability and CI
- [ ] Day 29 (Fri 27 Nov): Deploy
- [ ] Day 30 (Sat 28 Nov): Ship it and prepare the story
<!-- TRACKER:END -->

## Build log

<!-- BUILD-LOG:START -->
### Day 01: Monorepo and local infrastructure (2026-10-30)
**Built:**
- pnpm workspace with `apps/web` (Next.js + Tailwind), `apps/api` (Express), `apps/worker` and `packages/shared`, `db`, `mongo`; every package builds.
- Shared TypeScript (strict, `noUncheckedIndexedAccess`), ESLint and Prettier config at the root.
- `infra/docker-compose.yml` with Postgres 16, MongoDB 7, Redis 7 and MinIO, each with a named volume and a healthcheck.
- `GET /api/v1/health` with a Vitest + Supertest test.

**Key decision:** containers publish on non-default host ports (5433, 27018, 6380) bound to 127.0.0.1, instead of 5432/27017/6379, because this machine already runs local copies of all three and a clash would silently connect the app to the wrong database.
**Verify:** `pnpm install && pnpm lint && pnpm typecheck && pnpm test`, then `pnpm infra:up && pnpm dev` and `curl localhost:4000/api/v1/health`.
**Next:** Day 2 adds the Prisma schema, CHECK constraints and seed data in `packages/db`.

### Day 02: Database schema v1 (2026-10-31)
**Built:**
- Prisma 7 in `packages/db` with an exported client singleton and 14 snake_case tables (users and refresh tokens, orgs and roles, events and tiers, orders, payments, tickets, sponsors and booths).
- A hand-written migration with CHECK constraints (capacity, prices, per-user limit, event dates), plus hot-path indexes.
- An idempotent seed: MAIT Alumni Cell, four role users, a published event with Early bird / Regular / VIP tiers, one sponsor with a booth.
- Root `db:migrate`, `db:reset`, `db:seed`, `db:studio` scripts and tests for the constraints and the seed.

**Key decision:** capacity is enforced by a Postgres CHECK constraint, not just application code, because the booking path uses raw SQL and one buggy `UPDATE` must not be able to oversell; the database rejects it no matter which code path wrote it.
**Verify:** `pnpm infra:up && pnpm db:reset && pnpm db:seed && pnpm test`.
**Next:** Day 3 adds env validation, structured errors, request IDs and a readiness check that pings Postgres through this client.

### Day 03: API foundation (2026-11-01)
**Built:**
- `apps/api/src` split into `config/`, `lib/`, `middleware/` and `modules/health/` (routes, controller, service, repository), with env validated by Zod at startup.
- pino + pino-http logging with a request ID per request (reused from `X-Request-Id` when safe), an `AppError` hierarchy and one error handler that returns the standard error shape.
- A `validate({ params, query, body })` middleware, `/api/v1/health/live` and `/api/v1/health/ready` (Postgres, Redis, Mongo, 503 if any is down), and graceful shutdown on SIGTERM/SIGINT.
- A separate test database that Vitest migrates automatically, plus a `truncateAll` helper that only runs on `*_test` databases.

**Key decision:** readiness checks are passed into `createApp()` instead of being imported directly, so tests simulate a dead Redis or a hanging Mongo with a fake function instead of stopping containers; the real checks run in parallel with a 1 s timeout each, because a hung dependency is as bad as a dead one.
**Verify:** `pnpm test`, then `pnpm dev` and `curl -i localhost:4000/api/v1/nope -H 'X-Request-Id: demo-1'` (404 in the standard shape with `requestId: "demo-1"`) and `curl localhost:4000/api/v1/health/ready`.
**Next:** Day 4 adds register, login, refresh-token rotation with reuse detection, logout and `/me` on top of this error and validation layer.

### Day 04: Authentication with refresh-token rotation (2026-11-02)
**Built:**
- `POST /auth/register`, `/login`, `/refresh`, `/logout` and `GET /auth/me`, with request schemas in `packages/shared` and an `auth` module split into routes, controller, service and repository.
- bcrypt (cost 12) passwords and one generic login error; 15-minute HS256 access tokens checked by a `requireAuth` middleware.
- 256-bit refresh tokens stored only as SHA-256 hashes, in an `httpOnly` cookie scoped to `/api/v1/auth`, rotated on every refresh, with reuse detection that revokes the whole token family.
- Seed users now log in with a real password (`festpass-dev`).

**Key decision:** refresh tokens are random strings stored hashed in Postgres instead of being a second JWT, because a refresh token has to be revocable and detectable on reuse, which needs a database row anyway; the short JWT access token keeps every other request free of database lookups.
**Verify:** `pnpm test`, then `pnpm dev` and `curl -c jar -X POST localhost:4000/api/v1/auth/login -H 'Content-Type: application/json' -d '{"email":"organizer@festpass.dev","password":"festpass-dev"}'`, then `curl -b jar -c jar -X POST localhost:4000/api/v1/auth/refresh`.
**Next:** Day 5 adds club organizations with OWNER, MANAGER and SCANNER roles, enforced by middleware on top of `requireAuth`.

### Day 05: Organizations and role-based access (2026-11-03)
**Built:**
- Org endpoints: create (creator becomes OWNER), list mine, get one, and add, change or remove members by email.
- A permission matrix as data in `packages/shared` (OWNER, MANAGER, SCANNER × org, member, event and check-in actions) with a `can(role, action)` helper.
- `requireOrgPermission(action)` middleware: 404 for non-members, 403 for members without the permission.
- The last-OWNER rule, enforced in a transaction that locks the org's OWNER rows.

**Key decision:** non-members get 404 instead of 403, because 403 would confirm that an org with that ID exists; members without a permission get 403, since they already know the org.
**Verify:** `pnpm test`, then log in as `organizer@festpass.dev` and `curl localhost:4000/api/v1/orgs/mine -H "Authorization: Bearer <token>"`; the same org ID with the attendee's token returns 404.
**Next:** Day 6 adds events and ticket tiers under an org, guarded by `event:create` and `event:publish`.

### Day 06: Events and ticket tiers API (2026-11-04)
**Built:**
- Organizer endpoints under `/orgs/:orgId/events`: create (slug from the title, short suffix on collision), list, get, update, publish and close, guarded by the Day 5 permission matrix.
- Tier create, update and delete with validation (capacity, price, per-user limit, sale window inside the event's), plus price lock and grow-only capacity once a ticket is sold, checked under a row lock.
- An event status module (DRAFT → PUBLISHED → CLOSED) with guarded updates; publishing needs a tier and a future start.
- Public `GET /events` (keyset cursor on `(startsAt, id)`, optional org filter) and `GET /events/:slug` with `available` per tier; a new index on `events(status, starts_at, id)`.

**Key decision:** keyset (cursor) pagination on `(startsAt, id)` instead of `OFFSET`, because events added while someone is paging would shift offsets and show an event twice or skip one; the cursor says "after this row", which doesn't move.
**Verify:** `pnpm test`, then log in as the organizer, `POST /orgs/:orgId/events`, add a tier, `POST .../publish`, and `curl localhost:4000/api/v1/events`.
**Next:** Day 7 starts the web app: auth pages with silent refresh, creating an org and an organizer dashboard shell.

### Day 07: Web foundation and auth UI (2026-11-05)
**Built:**
- Next.js route groups `(public)`, `(auth)` and `(dashboard)`, design tokens in Tailwind's `@theme`, and Button, Input, Card, Badge, Toast and EmptyState components.
- A typed API client that keeps the access token in memory, refreshes once on a 401 and retries once (shared between concurrent requests), and turns error bodies into `ApiError`.
- An auth context that silently refreshes on page load from the httpOnly cookie; register and login forms with react-hook-form and the shared Zod schemas.
- A protected dashboard with an org switcher, team list and create-club flow; API CORS for the web origin with credentials.

**Key decision:** the access token lives only in JavaScript memory and the refresh token only in an httpOnly cookie, instead of putting either in `localStorage`, because anything in storage can be read by any script on the page; a reload costs one `/auth/refresh` call, which is the price of nothing stealable being stored.
**Verify:** `pnpm test`, then `pnpm dev`, open http://localhost:3000/register, create an account and a club, and hard-reload `/dashboard`: you stay logged in.
**Next:** Day 8 adds banner uploads straight from the browser to S3-compatible storage with pre-signed URLs.

### Day 08: Banner uploads with pre-signed URLs (2026-11-06)
**Built:**
- A storage module on AWS SDK v3 (path-style, so it works on SeaweedFS locally and R2 later) and SeaweedFS in docker compose in place of MinIO, whose images can no longer be pulled.
- `POST /uploads/presign` for OWNER and MANAGER: a 5-minute pre-signed POST for a server-chosen key `orgs/{orgId}/events/{eventId}/banner/{uuid}.{ext}` with a 2 MB `content-length-range` and the content type in the signed policy.
- PATCH event with `bannerKey`: the key must match the event's banner pattern and `HeadObject` must confirm the object, its type and size; events now return `bannerUrl`.
- `pnpm storage:init` (bucket, public-read on banners only, CORS for the web app) and `pnpm storage:upload-banner` for the whole flow from the command line.

**Key decision:** the browser uploads straight to storage with a pre-signed POST instead of sending the file through the API, so the API never handles file bytes. The POST policy (rather than a pre-signed PUT) lets storage itself enforce the 2 MB range and the content type.
**Verify:** `pnpm test`, then `pnpm infra:up`, `pnpm storage:init`, `pnpm dev`, and `pnpm storage:upload-banner ./some-image.png`. Open the printed URL.
**Next:** Day 9 builds the organizer dashboard UI, including a banner uploader on top of this flow.

### Day 09: Organizer dashboard UI (2026-11-07)
**Built:**
- Events list per club with status badges and sold / capacity (summed by the API), and an event editor at `/dashboard/orgs/[orgId]/events/[eventId]` for details, sale window, waiting-room toggle and admit rate.
- A tier editor that takes rupees and sends paise through a shared, tested `rupeesToPaise`, and a banner uploader on the Day 8 flow with preview, progress and error states.
- Publish and close behind confirmation dialogs that show the API's refusal (e.g. "Add at least one ticket tier before publishing"), and a members page to add by email, change roles and remove.
- `sharedSchemaResolver` so converted forms (local dates, rupees) still validate with the shared Zod schemas, with server field errors shown under the right input.

**Key decision:** convert at the edge: the form shows rupees and local time, and the moment it's submitted they become paise and UTC, the only forms the API, database and booking maths ever see. Storing rupees would put floats (`99.99 * 100 = 9998.999…`) into money maths.
**Verify:** `pnpm test`, then `pnpm dev`, log in, click **New event**, add a ₹99.99 tier and a banner, publish, and add `scanner@festpass.dev` on **Members**.
**Next:** Day 10 builds the public event pages (server-rendered and cached) that published events appear on.

### Day 10: Public event pages with SSR and ISR (2026-11-08)
**Built:**
- `/` (upcoming events) and `/e/[slug]` (event page) as Server Components that fetch from the API, cached with ISR (60 s), with loading, error and 404 states (unknown slugs and drafts).
- On-demand revalidation: the API calls a secret-protected `POST /api/revalidate` after a published event, its tiers or banner change, and the route revalidates `/e/{slug}` and `/`.
- `generateMetadata` with title, description and the banner as the Open Graph image; tier cards with price, availability, sale state and a Book button (wired up on Days 11 and 15).
- Banners through `next/image`, env validation in `next.config.ts`, and login and dashboard moved under an `(app)` group so public pages load no auth code.

**Key decision:** ISR plus on-demand revalidation instead of rendering every request: during a sale spike everyone gets the cached HTML and the API isn't touched, while an organizer's edit still appears in well under a second. Availability on that cached page is only a hint; booking checks live stock.
**Verify:** `pnpm test`, then `pnpm build && pnpm --filter @festpass/web start` with the API running, open http://localhost:3000/e/mait-alumni-meet-2026, view source, and edit the event in the dashboard: the public page changes on the next reload.
**Next:** Day 11 starts the booking engine: holding tickets with a single conditional `UPDATE` in Postgres.

### Day 11: Booking engine I: Postgres correctness (2026-11-09)
**Built:**
- `POST /events/:eventId/orders` with a required `Idempotency-Key`: holds tickets in a `PENDING` order that expires after `HOLD_MINUTES` (10), after checking the event is published and on sale.
- `packages/db/src/booking.ts`: one raw-SQL transaction with a per-(user, event) advisory lock, the per-user limit check, a conditional `UPDATE` per tier in tier-ID order, and the order with its items.
- An `idempotency_keys` table: the answer (201 or 409) is stored in the same transaction as the order and replayed for retries; the same key with a different body is a 422.
- Concurrency tests through the HTTP API: 200 buyers for 10 tickets, one buyer racing themselves, opposite lock orders, and idempotent retries.

**Key decision:** a single conditional `UPDATE ... WHERE sold_count + qty <= capacity` instead of reading the count and then writing, so the database decides who gets the last ticket under the row lock, with no read-then-write gap; tier rows are always locked in ID order so multi-tier orders can't deadlock.
**Verify:** `pnpm --filter @festpass/api exec vitest run test/orders.test.ts` (5 times in a row: 10 × 201 and 190 × SOLD_OUT every time), then `pnpm test`.
**Next:** Day 12 puts a Redis gate in front of Postgres so most of a flash-sale crowd is turned away before touching the database.

### Day 12: Booking engine II: the Redis gate (2026-11-10)
**Built:**
- A Lua `reserve` script checks stock (`inv:{tierId}`) and the per-user limit (`usr:...`) for every item and takes all or none; a `release` script gives stock back when Postgres doesn't book (compensation).
- Order flow: replay check, on-sale checks, Redis gate, then the Day 11 Postgres transaction. If Redis fails or takes over 50 ms, the gate is skipped and Postgres alone decides.
- `reconcileInventory()` sets `inv:*` from Postgres after publishing and tier changes, and every minute from a BullMQ job in the worker (its first real job), logging any drift it fixes.
- Counters of refusals at the gate vs at Postgres, logged every minute; the booking suite runs with Redis working, failing and hanging.

**Key decision:** Redis is only a gate that can say no early, never the source of truth: every yes is decided again by the conditional `UPDATE` in Postgres, Redis numbers are reset from Postgres, and losing Redis only costs speed.
**Verify:** `pnpm --filter @festpass/api exec vitest run test/orders.test.ts` (47 tests: the booking suite in three Redis modes plus the gate tests), `pnpm test`, and `pnpm --filter @festpass/worker dev` to see the reconciliation job run.
**Next:** Day 13 expires unpaid holds with delayed BullMQ jobs and gives their tickets back in both Postgres and Redis.

<!-- BUILD-LOG:END -->

## License

MIT
