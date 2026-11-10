import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const uri = (char: string) => `spotify:track:${char.repeat(22)}`;
// The room most tests use; `key` is its DJ key, handed out by login().
const roomId = env.ROOM.idFromName("user-a");
const room = (id = roomId) => env.ROOM.get(id);
let key: string;
const api = (path: string, body?: unknown, djKey?: string, id = roomId) =>
    exports.default.fetch(`https://dj.test/r/${id}${path}`, {
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

let spotify: ReturnType<typeof vi.fn>;
beforeEach(async () => {
    key = await room().login({ access_token: "tok", refresh_token: "r", expires_in: 3600 });
    spotify = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
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
    vi.spyOn(globalThis, "fetch").mockImplementation(spotify as any);
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
        const fast = spotify.getMockImplementation() as (...args: any[]) => Promise<Response>;
        spotify.mockImplementation(async (...args: any[]) => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return fast(...args);
        });
        const responses = await Promise.all(
            [..."pqrst"].map((char) => api("/api/requests", { uri: uri(char), guestId: "guest-pppp" })),
        );
        expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 200, 429, 429]);
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
            ([input, init]) => String(input).includes("/me/player/queue") && init?.method === "POST",
        )!;
        expect(new URL(String(call[0])).searchParams.get("uri")).toBe(uri("k"));
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
        spotify.mockImplementation(async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            if (url.pathname === "/api/token") {
                return Response.json({ access_token: "new", expires_in: 3600 });
            }
            if (url.pathname === "/v1/search") {
                return Response.json({ tracks: { items: [] } });
            }
            return new Response("unexpected", { status: 500 });
        });
        expect((await exports.default.fetch(`https://dj.test/r/${roomId}/api/search?q=abc`)).status).toBe(200);
        const search = spotify.mock.calls.find(([input]) => String(input).includes("/v1/search"))!;
        expect((search[1]!.headers as any).Authorization).toBe("Bearer new");
        expect(await tokens()).toMatchObject({ access: "new", refresh: "r" });
    });

    it("forgets tokens when the refresh token is revoked", async () => {
        await expire();
        spotify.mockImplementation(async () => Response.json({ error: "invalid_grant" }, { status: 400 }));
        expect((await exports.default.fetch(`https://dj.test/r/${roomId}/api/search?q=abc`)).status).toBe(502);
        expect(await tokens()).toBeUndefined();
    });
});

describe("rooms", () => {
    // Fake Spotify for the login flow: the code is the Spotify user id, so each test picks the account.
    const loginMock = () =>
        spotify.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(String(input));
            if (url.pathname === "/api/token") {
                const code = new URLSearchParams(String(init!.body)).get("code");
                return Response.json({ access_token: `tok-${code}`, refresh_token: "r", expires_in: 3600 });
            }
            if (url.pathname === "/v1/me") {
                return Response.json({ id: (init!.headers as any).Authorization.slice("Bearer tok-".length) });
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
        expect(path).toBe(`/r/${id}/dj`);
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
        const otherKey = await room(other).login({ access_token: "tok", refresh_token: "r", expires_in: 3600 });
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
        expect(await (await exports.default.fetch(`https://dj.test/r/${roomId}`)).text()).toContain('id="requests"');
        expect(await (await exports.default.fetch(`https://dj.test/r/${roomId}/dj`)).text()).toContain("DJ Console");
    });
});

describe("auto-queue", () => {
    // Own room, because the setting would otherwise leak into the other tests.
    const autoRoom = env.ROOM.idFromName("user-auto");
    let autoKey: string;
    const status = async (id: number) => (await rows(autoRoom)).find((row) => row.id === id).status;
    const queueCalls = () =>
        spotify.mock.calls.filter(
            ([input, init]) => String(input).includes("/me/player/queue") && init?.method === "POST",
        );

    beforeEach(async () => {
        autoKey = await room(autoRoom).login({ access_token: "tok", refresh_token: "r", expires_in: 3600 });
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
        expect(new URL(String(queueCalls()[0][0])).searchParams.get("uri")).toBe(uri("A"));
    });

    it("leaves the request pending when Spotify has no device", async () => {
        const normal = spotify.getMockImplementation() as (...args: any[]) => Promise<Response>;
        spotify.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
            if (String(input).includes("/me/player/queue")) {
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
