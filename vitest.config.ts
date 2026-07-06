import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // e2e specs are Playwright's — collecting them under vitest throws.
    include: ["tests/unit/**/*.test.ts", "tests/sim/**/*.test.ts"],
  },
})
