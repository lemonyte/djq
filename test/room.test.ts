import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, afterEach, describe, expect, it, vi, type Mock } from "vitest";

import type { Room } from "../src/room";

const uri = (char: string) => `spotify:track:${char.repeat(22)}`;
// The room most tests use; `key` is its DJ key, handed out by login().
const roomId = env.ROOM.idFromName("user-a");
const room = (id = roomId) => env.ROOM.get(id);
let key: string;
const api = (path: string, body?: unknown, djKey?: string, id = roomId) =>
    exports.default.fetch(`https://dj.test/r/${id.toString()}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(djKey && { Authorization: `Bearer ${djKey}` }) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
const rows = (id = roomId) =>
    runInDurableObject(room(id), (_instance, state) =>
        state.storage.sql
            .exec<any>("SELECT r.*, (SELECT COUNT(*) FROM votes WHERE request_id = r.id) votes FROM requests r")
            .toArray(),
    );

// The URL a fetch() call went to, whether it was given a string, a URL or a Request.
const urlOf = (input: RequestInfo | URL) => (input instanceof Request ? input.url : input.toString());

let spotify: Mock<typeof fetch>;
beforeEach(async () => {
    key = await room().login({ access_token: "tok", refresh_token: "r", expires_in: 3600 }, null);
    spotify = vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(urlOf(input));
        if (url.pathname.startsWith("/v1/tracks/")) {
            return Response.json({
                uri: `spotify:track:${url.pathname.split("/")[3]}`,
                name: "Song",
                artists: [{ name: "Artist" }],
                album: { images: [] },
            });
        }
        if (url.pathname === "/v1/me/player/queue" && init?.method === "POST") {
            return new Response("TgB_yL82_7xyz", { status: 200 }); // what Spotify actually returns
        }
        return new Response("unexpected", { status: 500 });
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(spotify);
});
afterEach(() => vi.restoreAllMocks());

describe("requests", () => {
    it("rejects invalid track uris", async () => {
        expect((await api("/api/requests", { uri: "spotify:track:../me", guestId: "guest-aaaa" })).status).toBe(400);
        expect((await api("/api/requests", { uri: uri("a"), guestId: "x" })).status).toBe(400);
    });

    it("stores server-fetched metadata and turns duplicates into votes", async () => {
        expect((await api("/api/requests", { uri: uri("b"), guestId: "guest-bbbb" })).status).toBe(200);
        expect((await api("/api/requests", { uri: uri("b"), guestId: "guest-cccc" })).status).toBe(200);
        const request = (await rows()).find((row) => row.uri === uri("b"));
        expect(request).toMatchObject({ title: "Song", artist: "Artist", status: "pending", votes: 2 });
    });

    it("limits pending requests per guest", async () => {
        for (const char of "def") {
            expect((await api("/api/requests", { uri: uri(char), guestId: "guest-dddd" })).status).toBe(200);
        }
        expect((await api("/api/requests", { uri: uri("g"), guestId: "guest-dddd" })).status).toBe(429);
    });

    it("limits pending requests even when sent at the same time", async () => {
        const fast = spotify.getMockImplementation()!;
        spotify.mockImplementation(async (input, init) => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return fast(input, init);
        });
        const responses = await Promise.all(
            "pqrst".split("").map((char) => api("/api/requests", { uri: uri(char), guestId: "guest-pppp" })),
        );
        expect(responses.map((response) => response.status).sort((first, second) => first - second)).toEqual([
            200, 200, 200, 429, 429,
        ]);
    });

    it("lets a queued song be requested again, but not a rejected one", async () => {
        const { id } = await (await api("/api/requests", { uri: uri("u"), guestId: "guest-uuuu" })).json<any>();
        await api(`/api/requests/${id}/vote`, { guestId: "guest-vvvv" });
        await api(`/api/requests/${id}/approve`, undefined, key);
        expect((await api("/api/requests", { uri: uri("u"), guestId: "guest-wwww" })).status).toBe(200);
        expect((await rows()).find((row) => row.id === id)).toMatchObject({
            status: "pending",
            guest_id: "guest-wwww",
            votes: 1,
        });

        const { id: rejectedId } = await (
            await api("/api/requests", { uri: uri("x"), guestId: "guest-uuuu" })
        ).json<any>();
        await api(`/api/requests/${rejectedId}/reject`, undefined, key);
        expect((await api("/api/requests", { uri: uri("x"), guestId: "guest-wwww" })).status).toBe(409);
    });

    it("returns 404 for a track Spotify doesn't know", async () => {
        spotify.mockImplementation(async () => new Response("not found", { status: 404 }));
        expect((await api("/api/requests", { uri: uri("y"), guestId: "guest-yyyy" })).status).toBe(404);
    });

    it("counts one vote per guest", async () => {
        const { id } = await (await api("/api/requests", { uri: uri("h"), guestId: "guest-hhhh" })).json<any>();
        await api(`/api/requests/${id}/vote`, { guestId: "guest-iiii" });
        await api(`/api/requests/${id}/vote`, { guestId: "guest-iiii" });
        expect((await rows()).find((row) => row.id === id).votes).toBe(2);
        expect((await api("/api/requests/99999/vote", { guestId: "guest-iiii" })).status).toBe(404);
    });
});

describe("dj", () => {
    it("requires the key to approve or reject", async () => {
        const { id } = await (await api("/api/requests", { uri: uri("j"), guestId: "guest-jjjj" })).json<any>();
        expect((await api(`/api/requests/${id}/approve`)).status).toBe(401);
        expect((await api(`/api/requests/${id}/reject`, undefined, "wrong-key")).status).toBe(401);
    });

    it("approve queues the track on Spotify", async () => {
        const { id } = await (await api("/api/requests", { uri: uri("k"), guestId: "guest-kkkk" })).json<any>();
        expect((await api(`/api/requests/${id}/approve`, undefined, key)).status).toBe(200);
        const call = spotify.mock.calls.find(
            ([input, init]) => urlOf(input).includes("/me/player/queue") && init?.method === "POST",
        )!;
        expect(new URL(urlOf(call[0])).searchParams.get("uri")).toBe(uri("k"));
        expect((call[1]!.headers as any).Authorization).toBe("Bearer tok");
        expect((await rows()).find((row) => row.id === id).status).toBe("queued");
        expect((await api(`/api/requests/${id}/approve`, undefined, key)).status).toBe(409);
    });

    it("approve leaves the request pending when Spotify has no device", async () => {
        const { id } = await (await api("/api/requests", { uri: uri("m"), guestId: "guest-mmmm" })).json<any>();
        spotify.mockImplementation(async () => new Response("no device", { status: 404 }));
        expect((await api(`/api/requests/${id}/approve`, undefined, key)).status).toBe(409);
        expect((await rows()).find((row) => row.id === id).status).toBe("pending");
    });

    it("reset clears all requests, DJ only", async () => {
        await api("/api/requests", { uri: uri("z"), guestId: "guest-zzzz" });
        expect((await api("/api/reset")).status).toBe(401);
        expect((await api("/api/reset", undefined, key)).status).toBe(200);
        expect(await rows()).toEqual([]);
    });

    it("disconnect forgets Spotify but keeps the DJ key, DJ only", async () => {
        expect((await api("/api/disconnect")).status).toBe(401);
        expect((await api("/api/disconnect", undefined, key)).status).toBe(200);
        expect(await runInDurableObject(room(), (_instance, state) => state.storage.kv.get("tokens"))).toBeUndefined();
        expect((await api("/api/reset", undefined, key)).status).toBe(200);
    });

    it("rejects a request", async () => {
        const { id } = await (await api("/api/requests", { uri: uri("n"), guestId: "guest-nnnn" })).json<any>();
        expect((await api(`/api/requests/${id}/reject`, undefined, key)).status).toBe(200);
        expect((await rows()).find((row) => row.id === id).status).toBe("rejected");
    });
});

describe("spotify tokens", () => {
    const expire = () =>
        runInDurableObject(room(), (_instance, state) =>
            state.storage.kv.put("tokens", { access: "old", refresh: "r", expires: Date.now() - 1000 }),
        );
    const tokens = () => runInDurableObject(room(), (_instance, state) => state.storage.kv.get<any>("tokens"));

    it("refreshes an expired token and keeps the old refresh token", async () => {
        await expire();
        spotify.mockImplementation(async (input) => {
            const url = new URL(urlOf(input));
            if (url.pathname === "/api/token") {
                return Response.json({ access_token: "new", expires_in: 3600 });
            }
            if (url.pathname === "/v1/search") {
                return Response.json({ tracks: { items: [] } });
            }
            return new Response("unexpected", { status: 500 });
        });
        expect((await exports.default.fetch(`https://dj.test/r/${roomId.toString()}/api/search?q=abc`)).status).toBe(
            200,
        );
        const search = spotify.mock.calls.find(([input]) => urlOf(input).includes("/v1/search"))!;
        expect((search[1]!.headers as any).Authorization).toBe("Bearer new");
        expect(await tokens()).toMatchObject({ access: "new", refresh: "r" });
    });

    it("forgets tokens when the refresh token is revoked", async () => {
        await expire();
        spotify.mockImplementation(async () => Response.json({ error: "invalid_grant" }, { status: 400 }));
        expect((await exports.default.fetch(`https://dj.test/r/${roomId.toString()}/api/search?q=abc`)).status).toBe(
            502,
        );
        expect(await tokens()).toBeUndefined();
    });
});

describe("rooms", () => {
    // Fake Spotify for the login flow: the code is the Spotify account id, so each test picks the account.
    const loginMock = () =>
        spotify.mockImplementation(async (input, init) => {
            const url = new URL(urlOf(input));
            if (url.pathname === "/api/token") {
                const code = new URLSearchParams(init!.body as URLSearchParams).get("code");
                return Response.json({ access_token: `tok-${code}`, refresh_token: "r", expires_in: 3600 });
            }
            if (url.pathname === "/v1/me") {
                const accountId = (init!.headers as any).Authorization.slice("Bearer tok-".length);
                // The old `id` field is different on purpose: rooms must be keyed on account_id.
                return Response.json({ account_id: accountId, id: "legacy-id", display_name: "Sam" });
            }
            return new Response("unexpected", { status: 500 });
        });
    const callback = (user: string, state = "s1", cookie = "oauth_state=s1") =>
        exports.default.fetch(`https://dj.test/auth/callback?code=${user}&state=${state}`, {
            headers: { Cookie: cookie },
            redirect: "manual",
        });

    it("login sets a state cookie and sends the DJ to Spotify", async () => {
        const res = await exports.default.fetch("https://dj.test/auth/login", { redirect: "manual" });
        const location = new URL(res.headers.get("Location")!);
        expect(location.origin).toBe("https://accounts.spotify.com");
        expect(location.searchParams.get("redirect_uri")).toBe("https://dj.test/auth/callback");
        expect(res.headers.get("Set-Cookie")).toContain(`oauth_state=${location.searchParams.get("state")};`);
    });

    it("callback opens the account's own room with its DJ key", async () => {
        loginMock();
        const res = await callback("user-b");
        const id = env.ROOM.idFromName("user-b");
        const [path, hash] = res.headers.get("Location")!.replace("https://dj.test", "").split("#key=");
        expect(path).toBe(`/r/${id.toString()}/dj`);
        expect(
            await runInDurableObject(room(id), (_instance, state) => state.storage.kv.get<any>("tokens")),
        ).toMatchObject({ access: "tok-user-b" });
        // Same account again: same room, same key.
        expect((await callback("user-b")).headers.get("Location")).toBe(`https://dj.test${path}#key=${hash}`);
    });

    it("callback rejects a missing or wrong state", async () => {
        loginMock();
        expect((await callback("user-c", "s1", "")).status).toBe(400);
        expect((await callback("user-c", "s1", "oauth_state=other")).status).toBe(400);
    });

    it("keeps rooms apart", async () => {
        const other = env.ROOM.idFromName("user-d");
        const otherKey = await room(other).login({ access_token: "tok", refresh_token: "r", expires_in: 3600 }, null);
        const { id } = await (
            await api("/api/requests", { uri: uri("o"), guestId: "guest-oooo" }, undefined, other)
        ).json<any>();
        expect((await rows()).some((row) => row.uri === uri("o"))).toBe(false);
        expect((await api(`/api/requests/${id}/approve`, undefined, key, other)).status).toBe(401);
        expect(otherKey).not.toBe(key);
    });

    it("404s for rooms that don't exist", async () => {
        expect((await exports.default.fetch("https://dj.test/r/not-an-id/api/search?q=a")).status).toBe(404);
        expect((await exports.default.fetch(`https://dj.test/r/${"0".repeat(64)}/api/search?q=a`)).status).toBe(404);
    });

    it("serves the guest page and DJ console under the room", async () => {
        expect(await (await exports.default.fetch(`https://dj.test/r/${roomId.toString()}`)).text()).toContain(
            'id="requests"',
        );
        expect(await (await exports.default.fetch(`https://dj.test/r/${roomId.toString()}/dj`)).text()).toContain(
            "DJ Console",
        );
    });
});

describe("auto-queue", () => {
    // Own room, because the setting would otherwise leak into the other tests.
    const autoRoom = env.ROOM.idFromName("user-auto");
    let autoKey: string;
    const status = async (id: number) => (await rows(autoRoom)).find((row) => row.id === id).status;
    const queueCalls = () =>
        spotify.mock.calls.filter(
            ([input, init]) => urlOf(input).includes("/me/player/queue") && init?.method === "POST",
        );

    beforeEach(async () => {
        autoKey = await room(autoRoom).login({ access_token: "tok", refresh_token: "r", expires_in: 3600 }, null);
        await api("/api/settings", { autoQueue: true }, autoKey, autoRoom);
    });

    it("only the DJ can change it, and only to true or false", async () => {
        expect((await api("/api/settings", { autoQueue: false }, undefined, autoRoom)).status).toBe(401);
        expect((await api("/api/settings", { autoQueue: "yes" }, autoKey, autoRoom)).status).toBe(400);
    });

    it("queues new requests on Spotify right away", async () => {
        const res = await api("/api/requests", { uri: uri("A"), guestId: "guest-auto1" }, undefined, autoRoom);
        expect(res.status).toBe(200);
        const { id } = await res.json<any>();
        expect(await status(id)).toBe("queued");
        expect(new URL(urlOf(queueCalls()[0][0])).searchParams.get("uri")).toBe(uri("A"));
    });

    it("leaves the request pending when Spotify has no device", async () => {
        const normal = spotify.getMockImplementation()!;
        spotify.mockImplementation(async (input, init) => {
            if (urlOf(input).includes("/me/player/queue")) {
                return new Response("no device", { status: 404 });
            }
            return normal(input, init);
        });
        const res = await api("/api/requests", { uri: uri("B"), guestId: "guest-auto2" }, undefined, autoRoom);
        expect(res.status).toBe(200);
        expect(await status((await res.json<any>()).id)).toBe("pending");
    });

    it("waits for approval again once turned off", async () => {
        await api("/api/settings", { autoQueue: false }, autoKey, autoRoom);
        const res = await api("/api/requests", { uri: uri("C"), guestId: "guest-auto3" }, undefined, autoRoom);
        expect(await status((await res.json<any>()).id)).toBe("pending");
        expect(queueCalls()).toEqual([]);
    });
});

describe("room look", () => {
    // Own room, so the name and color don't leak into other tests.
    const lookRoom = env.ROOM.idFromName("user-look");
    let lookKey: string;
    beforeEach(async () => {
        lookKey = await room(lookRoom).login({ access_token: "tok", refresh_token: "r", expires_in: 3600 }, "Sam");
    });

    // The state a guest's WebSocket would receive, without opening one.
    const guestRoom = () =>
        runInDurableObject(room(lookRoom), (instance: Room) => {
            const fakeSocket = { deserializeAttachment: () => ({ dj: false, guest: null }) } as unknown as WebSocket;
            return instance.view(fakeSocket).room;
        });

    it("shows the DJ's name and accent to guests", async () => {
        expect(await guestRoom()).toMatchObject({ name: "Sam's Room", accent: null });
        const res = await api("/api/settings", { name: "  Rooftop Party  ", accent: "#3D7BFF" }, lookKey, lookRoom);
        expect(res.status).toBe(200);
        expect(await guestRoom()).toMatchObject({ name: "Rooftop Party", accent: "#3d7bff" });
        // Changing one field leaves the other alone; an empty name goes back to the default.
        await api("/api/settings", { name: "" }, lookKey, lookRoom);
        expect(await guestRoom()).toMatchObject({ name: null, accent: "#3d7bff" });
    });

    it("logging in again keeps a name the DJ picked", async () => {
        await api("/api/settings", { name: "Rooftop" }, lookKey, lookRoom);
        await room(lookRoom).login({ access_token: "tok", refresh_token: "r", expires_in: 3600 }, "Sam");
        expect((await guestRoom()).name).toBe("Rooftop");
    });

    it("rejects bad values and non-DJs", async () => {
        expect((await api("/api/settings", { name: "Mine" }, undefined, lookRoom)).status).toBe(401);
        expect((await api("/api/settings", { accent: "red" }, lookKey, lookRoom)).status).toBe(400);
        expect((await api("/api/settings", { accent: "#fff" }, lookKey, lookRoom)).status).toBe(400);
        expect((await api("/api/settings", { name: "x".repeat(61) }, lookKey, lookRoom)).status).toBe(400);
        expect((await api("/api/settings", { name: 42 }, lookKey, lookRoom)).status).toBe(400);
    });
});

describe("push notifications", () => {
    // Own room, so subscribed devices don't leak into other tests.
    const pushRoom = env.ROOM.idFromName("user-push");
    let pushKey: string;
    const endpoint = "https://fcm.googleapis.com/fcm/send/test-device";

    // A real browser-style subscription: payloads are encrypted to this key, so it has to be a valid P-256 point.
    async function deviceKeys() {
        const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
            "deriveBits",
        ])) as CryptoKeyPair;
        const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
        const toBase64Url = (bytes: Uint8Array) =>
            btoa(String.fromCharCode(...bytes))
                .replace(/\+/g, "-")
                .replace(/\//g, "_")
                .replace(/=+$/, "");
        return { p256dh: toBase64Url(raw), auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))) };
    }
    const devices = () =>
        runInDurableObject(room(pushRoom), (_instance, state) =>
            state.storage.sql.exec<{ endpoint: string }>("SELECT endpoint FROM push_devices").toArray(),
        );
    const pushCalls = () => spotify.mock.calls.filter(([input]) => urlOf(input) === endpoint);
    // Push services answer 201; everything else goes to the usual fake Spotify.
    const pushReplies = (status: number) => {
        const normal = spotify.getMockImplementation()!;
        spotify.mockImplementation(async (input, init) => {
            if (urlOf(input) === endpoint) {
                return new Response(null, { status });
            }
            return normal(input, init);
        });
    };

    beforeEach(async () => {
        pushKey = await room(pushRoom).login({ access_token: "tok", refresh_token: "r", expires_in: 3600 }, null);
        await api("/api/reset", undefined, pushKey, pushRoom);
        await api("/api/settings", { autoQueue: false }, pushKey, pushRoom);
        await api("/api/push/remove", { endpoint }, pushKey, pushRoom);
    });

    it("only the DJ can add a device, and only for a real push service", async () => {
        const keys = await deviceKeys();
        expect((await api("/api/push", { subscription: { endpoint, keys } }, undefined, pushRoom)).status).toBe(401);
        const evil = { endpoint: "https://evil.example/collect", keys };
        expect((await api("/api/push", { subscription: evil }, pushKey, pushRoom)).status).toBe(400);
        const badKeys = { endpoint, keys: { p256dh: "short", auth: "x" } };
        expect((await api("/api/push", { subscription: badKeys }, pushKey, pushRoom)).status).toBe(400);
        expect(await devices()).toEqual([]);
    });

    it("gives the DJ the public key to subscribe with", async () => {
        const state = await runInDurableObject(room(pushRoom), (instance: Room) => {
            const fakeSocket = { deserializeAttachment: () => ({ dj: true, guest: null }) } as unknown as WebSocket;
            return instance.view(fakeSocket);
        });
        // An uncompressed P-256 point is 65 bytes: 87 base64url characters, starting with 0x04 ("B").
        expect((state as any).pushKey).toMatch(/^B[A-Za-z0-9_-]{86}$/);
    });

    it("notifies the DJ's devices about a new request", async () => {
        pushReplies(201);
        const subscription = { endpoint, keys: await deviceKeys() };
        expect((await api("/api/push", { subscription }, pushKey, pushRoom)).status).toBe(200);
        await api("/api/requests", { uri: uri("P"), guestId: "guest-push1" }, undefined, pushRoom);
        await vi.waitFor(() => expect(pushCalls()).toHaveLength(1));
        const [, init] = pushCalls()[0];
        expect(init!.method).toBe("POST");
        expect(new Headers(init!.headers).get("Authorization")).toMatch(/^vapid t=.+, k=B/);
    });

    it("doesn't notify about requests that were queued automatically", async () => {
        pushReplies(201);
        await api("/api/push", { subscription: { endpoint, keys: await deviceKeys() } }, pushKey, pushRoom);
        await api("/api/settings", { autoQueue: true }, pushKey, pushRoom);
        await api("/api/requests", { uri: uri("Q"), guestId: "guest-push2" }, undefined, pushRoom);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(pushCalls()).toEqual([]);
    });

    it("forgets a device the push service says is gone", async () => {
        pushReplies(410);
        await api("/api/push", { subscription: { endpoint, keys: await deviceKeys() } }, pushKey, pushRoom);
        await api("/api/requests", { uri: uri("R"), guestId: "guest-push3" }, undefined, pushRoom);
        await vi.waitFor(async () => expect(await devices()).toEqual([]));
    });
});

describe("home screen manifest", () => {
    it("starts the installed app on the room's console with the DJ key", async () => {
        const res = await exports.default.fetch(
            `https://dj.test/r/${roomId.toString()}/manifest.webmanifest?key=abc-123`,
        );
        expect(res.headers.get("Content-Type")).toBe("application/manifest+json");
        expect(await res.json()).toMatchObject({
            start_url: `/r/${roomId.toString()}/dj#key=abc-123`,
            display: "standalone",
        });
        const odd = await exports.default.fetch(
            `https://dj.test/r/${roomId.toString()}/manifest.webmanifest?key=%22%3E`,
        );
        expect((await odd.json<any>()).start_url).toBe(`/r/${roomId.toString()}/dj`);
    });
});
