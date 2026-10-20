# Qloo server adapter

Owned TypeScript adapter, copied and adapted for Mixtape. GET requests use only
`https://hackathon.api.qloo.com`, a server `X-Api-Key`, strict wire schemas,
allowlisted parameters, bounded retries/deadlines, private caches and cancellation.
Import through `src/lib/server/qloo.ts` to enforce application quota accounting.

The `fixtures/` directory is entirely synthetic. Its standalone transport tests
wire behaviour; Mixtape's three editorial offline scenarios live in `samples.ts`.
Neither establishes live integration or recommendation quality. Production data
must never be copied into the public source repository.

Current contracts: [Qloo search](https://docs.qloo.com/reference/get-search),
[Insights](https://docs.qloo.com/reference/insights-api-deep-dive),
[event access](https://docs.qloo.com/reference/qloo-llm-hackathon-developer-guide).
