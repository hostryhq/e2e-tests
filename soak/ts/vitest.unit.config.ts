import { defineConfig } from "vitest/config";

/** The harness self-tests: synthetic data only, no stack and no fixture (`npm run selftest`). */
export default defineConfig({
  test: { environment: "node", include: ["src/**/*.unit.ts"], fileParallelism: false },
});
