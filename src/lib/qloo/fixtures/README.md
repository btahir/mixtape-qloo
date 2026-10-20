# Synthetic fixtures

Every JSON file here is **authored synthetic fixture data**, not a Qloo response or dataset. Names refer to well-known works, artists and venues; every UUID, score, association, demographic value, ranking and trend is fabricated. Do not use these IDs against Qloo. Images are omitted to avoid asset redistribution. Fixtures exercise flat/nested metadata, both identity fields on tags, nullable fields, signed demographics and 0–100 trend percentiles.

`FixtureTransport` is explicitly selected and always marks `fixture: true` plus `provenance.source: "fixture"`. Apps must visibly label fixture mode. No missing-key/live-error fallback exists. Import it separately so live bundles do not include demo assets.

Search supports literal name/type matching and pagination. Hydration supports synthetic entity IDs. Entity Insights supports category, shortlist, exclusions and pagination. Signals are accepted as demo context but **do not compute real cultural relationships**. Tag search supports literal names and ID shortlist, never pretends to implement semantic/typo search. Heatmaps are canned New York coordinates only. Trends are a fixed synthetic series filtered by date; demographics repeat an illustrative signed profile per input ID. Compare deliberately returns an empty array, without invented metrics. Other filters may be rejected; this transport is not an API emulator.

`tag-types.json` has a provisional fixture-only item format: current docs omit the response schema. Compare item semantics, explanation details, destination/locality and video_game spelling remain [U] until live validation. No real API outputs belong in this directory.
