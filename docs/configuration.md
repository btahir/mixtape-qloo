# Configuration

All application settings are server-only. Copy `.env.example` to ignored `.env.local`; never commit credentials, real provider payloads, live manifests or response caches. Empty optional settings use defaults. `NODE_ENV` and `PORT` are set by the runtime; leave those lines out of your local file unless overriding them deliberately.

## Providers and limits

| Names | Meaning |
| --- | --- |
| `QLOO_API_KEY`, `QLOO_MODE` | A key enables live drafts; `fixture` explicitly selects offline examples. |
| `QLOO_ORIGIN` | Optional; only `https://hackathon.api.qloo.com` is accepted. |
| `QLOO_EVENT_ACCESS_CONFIRMED`, `QLOO_ACCESS_EXPIRES_AT` | Set the flag to `true` only after confirming access, and the actual expiry as an ISO timestamp. |
| `QLOO_ALLOCATION_CONFIRMED`, `QLOO_DAILY_ATTEMPTS`, `QLOO_TOTAL_ATTEMPTS` | Public serving needs a confirmed allocation and positive integer caps, at most 250/day and 2,500 total. Account for prior use, other applications sharing the key and a judging reserve. Local defaults are 150/day and 150 total. Public starts are paced to two/second; allocate other consumers accordingly. |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Direct Anthropic access; model defaults to `claude-haiku-5-5`. |
| `MIXTAPE_AGENT_MODE` | Defaults to `anthropic`; `deterministic` is an explicit labelled outage fallback. Fixture drafts never call providers. |
| `MODEL_DAILY_CAP_USD`, `MODEL_TOTAL_CAP_USD` | Defaults: $3/day and $25 total. Overrides can lower these caps; zero disables paid runs. Each run reserves up to $0.02; unknown usage retains the reservation. |
| `MODEL_COST_BOUND_CONFIRMED`, `MODEL_POLICY_MODEL`, `MODEL_BYTE_TOKEN_BOUND_CONFIRMED`, `MODEL_INPUT_USD_PER_MILLION`, `MODEL_OUTPUT_USD_PER_MILLION` | Only for a custom model: both confirmation flags must be `true`, the policy model must match, and prices/token bounds must be verified. Default Haiku has a built-in policy. |
| `PAUSE_GENERATION` | `true` stops preparation and repair; saved links remain readable. |

## Hosting and storage

| Names | Meaning |
| --- | --- |
| `APP_ORIGIN` | Canonical HTTPS origin, without a trailing slash, for public serving. |
| `SESSION_SECRET` | Stable random secret, at least 32 characters. Losing it loses editing access. |
| `PUBLIC_DEMO` | `true` enables hosted checks. `TIFFIN_URL` or `TIFFIN_PROJECT` also identifies hosted operation. |
| `INGRESS_VERIFIED`, `TRUST_PROXY_IP` | Set both to `true` only after proving the proxy overwrites incoming `x-forwarded-for` with one valid client IP. App flags cannot verify the proxy. |
| `REDIS_URL`, `VALKEY_PREFIX` | Read by `@shiptiffin/sdk/kv` for the project’s durable store and scoped cache. Hosted operation requires Valkey. |
| `DATABASE_URL` | Recognized as configured infrastructure; this app needs no SQL tables. If it is present without Valkey, storage fails closed rather than using disposable memory. |
| `REQUIRE_REDIS` | `true` requires Valkey even locally. Without infrastructure, local development uses memory. |

## Live starters and browser checks

The public repo contains synthetic fixtures. Real starter identities must be reviewed and hydrated separately. `scripts/prepare-live.test.ts` documents the reviewed audit input contract. Its opt-in `MIXTAPE_PREPARE_LIVE` flag, `QLOO_REVIEWED_INPUT`, `QLOO_DEV_CACHE_DIR` and `QLOO_SAMPLE_DIR` produce three validated manifests and five frozen comparison records. The default manifest directory is ignored `live-samples/`. The development disk cache is local-only and rejected on public servers.

To install reviewed records, supply `REDIS_URL`, `VALKEY_PREFIX`, provider/access settings and `QLOO_SAMPLE_DIR`, leave `QLOO_DEV_CACHE_DIR` unset, set `MIXTAPE_INSTALL_LIVE=true`, and run `bun run install:live`. The installer validates and warms all three starters before atomically publishing their records and comparisons. It makes real Qloo requests against the normal attempt budget. Hosted pages read these records from Valkey, never from disk. Rankings have a five-minute TTL; install near a demonstration.

`MIXTAPE_LIVE_AGENT` selects the live browser suite’s agent (`anthropic` by default). `MIXTAPE_SHOTS_DIR` optionally saves screenshots and diagnostics. `MIXTAPE_KV_PRESSURE_TEST=true` includes an isolated local Redis eviction regression; it requires `redis-server` on PATH. Browser tests use at most two workers. Fixture tests establish interaction and safety behaviour, not live ranking quality; saved comparison pages do not establish recipient preference.

`bun run test:e2e:release` checks the current judge journey at desktop and mobile sizes with live Haiku and Qloo. First build, then install the reviewed starters into an isolated local Valkey instance and pass its `REDIS_URL`/`VALKEY_PREFIX`. This suite requires Valkey, disables disk-cache and file-manifest fallback, and asserts live provider attempts during recipient replacement. It does not validate the public ingress or hosted adapter.
