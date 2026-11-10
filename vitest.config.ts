import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
    plugins: [
        cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: { bindings: { SPOTIFY_CLIENT_ID: "id", SPOTIFY_CLIENT_SECRET: "secret" } },
        }),
    ],
});
