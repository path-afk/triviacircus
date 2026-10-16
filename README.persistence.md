# Trivia Circus — Persistence, Cookies & Privacy

## Overview

Trivia Circus uses **cookie-based guest profiles** to remember each player across
sessions without requiring any account, email, or login.

---

## How it works

### First visit
- The server generates a 32-byte random opaque token (64 hex chars) and sends it
  as an `HttpOnly`, `SameSite=Lax`, `Path=/`, 1-year cookie named `tc_guest`.
- The raw token **never leaves the server's response** — only the hashed value
  (SHA-256) is stored in SQLite.
- A guest profile is created automatically with a generated "Adjective Animal" name
  (e.g. "Lying Seahorse"). No personal data is collected.

### Returning visits
- The same browser sends the cookie on each request; the server looks up the
  SHA-256 hash and loads the existing profile.
- Identity, display name, and lifetime score are all preserved across:
  - Page refresh
  - Disconnect / reconnect
  - Full server restart (data is persisted in SQLite)

### Different browsers / devices
- Each browser has its own cookie → distinct guest profile.
- There is no sync across devices (by design, no SSO in this version).

### If cookies are blocked
- The lobby page shows a warning: "Cookies appear to be blocked."
- The player can still play but progress will not be saved across visits.
- A future Apple/Google Sign-In feature can claim and merge a guest profile;
  the schema includes a `token_hash` column that SSO can replace.

---

## Cookie attributes

| Attribute | Value |
|---|---|
| Name | `tc_guest` |
| Value | 64-char hex string (32 bytes of CSPRNG) |
| HttpOnly | ✅ — JS cannot read the token |
| SameSite | Lax |
| Path | / |
| MaxAge | 365 days (1 year) |
| Secure | Set in `NODE_ENV=production` |

---

## What is stored

### SQLite: `data/trivia.db`

**`profiles` table**

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | Auto-increment |
| token_hash | TEXT UNIQUE | SHA-256 of the raw cookie token |
| display_name | TEXT | Auto-generated "Adjective Animal" |
| custom_name | TEXT | Optional player-set name (null if not set) |
| lifetime_score | INTEGER | Running total, updated atomically |
| correct_answers | INTEGER | Running correct count |
| created_at | INTEGER | Unix timestamp |

**`score_events` table**

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| profile_id | INTEGER FK | References profiles(id) |
| round_id | TEXT | UUID per question round |
| points | INTEGER | Earned (or negative for Double Down loss) |
| correct | INTEGER | 0 or 1 |
| created_at | INTEGER | Unix timestamp |
| UNIQUE(profile_id, round_id) | | **Idempotency key** — replay cannot double-credit |

### What is NOT stored
- IP address
- User agent string
- Email or any PII
- Free-text chat (there is no chat)
- The raw cookie token (only its SHA-256 hash)

---

## Data directory and SQLite path

Default: `<project-root>/data/trivia.db`

Override with the `TC_DATA_DIR` environment variable:
```bash
TC_DATA_DIR=/var/data/trivia node server.js
```

The `data/` directory is in `.gitignore` — live player data is never committed.

---

## Schema migrations

Migrations are tracked in the `schema_migrations` table. On startup,
`lib/db.js` checks the current version and runs any missing migrations in order.
The current schema is version 1.

To add a future migration, append an `if (current < N)` block in `migrate()`.

---

## Backup and restore

```bash
# Backup
cp data/trivia.db data/trivia.db.bak-$(date +%Y%m%d)

# Restore
cp data/trivia.db.bak-YYYYMMDD data/trivia.db
```

WAL mode (`PRAGMA journal_mode=WAL`) is enabled; back up the `-shm` and
`-wal` sidecar files too if the server is running:
```bash
sqlite3 data/trivia.db ".backup data/trivia-backup.db"
```

---

## Production durability — IMPORTANT

**SQLite must not live on ephemeral storage in production.**

Railway, Render, Fly, and similar platforms may wipe the filesystem on redeploy
unless you attach a persistent volume. Without a persistent volume, all player
profiles and scores are lost on every deploy.

Options:
1. **Persistent volume** (Railway, Fly) — attach a volume at the `TC_DATA_DIR` path.
2. **Postgres adapter** (future) — replace `lib/db.js` with a `pg`-backed
   implementation; the interface is the same.

Do not deploy to production without confirming durable storage first.

---

## API endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/profile` | Cookie | Current player's profile + rank |
| POST | `/api/profile/rename` | Cookie | Regenerate display name (rate-limited 5 s) |
| GET | `/api/leaderboard` | None | Top 25 all-time, ranked |

### Socket.IO events emitted by server

| Event | When | Payload |
|---|---|---|
| `circus_profile` | On `join` | `{ id, display_name, custom_name, effective_name, lifetime_score, correct_answers }` |
| `circus_leaderboard` | On `join` and after each scored round | `{ leaderboard: [ { rank, id, display_name, effective_name, lifetime_score, correct_answers } ] }` |

---

## Name generation

Names are drawn from two word lists in `lib/names.js`:
- 107 adjectives × 88 animals = **9,416 unique combinations**
- All words are carefully selected to be inoffensive and Title Case
- "Lying Seahorse" is a valid example

A player can regenerate their name at any time from the lobby. Regenerating
the display name **never resets score or correct-answer totals**.

---

## Future: SSO account claim

The schema is designed for future Apple/Google Sign-In:
1. OAuth flow completes → server gets a stable SSO user ID
2. Server looks up the guest profile by cookie token hash
3. Server writes the SSO user ID to a new `sso_id` column on the profile
4. Future logins use the SSO token instead of the cookie token
5. The guest profile (score, name, history) is preserved

No SSO code is present in this version.
