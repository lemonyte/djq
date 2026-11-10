import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// A throwaway VAPID key for push tests, so they don't depend on .dev.vars.
const vapidKeys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const vapidPrivateJwk = JSON.stringify({
    alg: "ES256",
    ...(await crypto.subtle.exportKey("jwk", vapidKeys.privateKey)),
});

export default defineConfig({
    plugins: [
        cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
                bindings: {
                    SPOTIFY_CLIENT_ID: "id",
                    SPOTIFY_CLIENT_SECRET: "secret",
                    VAPID_PRIVATE_JWK: vapidPrivateJwk,
                },
            },
        }),
    ],
});
