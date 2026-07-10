import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          AUTH_PEPPER: "test-auth-pepper-with-at-least-32-bytes",
          INTERNAL_SECRET: "test-internal-secret-independent-value",
          ENVIRONMENT: "test",
          PUBLIC_APP_ORIGIN: "https://app.example.test",
          ENROLLMENT_LIMIT_PER_HOUR: "5",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
