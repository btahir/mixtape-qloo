import { defineConfig } from "@shiptiffin/sdk";

export default defineConfig({
  project: "mixtape",
  apps: { web: { framework: "next", path: "." } },
});
