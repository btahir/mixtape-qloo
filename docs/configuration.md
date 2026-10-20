# Configuration

All application settings are server-only. `.env.example` lists names with empty values. Never commit credentials or provider response caches. Bun reads `.env.local` for local development; ShipTiffin injects the app environment.

## Deploy on ShipTiffin

From this checkout, with the intended box selected, set four project values, then deploy:

```sh
tiffin secrets set mixtape QLOO_API_KEY --value "$QLOO_API_KEY"
tiffin secrets set mixtape ANTHROPIC_API_KEY --value "$ANTHROPIC_API_KEY"
tiffin secrets set mixtape SESSION_SECRET --value "$SESSION_SECRET"
tiffin secrets set mixtape APP_ORIGIN --value "$APP_ORIGIN"
tiffin deploy
```

The shell variables above refer to your privately supplied values; no example credentials are needed. `APP_ORIGIN` is the canonical HTTPS origin without a trailing slash. `SESSION_SECRET` is a stable, randomly generated secret of at least 32 characters. Keep it across deployments. Share tokens are opaque random values stored in Valkey; no separate `SHARE_TOKEN_SECRET` is needed.

ShipTiffin supplies `TIFFIN_URL`, `REDIS_URL`, `VALKEY_PREFIX`, `DATABASE_URL`, `NODE_ENV` and `PORT`. Public serving and edge IP trust are automatic on Tiffin. The app reads the **last** address in `x-forwarded-for`, matching Tiffin's documented `XFF_DEPTH=1`; visitor-supplied earlier addresses never control rate limits. Other hosting requires explicit `INGRESS_VERIFIED=true` and `TRUST_PROXY_IP=true` behind an ingress with the same contract.

## Automatic release

`tiffin.config.ts` runs `bun run release` on the box, after the build and before traffic switches, with the app's environment. No manual installer, private manifest directory or extra secret is required.

1. Run the migration registry. It is currently empty: Mixtape uses durable Valkey records and has no Postgres tables.
2. Create the quota allowance and budget ledger only if missing. Existing counters and allocations survive redeploys. A previously initialized but missing ledger fails closed.
3. Hydrate the bundled, reviewed Qloo identity references, run Haiku selections to warm the three sample gifts, and save five frozen comparisons. Only successful sample selections become available. Completed records are skipped on subsequent releases; no requests run just to refresh completed work.

Each invocation allows at most **30 Qloo dispatch attempts** and **$0.10 in conservatively bounded Haiku cost**, including retries and failed requests. Each model dispatch is charged before execution using the existing byte/token bound, the cache-write input price and maximum output tokens. Unknown usage never refunds this release budget. Release warming only supports the default Haiku model. Normal application caps also apply; their $0.02 reservation per arm can exceed actual spend and the release's tighter cost bound.

Warming stops admitting provider dispatches after eight minutes. Provider failures, exhausted budgets or missing provider settings leave incomplete samples unavailable and return success so the app can serve. Storage initialization or migration failures stop the release. Saved comparisons retain honest failed arms, including the deliberate low-coverage case, without inventing selections. Completed records expire logically after 30 days; a later release can install missing records. The Qloo ranking cache lasts five minutes, after which a visitor makes a normal budgeted live request.

## Defaults and optional overrides

| Names | Default / behavior |
| --- | --- |
| `QLOO_API_KEY`, `ANTHROPIC_API_KEY` | Required for live operation. Without keys, local examples are illustrative. |
| `QLOO_MODE`, `QLOO_ORIGIN` | Live with a key; optional `fixture` for offline work. Only `https://hackathon.api.qloo.com` is accepted. |
| `ANTHROPIC_MODEL`, `MIXTAPE_AGENT_MODE` | `claude-haiku-5-5`, `anthropic`. `deterministic` is an explicitly labelled outage mode. |
| `QLOO_DAILY_ATTEMPTS`, `QLOO_TOTAL_ATTEMPTS` | 150/day, 2,500 per project allowance. Overrides must be nonnegative integers, at most 250/day and 2,500 total. Zero stops dispatch. Existing provisioned allowances are never increased by env changes; lower env caps apply immediately. |
| `QLOO_QUOTA_RESET_AT` | `2026-11-18T00:00:00Z`. The total Qloo counter resets once, atomically on the first attempt at/after this time. Daily counters reset at UTC midnight. Deploying does not reset counters. |
| `QLOO_ACCESS_EXPIRES_AT` | Access through `2026-11-30T23:59:59Z`. Expiry stops new Qloo calls. |
| `QLOO_EVENT_ACCESS_CONFIRMED`, `QLOO_ALLOCATION_CONFIRMED` | Legacy opt-outs: explicit `false` stops Qloo; no confirmation flag is required for this demo. |
| `MODEL_DAILY_CAP_USD`, `MODEL_TOTAL_CAP_USD` | $3/day and $25 total; overrides only lower caps. Zero stops paid runs. Up to $0.02 is reserved per run; unknown usage retains it. |
| `MODEL_COST_BOUND_CONFIRMED`, `MODEL_POLICY_MODEL`, `MODEL_BYTE_TOKEN_BOUND_CONFIRMED`, `MODEL_INPUT_USD_PER_MILLION`, `MODEL_OUTPUT_USD_PER_MILLION` | Only for a custom model's verified pricing/token policy. Not needed for Haiku. Release warming is skipped for custom models. |
| `PAUSE_GENERATION` | `true` stops preparation/repair and paid warming; saved links remain readable. |
| `PUBLIC_DEMO` | Hosted checks are automatic with `TIFFIN_URL`, `TIFFIN_PROJECT`, or a public `APP_ORIGIN`; `true` also enables them explicitly. |
| `INGRESS_VERIFIED`, `TRUST_PROXY_IP` | Default on when `TIFFIN_URL` is present. Explicit `false` fails public admission closed. |
| `REQUIRE_REDIS` | Optional local requirement. Hosted operation always requires Valkey. |

The defaults are application-side demo limits, not a statement of a provider account's remaining balance. They include release traffic. The persisted allowance records the first release's limits, reset and access expiry; changing those in a later environment never overwrites that record.

## Storage and local verification

The project KV holds gifts, drafts, comparisons and budgets in non-expiring keys with logical expiry; short-lived rankings use expiring keys. Gift links and drafts last 30 days. Keep platform backups and the stable session secret. `DATABASE_URL` without `REDIS_URL` fails closed; local operation without either uses memory.

For a local production check, point `REDIS_URL` and `VALKEY_PREFIX` at an isolated local Valkey, set the provider keys, then run `bun run release`, `bun --bun next build`, and `bun run test:e2e:release`. This uses the pinned Chromium headless shell, at one worker, for desktop/mobile sample generation, sharing, recipient replacement, evidence, return gifts and saved comparisons. It does not verify the hosted edge or Next adapter.

`QLOO_SAMPLE_DIR`, `QLOO_REVIEWED_INPUT`, `QLOO_DEV_CACHE_DIR`, `MIXTAPE_PREPARE_LIVE` and `MIXTAPE_INSTALL_LIVE` belong to optional legacy private editorial tools. None is required for deployment. Disk caching is rejected on public servers. `MIXTAPE_LIVE_AGENT`, `MIXTAPE_SHOTS_DIR` and `MIXTAPE_KV_PRESSURE_TEST` control local checks only.

Platform reference: [apps and release hooks](https://github.com/shiptiffin/tiffin/blob/main/docs/guide/apps.md), [project storage](https://github.com/shiptiffin/tiffin/blob/main/docs/guide/data.md). Model cost policy: [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing).
