import { test, expect } from "../browser/fixture";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

test("two cold visitors complete without repeating paid ranking steps", async ({ playwright }) => {
  test.setTimeout(60000);
  const root = "http://127.0.0.1:4320";
  const clients = await Promise.all([171, 172].map((i) => playwright.request.newContext({ baseURL: root, extraHTTPHeaders: { Origin: root, "x-forwarded-for": `192.0.2.${i}` } })));
  try {
    const drafts = await Promise.all(clients.map(async (client) => (await client.post("/api/drafts", { data: { source: "sample", sampleId: "quiet-evenings" } })).json()));
    const started = Date.now();
    const runs = await Promise.all(clients.map(async (client, index) => {
      const response = await client.post("/api/agent", { data: { action: "prepare", draftId: drafts[index].id, expectedVersion: drafts[index].version, idempotencyKey: crypto.randomUUID() } });
      const stream = await response.text();
      const records = stream.split("\n").filter((line) => line.startsWith("data: ") && line !== "data: [DONE]").map((line) => JSON.parse(line.slice(6)));
      const terminal = records.filter((record) => record.type === "data-run").at(-1)?.data;
      expect(terminal, stream).toBeDefined();
      return (await client.get(`/api/runs/${terminal.id}`)).json();
    }));
    if (process.env.MIXTAPE_SHOTS_DIR) {
      await mkdir(process.env.MIXTAPE_SHOTS_DIR, { recursive: true });
      await writeFile(join(process.env.MIXTAPE_SHOTS_DIR, "cold-concurrency.json"), JSON.stringify({ elapsedMs: Date.now() - started, runs }, null, 2));
      for (const run of runs) await appendFile(join(process.env.MIXTAPE_SHOTS_DIR, "model-runs.ndjson"), JSON.stringify(run) + "\n");
    }
    for (const run of runs) { expect(run.status, JSON.stringify(run)).toBe("ready"); expect(run.diagnostics.steps.length).toBeLessThanOrEqual(3); expect(run.attempts).toBeGreaterThan(0); expect(run.attempts).toBeLessThanOrEqual(3); }
  } finally { await Promise.all(clients.map((client) => client.dispose())); }
});
