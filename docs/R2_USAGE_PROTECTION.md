# R2 usage protection

Readlay checks R2 usage before each application-controlled storage request. This reduces the risk of exceeding the allowance. It is not a Cloudflare spending cap and cannot guarantee zero charges.

## Limits and counters

| Resource | Default safety limit | Action at the limit |
| --- | --- | --- |
| Protected storage | 9,000,000,000 bytes, or 9 decimal GB | Reject a PUT whose reserved bytes would reach or exceed the limit |
| Class A requests | 800,000 | Stop uploads and inventory lists |
| Class B requests | 8,000,000 | Stop R2 playback, HEAD requests and upload verification reads |

Warnings begin at 80% of each safety limit. The administrator can lower or raise the limits within server-enforced bounds. Storage cannot exceed 9 GB, Class A must remain below 1 million and Class B below 10 million. There are separate switches for uploads, each operation class and all Readlay R2 requests.

The stated Cloudflare free allowance applies to Standard storage: 10 GB-month, 1 million Class A and 10 million Class B requests. Storage billing uses daily peaks over the billing period, rather than just today's object total. Check [Cloudflare's current pricing](https://developers.cloudflare.com/r2/pricing/) before changing the configuration.

Cloudflare's account-level GraphQL analytics supply the calendar month's Class A/B counts and a separate 31-day operation window. The protective window avoids assuming that an invoice resets on the first day of the calendar month. No bucket filter is used for operations, so other buckets consume the same budget. Unknown operation names, incomplete responses and stale storage data are rejected, rather than treated as zero usage.

Class A includes PUT and LIST; Class B includes GET, HEAD and usage queries. Readlay adds its recent reserved requests to the reported 31-day totals. Reservations from months overlapping the 31-day window are retained, including the whole first overlapping month. These counts deliberately overlap and may pause requests earlier than the Cloudflare dashboard would suggest. Failed, interrupted and uncertain requests are not refunded automatically. Cloudflare analytics can be delayed or sampled, so these are protective counters, not an invoice calculation.

Cloudflare Analytics also reports the dashboard reads `GetBucketNotificationConfiguration` and `GetBucketSippyConfiguration`. The published pricing list does not give these an explicit class. Readlay conservatively adds each to both safety budgets. This is a protective overcount, not a claim about their billing classification. Other unrecognised operation names still pause requests pending review. Successful GraphQL responses may contain `errors: null` or an empty error list; actual or malformed errors remain blocked.

## Storage and concurrent uploads

The protected storage total includes account-wide reported payload and metadata, an exact complete inventory of the Readlay bucket, other buckets' reported storage, and outstanding upload reservations. Recent per-bucket peaks make the estimate conservative. Each inventory page is a quota-checked Class A request.

Before a PUT, a Supabase function locks the single configuration row, checks the current observation and limits, reserves the object's full byte length and increments the request count in one transaction. Concurrent uploads cannot each spend the same remaining space. Immutable object keys cannot change their reserved byte lengths.

A failed or uncertain PUT keeps its reservation. A complete later inventory can mark matching key/size reservations as observed. Writes started during the refresh retain their reservations until another complete inventory. Missing objects, mismatched sizes, incomplete pages and failed inventories cannot release reservations. An uncertain reservation for an object that never arrived can therefore hold space indefinitely. Review it manually with uploads paused and all in-flight requests finished; do not delete a reservation merely because one request timed out.

Unfinished multipart uploads block new uploads. Readlay does not create multipart uploads, change storage tiers or delete files. New source and audiobook PUTs explicitly use `STANDARD`, `If-None-Match: *` and SHA256 readback verification.

## Existing access paths

- Website R2 audio passes through `/api/audio/[bookId]/stream`. Each authenticated GET, range GET and HEAD requires an atomic Class B reservation. Invalid ranges are rejected before reaching R2. Each signed-in account also has a per-minute request limit.
- The website no longer issues R2 signed playback URLs. Supabase publications keep their existing independent backend.
- `scripts/upload_audiobook.py` and optional `scripts/upload_book.py` use the same Supabase quota service before each S3 request. The preparation computer must have the existing server-only Supabase URL/key as well as its R2 upload credentials. A service-only RPC is the server-side authorisation boundary for these trusted operator scripts.
- S3 clients have automatic retries disabled. A manual retry needs a new reservation. Local narration generation and dry-run validation do not contact R2 or consume its quota.
- No browser upload credentials or reusable PUT URLs are issued. There is no anonymous EPUB or audio upload route.

Keep the R2 bucket private. Disable r2.dev access and public custom domains. Review Workers bindings, Sippy, Super Slurper, lifecycle rules, other clients and other credentials. Prefer a bucket-scoped read-only runtime key and a separate upload key on the preparation computer. Existing credentials are not silently rotated or deleted by this feature.

Direct S3 clients and any holder of a valid R2 key can bypass Readlay. A Supabase service key is also privileged and must remain private. CORS restricts browser reads but is not an access or billing control. Old signed URLs can still be replayed until expiry, up to 24 hours for the previous Readlay implementation; deploying this release does not revoke them. Revoke or rotate their signing key through Cloudflare if earlier invalidation is required, then update the appropriate server configuration.

Analytics can reveal external usage only after it is reported. Readlay cannot stop an external client, public bucket, Worker or leaked credential from continuing to consume R2 after the app pauses. Infrequent Access storage, retrieval charges, minimum durations, other Cloudflare services and Vercel's streaming usage are outside the stated Standard-storage allowance. Check Cloudflare's own usage/billing pages and configure its available billing notifications separately. Notifications are not hard caps.

## Supabase setup

The versioned schema is under `supabase/migrations/`, separate from the existing Neon reading-progress migrations in `db/migrations/`. Apply it to the existing Supabase project. Do not run it against the reading-progress database.

The four quota tables have RLS enabled. Ordinary `anon` and `authenticated` roles have no table privileges or function execution privileges. Functions use `SECURITY INVOKER` with an empty search path, and explicitly grant execution to `service_role` only. The service role already bypasses RLS. The informational [RLS without policies notice](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) is therefore an intentional deny-by-default configuration, not an instruction to grant reader access.

The tables store configuration, monthly aggregate counters, pending immutable object sizes and short per-account read-rate counters. They contain no R2 secrets, book text or audio bytes. The binding to the configured R2 account and bucket is set once; a mismatched environment fails closed. Settings updates use a version check so one admin session cannot silently replace another session's changes.

## Server configuration and admin access

Keep these values server-side and out of Git:

```dotenv
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
R2_ACCOUNT_ID=
R2_AUDIO_BUCKET=readlay-audio
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
CLOUDFLARE_R2_ANALYTICS_TOKEN=
READLAY_ADMIN_GITHUB_IDS=
CRON_SECRET=
```

The Analytics token needs only Account → Account Analytics → Read, restricted to the relevant account. It is separate from an R2 S3 key. Admin IDs are stable numeric GitHub account IDs, separated by commas, not logins, names or emails. If no IDs are configured, no user is an administrator. The server rechecks the ID for every admin API call. Mutation endpoints also require the same request origin and a bounded JSON body.

Prepare only the new local fields, keeping existing values:

```powershell
node scripts/audio/configure_r2_protection.mjs --initialise --admin-id <your-numeric-GitHub-ID>
# Add the read-only Analytics token to ignored .env.local, then:
node scripts/audio/configure_r2_protection.mjs --check
node scripts/audio/configure_r2_protection.mjs --upload
```

The upload helper sends only the three protection fields to the existing Readlay Vercel production project. Values use standard input, are marked sensitive and are not printed. It does not retrieve the production environment or change unrelated credentials. The existing Supabase and R2 credentials must already be present on the server. Redeploy separately.

If the Analytics token is still pending, `--upload-paused` can publish only the admin IDs and cron secret. The initial quota service has no verified usage, so R2 playback and uploads remain blocked. This mode does not invent observations, relax limits or enable unmetered traffic. Add the token and use `--upload`, redeploy and refresh real usage to finish activation.

Open `/admin/r2` using the allowed GitHub account. It shows reported/reserved/protected totals, monthly statistics, dates, warnings and the safety controls. Refresh usage after configuration. A refresh is limited to once every five minutes and uses a database lease to avoid overlapping inventories.

`vercel.json` also schedules a daily refresh at `0 1 * * *`. Vercel authenticates it with the server-only `CRON_SECRET`. The 26-hour observation lifetime accommodates the [Hobby plan's daily schedule and hourly timing precision](https://vercel.com/docs/cron-jobs/usage-and-pricing). A missed refresh, missing token, failed Analytics request or Supabase outage pauses new requests once usage cannot be verified. A failed inventory blocks uploads while leaving a separately verified read budget usable. The GraphQL monitoring request itself is not an R2 S3 operation, so it can continue reporting usage after an operation budget is exhausted.

At a calendar-month rollover, a new observation is required before requests resume. The daily Hobby job can run later than midnight; the administrator can refresh earlier. Supabase and Vercel also have their own resource limits. This feature adds no paid plan and does not treat their allowances as unlimited.

Do not publish a release as fully configured until a real account observation, complete bucket inventory, admin authorisation, private playback and denied-request checks pass. Do not seed production with invented zero usage.

## Verification

The tests cover real PostgreSQL reservations, concurrent storage/operation limits, rollover protection, role isolation, stale/failed observations, in-flight inventories, settings conflicts, signed-URL refusal, protected audio ranges, retries and uploader authorisation. Test database contents are isolated from production. Live checks must keep existing files and reader progress unchanged.
