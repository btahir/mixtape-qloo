import { runRelease } from "../src/lib/server/release";

// Bun's react-server condition resolves the server-only marker without a test runner.
try {
  if (!process.env.REDIS_URL) throw new Error("Release requires project Valkey.");
  const report = await runRelease();
  console.log(JSON.stringify({ event: "mixtape-release", ...report,
    budget: { qlooAttempts: report.budget.qloo, modelUpperBoundUsd: report.budget.modelMicroUsd / 1e6 },
  }));
} catch {
  // Infrastructure/migration failures block a release; provider warm-up never does.
  console.error("Mixtape release could not initialize storage. Check project Valkey and migration status.");
  process.exitCode = 1;
}
