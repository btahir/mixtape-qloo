# Qloo server adapter

Owned TypeScript adapter, copied and adapted for Mixtape. GET requests use only
`https://hackathon.api.qloo.com`, a server `X-Api-Key`, strict wire schemas,
allowlisted parameters, bounded retries/deadlines, private caches and cancellation.
Import through `src/lib/server/qloo.ts` to enforce application quota accounting.

The `fixtures/` directory is entirely synthetic. Its standalone transport tests
wire behaviour; Mixtape's three editorial offline scenarios live in `samples.ts`.
Neither establishes live integration or recommendation quality. Raw provider responses and user data stay out of the public repository. The release
installer bundles only curated public catalog identity references, then hydrates them
from Qloo into project storage.

Current contracts: [Qloo search](https://docs.qloo.com/reference/get-search),
[Insights](https://docs.qloo.com/reference/insights-api-deep-dive),
[event access](https://docs.qloo.com/reference/qloo-llm-hackathon-developer-guide).
