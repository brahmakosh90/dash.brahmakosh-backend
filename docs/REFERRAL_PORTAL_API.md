# Brahmakosh Referral Partner Portal — API Documentation

Base URL: `{API_HOST}/api/referral` (e.g. `http://localhost:5000/api/referral`)
Frontend: `frontend/src/portal` · Routes: `/partner-portal/*` (partners) and `/partner-portal/admin/*` (staff).

The module is self-contained. It adds its own collections (`referral*`), middleware (`middleware/referralAuth.js`) and routes
(`routes/referral/`). The only existing file it touches is `app.js` (one import and one `app.use`). Existing models, auth and routes are only
read, never modified.

---

## 1. Conventions

| Item | Value |
| --- | --- |
| Format | JSON, `Content-Type: application/json` |
| Success | `{ "success": true, "data": { ... } }` |
| Failure | `{ "success": false, "message": "…", "code"?: "…" }` |
| Auth header | `Authorization: Bearer <token>` |
| Money | USD, plain numbers (e.g. `1`, `50.5`) |
| Dates | `YYYY-MM-DD` strings (server local date); timestamps in audit logs are ISO |
| Rate limits | auth routes 30 / 15 min per IP · public tracking routes 60 / min per IP |

Common status codes: `400` validation · `401` missing/invalid token · `403` no permission or partner not approved · `404` not found ·
`409` conflict (duplicate, or action not allowed in the current state) · `410` expired / inactive referral · `429` rate limited.

### Business rules
| Rule | Value |
| --- | --- |
| Commission | `$1` per eligible registration (campaigns may carry a different rate, `$0.01–$5`) |
| Eligibility | verified attributed install **and** completed registration, subject to fraud checks |
| Attribution window | 30 days from the referral click |
| Fraud hold | 7 days before a pending commission can be approved |
| Minimum withdrawal | `$50` approved payable balance |
| Payouts | manual bank transfer, approved and reconciled by Finance |
| Activation | partners and campaigns need admin approval |
| Leaderboard | spiritual-impact ranking is independent from cash commission |

### Tokens
| Token role | Issued by | Lifetime | Used for |
| --- | --- | --- | --- |
| `referral_partner` | `/auth/register`, `/auth/login` | 7 days | `/partner/*` |
| `referral_staff` | `/auth/admin/login` | 12 hours | `/admin/*` |
| app `user` | existing app login | existing | `/track/register` |

---

## 2. Authentication

### `POST /auth/register` — partner application
Body: `name`, `email`, `password` (≥ 8), `country` and `city` are required; optional `org`, `phone`, `state`, `bio` (≤ 600).
`201` → `{ token, partner }`. The partner is `pending` until approved. `409` if the email exists.

### `POST /auth/login` — partner sign-in
Body: `email`, `password`. `200` → `{ token, partner }`. `401` on bad credentials.

### `GET /auth/me` *(partner token)* → `{ partner }`

### `POST /auth/admin/login` — staff sign-in
Body: `email`, `password`. `200` → `{ token, staff: { name, email, role, roleLabel } }`.
Accepts (a) referral team accounts created in the portal, and (b) existing platform `Admin` / `Super Admin` accounts
(`super_admin` → Super Admin, `admin` → Operations Admin). `401` bad credentials/inactive, `403`-equivalent for unapproved admins returns `401`.

### `GET /auth/admin/me` *(staff token)* → `{ staff }`

**Partner object**
```json
{ "id": "…", "name": "Aarav Mehta", "org": "Mindful Mornings", "email": "…", "phone": "…", "country": "India", "state": "Madhya Pradesh", "city": "Indore", "bio": "…",
  "status": "pending|approved|rejected|suspended", "reviewNote": "reason given by staff on reject/suspend", "tier": "Bronze", "code": "BRAHM-AARAV24", "link": "https://brahmakosh.com/r/BRAHM-AARAV24",
  "joinedAt": "2026-01-10", "appliedAt": "2026-01-02", "initials": "AM" }
```
`code` and `link` are `null` until the partner is approved.

---

## 3. Attribution (public + app)

Flow: **click → install → register**. The app/website calls these endpoints; partners never do.

### `GET /r/:code?ch=<channel>` — referral click *(public)*
`:code` is a partner code or a campaign code. `ch` ∈ `WhatsApp | Instagram | YouTube | Telegram | Facebook | Direct link | Email`.
Counts a verified click and issues a signed **click token** valid for 30 days.
- If `REFERRAL_STORE_URL` is set → `302` redirect to `{store}?referrer=<token>` (an inactive code redirects to the store without a token, so the download is never blocked).
- Otherwise → `200 { clickToken, campaign: { name, code } }`.
- Errors: `404 unknown_code` · `410 partner_inactive | campaign_inactive | campaign_limit_reached`.

### `POST /track/install` *(public)* — first app launch
Body: `clickToken` (required), `deviceId`, `device` (`Android|iOS`), `country` (ISO-2).
`201` → `{ installId, duplicate }`. The same `deviceId` installing the same campaign twice returns the original `installId` with `duplicate: true` and is not counted again.
Errors: `400 invalid_token` · `410 window_expired | partner_inactive`.

### `POST /track/register` *(app user token)* — completed registration
Call once, right after the new user signs up. Body — one of:
- `installId` (from `/track/install`), or
- `clickToken` (when no install call was made), or
- `referralCode` (user typed a code; no click date, counts from today),

plus optional `deviceId`.
`201` → `{ attributed: true, status: "in_review" | "rejected", duplicate? }`.

Server-side checks (in order): signed-in user is an app `user` · sign-up is ≤ 48 h old · partner approved · campaign active and inside its dates ·
30-day window · campaign limit not reached. Then fraud checks:

| Check | Result |
| --- | --- |
| User email/phone equals the partner's | `rejected` — *Self-referral blocked* |
| Device already used by another registered referral | `rejected` — *Duplicate device detected* |
| Same user attributed twice | returns the existing result (`duplicate: true`) |

Rejected registrations are stored (visible to staff, commission `rejected`). Three automatic rejections of one kind for a partner in a day open a fraud flag.
Otherwise a `pending` commission is created; it becomes payable only after staff approval (see §5).
Errors: `400 invalid` · `403 forbidden` · `404 install_not_found` · `410 signup_too_old | window_expired | campaign_inactive | partner_inactive | campaign_limit_reached`.

---

## 4. Partner API *(partner token, approved partners only)*

Pending/rejected/suspended partners receive `403` with `code: partner_pending | partner_rejected | partner_suspended`, except `GET /partner/profile`.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/partner/profile` | Own profile and approval status |
| PATCH | `/partner/profile` | Update `name, org, phone, country, state, city, bio` |
| GET | `/partner/bootstrap` | Everything the dashboard needs (below) |
| GET | `/partner/leaderboard?period=7\|30\|all` | Spiritual-impact ranking |
| POST | `/partner/withdrawals` | Request a withdrawal |
| PUT | `/partner/payout` | Save payout (bank) details |
| POST | `/partner/campaigns` | Request a campaign (needs admin approval) |
| POST | `/partner/tickets` | Open a support ticket |
| POST | `/partner/password` | Change own password `{ current, next }` (also allowed while an application is pending) |

### `GET /partner/bootstrap`
Returns `rules, partner, payout, wallet, totals, campaignTotals, campaigns, series, referrals, commissions, withdrawals, tickets`.
- `wallet`: `{ pending, approved, paid, rejected, reversed, reserved, payable, approvedTotal, lifetime }` — derived from the ledger; `payable = approved − reserved`.
- `totals`: lifetime `{ clicks, installs, regs }`. `series`: daily rows `{ campaignId, date, clicks, installs, regs }` for the last 90 days.
- `referrals`: anonymized records of the last 90 days (max 4000): `{ id, campaignId, anon, channel, device, country, clickAt, installAt, regAt, status: installed|registered, eligibility: awaiting|in_review|eligible|rejected|reversed, reason }`. No personal data is exposed.
- `commissions`: ledger rows of the last 90 days (max 6000): `{ id, refId, anon, campaignId, date, amount, status: pending|approved|paid|rejected|reversed, reason }`.
- `campaigns[]`: `{ id, name, code, general, start, end, status, approval, rate, cap, channelFocus }`. `status` ∈ `pending_approval | active | scheduled | paused | expired | revoked` (`active/scheduled/expired` follow the dates).
- `withdrawals[]`: `{ id: "WD-1001", amount, status, reference, reason, approvedBy, history: [{ at, label }], requestedAt }`.

### `POST /partner/withdrawals`  `{ "amount": 120 }`
`201` → `{ withdrawal }`. Validations: amount ≥ $50 · ≤ payable balance · payout details **verified** · only one `pending` request at a time (`409`).
The amount is reserved immediately. Balance is re-checked after reserving, so concurrent requests cannot overdraw.

### `PUT /partner/payout`
Body: `holder`, `bank`, `account` (8–18 digits), `code` (IFSC/SWIFT, 6–15 alphanumeric), `country`.
`200` → `{ payout }` with `status: pending_verification`. The account number is stored AES-256-GCM encrypted; only the last 4 digits are ever returned.
Withdrawals are blocked until Finance verifies the details.

### `POST /partner/campaigns`
Body: `name` (≥ 4), `code` (4–14 alphanumeric, unique), `start`, `end` (`end > start`), `cap` (≥ 50), `channel`.
`201` → `{ campaign }` with `status: pending_approval`.

### `POST /partner/password`  `{ current, next }`
`next` ≥ 8 characters and different from `current`; `400` if the current password is wrong.

### `POST /partner/tickets`  `{ subject (≥5), category, message (≥15) }` → `201 { ticket }`

### `GET /partner/leaderboard`
`{ rows: [{ rank, partner: { id, name, org, initials }, users, first, active, sessions, minutes, ret7, ret30, score }], me }`.
`score = active × 4 + first × 2 + sessions × 0.5 + minutes/60 + ret30 × 2`.

---

## 5. Admin API *(staff token)*

Every route needs a valid staff token. Mutations also need a permission (table in §6); missing permission → `403`.
All mutations are written to the audit log.

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/admin/session` | any staff | Current staff member, permissions, rules |
| POST | `/admin/password` | any staff | Change own password `{ current, next }` — referral team accounts only; platform admins change theirs in the main admin console |
| GET | `/admin/overview` | any staff | KPIs, 30-day series, queues, top partners |
| GET | `/admin/partners` | any staff | All partners with performance and wallet |
| POST | `/admin/partners/:id/status` | `partners.review` | `{ status: approved \| rejected \| suspended, note }` — `note` (≥ 5 chars) is required for reject/suspend and is shown to the partner |
| POST | `/admin/partners/:id/payout/:decision` | `withdrawals.approve` | `decision`: `verify` \| `reject` |
| GET | `/admin/campaigns` | any staff | Non-general campaigns with totals |
| POST | `/admin/campaigns` | `campaigns.manage` | Create an already-approved campaign |
| POST | `/admin/campaigns/:id/:action` | `campaigns.manage` | `approve \| reject \| pause \| resume \| revoke` |
| GET | `/admin/commissions` | any staff | `?status&partner&q&page&limit` (limit ≤ 100) |
| POST | `/admin/commissions/review` | `commissions.approve` | Approve / reject / reverse |
| GET | `/admin/withdrawals` | any staff | Requests plus payout details awaiting verification |
| POST | `/admin/withdrawals/:id/:action` | see below | `approve \| process \| paid \| reject` |
| GET | `/admin/reports?days=7\|30\|90` | `reports.view` | Partner and campaign performance |
| GET | `/admin/fraud` | any staff | Flags and counters |
| POST | `/admin/fraud/:id/resolve` | `fraud.review` | `under_review \| confirmed \| dismissed` |
| GET | `/admin/roles` | any staff | Permission matrix, labels, team members |
| PUT | `/admin/roles/:role/permissions` | `roles.manage` | `{ permission, enabled }` (not for Super Admin) |
| POST | `/admin/staff` | `roles.manage` | Add team member `{ name, email, password ≥ 8, role }` |
| PATCH | `/admin/staff/:id` | `roles.manage` | `{ role?, isActive? }` (not yourself) |
| GET | `/admin/audit` | `audit.view` | `?q&role&page&limit` |

### Partner status transitions
`pending → approved | rejected` · `approved → suspended` · `suspended → approved`. Anything else → `409`.
Approving creates the partner's code and permanent direct-link campaign and clears any earlier reason. Rejecting or suspending needs a reason, which is stored on the partner (`reviewNote`), shown on their status screen and written to the audit log. Suspending also pauses their active campaigns.

### Campaign actions
`approve` (from `pending_approval`) · `reject` (from `pending_approval`) · `pause` (from `active|scheduled`) · `resume` (from `paused`) · `revoke` (from `active|scheduled|paused`).

### `POST /admin/commissions/review`
Body: `action` (`approve|reject|reverse`), `reason` (required for reject/reverse, ≥ 4), and **either** `ids: [..]` (≤ 1000) **or** `holdCleared: true` (+ optional `partner`) to act on every pending commission older than the hold.
Response `{ processed, skipped }`.
- `approve` only affects `pending` commissions older than 7 days (younger ones are skipped).
- `reverse` only affects `approved` commissions and never reverses money already reserved for an open withdrawal.

### Withdrawal workflow
`pending → approved → processing → paid`, or `rejected` from `pending|approved`.

| Action | Permission | From → To | Body |
| --- | --- | --- | --- |
| `approve` | `withdrawals.approve` | pending → approved | — |
| `process` | `withdrawals.reconcile` | approved → processing | — |
| `paid` | `withdrawals.reconcile` | processing → paid | `reference` (8–30 chars, unique) |
| `reject` | `withdrawals.approve` | pending/approved → rejected | `reason` (≥ 5) |

Transitions are conditional updates: a stale or double click returns `409` instead of advancing twice. On `paid`, the oldest approved commissions covering the amount are marked `paid`.

### `POST /admin/fraud/:id/resolve`
Body: `status`, `note` (≥ 5 unless `under_review`), `suspend` (boolean, `confirmed` only, needs `partners.review`).
`confirmed` reverses up to `related` pending commissions of that partner. Response `{ reversed }`.

---

## 6. Roles & permissions

| Permission | Super Admin | Ops Admin | Finance | Fraud Analyst | Support |
| --- | :-: | :-: | :-: | :-: | :-: |
| `partners.review` | ✓ | ✓ | | ✓ | |
| `campaigns.manage` | ✓ | ✓ | | | |
| `commissions.approve` | ✓ | ✓ | ✓ | | |
| `withdrawals.approve` | ✓ | | ✓ | | |
| `withdrawals.reconcile` | ✓ | | ✓ | | |
| `fraud.review` | ✓ | | | ✓ | |
| `reports.view` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `roles.manage` | ✓ | | | | |
| `audit.view` | ✓ | ✓ | ✓ | ✓ | |

Defaults shown; a Super Admin can change every role except Super Admin itself via `PUT /admin/roles/:role/permissions`.

---

## 7. Data model (collections)

| Collection | Purpose |
| --- | --- |
| `referralpartners` | Partner accounts, status, code, encrypted payout details |
| `referralstaffs` | Referral team accounts (role, active flag) |
| `referralcampaigns` | Campaigns and each partner's direct link (`general: true`) |
| `referraldailystats` | Verified clicks / installs / registrations per campaign per day |
| `referralrecords` | One anonymized row per install/registration (device hash and app user id are internal only) |
| `referralcommissions` | Commission ledger — one per referral (`recordId` unique) |
| `referralwithdrawals` | Withdrawal requests with status history |
| `referralfraudflags` | Fraud flags |
| `referraltickets` | Partner support tickets |
| `referralaudits` | Append-only audit log |
| `referralroleconfigs` | Permission overrides per role |
| `referralcounters` | Human-readable sequences (`WD-…`, `TK-…`, `FR-…`) |

Integrity guarantees: unique commission per referral · one attributed registration per app user · one open `pending` withdrawal per partner (partial unique index) ·
wallet derived from the ledger (no stored balance) · conditional state transitions.

---

## 8. Background job

`services/referral/impactSync.js` runs nightly at 02:30 and copies verified spiritual activity (`SpiritualSession`, status `completed`) onto referral records:
`sessions`, `minutes`, `firstActivity`, `activeNow` (a session in the last 14 days). It only reads existing app data.

---

## 9. Configuration

| Env var | Required | Purpose |
| --- | --- | --- |
| `JWT_SECRET` | yes (already used by the platform) | Signs partner, staff and click tokens |
| `REFERRAL_PAYOUT_KEY` | recommended | Encrypts payout account numbers; defaults to a `JWT_SECRET`-derived key |
| `REFERRAL_LINK_BASE` | no | Public link prefix shown to partners, default `https://brahmakosh.com/r` |
| `REFERRAL_STORE_URL` | no | App-store URL for `/r/:code` redirects (Play Store `referrer` param is appended) |
| `VITE_API_URL` | frontend | API base used by the portal (`…/api`) |

### Getting started in a new environment
1. Deploy; the first staff sign-in can use an existing platform **Super Admin** account at `/partner-portal/admin/login`.
2. Open **Roles & Access → Add member** to create Finance / Fraud / Support / Ops accounts.
3. Partners apply at `/partner-portal/register`; approve them under **Partners**.
4. Point the public link `https://brahmakosh.com/r/<code>` at `GET /api/referral/r/<code>` (reverse-proxy rule), and have the app call `/track/install` and `/track/register` as described in §3.

---

## 10. Security notes
- Partner, staff and app tokens are separate roles; a token of one kind is rejected on the other's routes.
- Passwords are bcrypt-hashed; login and registration are rate limited; deactivated staff are locked out immediately (checked on every request).
- Payout account numbers are encrypted at rest and never returned; referred users are anonymized in all partner-facing data.
- Staff role changes, approvals, payouts and fraud decisions are audit-logged with actor, role and IP.
