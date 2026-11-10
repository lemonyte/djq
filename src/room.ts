import { DurableObject } from "cloudflare:workers";

const API = "https://api.spotify.com/v1";
const URI_RE = /^spotify:track:[A-Za-z0-9]{22}$/;
const GUEST_RE = /^[\w-]{8,64}$/;
const MAX_PENDING = 3;
const POLL_MS = 10_000;
const MAX_NAME = 60;
const ACCENT_RE = /^#[0-9a-fA-F]{6}$/;

type Tokens = { access: string; refresh: string; expires: number };
type Track = { uri: string; title: string; artist: string; art: string | null };
type Attachment = { dj: boolean; guest: string | null };

export class HttpError extends Error {
    constructor(
        public status: number,
        message: string,
    ) {
        super(message);
    }
}

// Used by the Worker for the login code exchange and by Room for refreshes.
export function tokenFetch(env: Env, params: Record<string, string>): Promise<Response> {
    return fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
            Authorization: `Basic ${btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`)}`,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(params),
    });
}

function track(item: any): Track {
    return {
        uri: item.uri,
        title: item.name,
        artist: (item.artists ?? []).map((artist: any) => artist.name).join(", ") || item.show?.name || "",
        art: item.album?.images?.at(-1)?.url ?? item.images?.at(-1)?.url ?? null,
    };
}

export class Room extends DurableObject<Env> {
    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        ctx.storage.sql.exec(`
            CREATE TABLE IF NOT EXISTS requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                uri TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL,
                artist TEXT NOT NULL,
                art TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                guest_id TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS votes (
                request_id INTEGER NOT NULL,
                guest_id TEXT NOT NULL,
                PRIMARY KEY (request_id, guest_id)
            );
        `);
    }

    async fetch(req: Request): Promise<Response> {
        try {
            return await this.route(req);
        } catch (error) {
            if (error instanceof HttpError) {
                return Response.json({ error: error.message }, { status: error.status });
            }
            throw error;
        }
    }

    async route(req: Request): Promise<Response> {
        const url = new URL(req.url);
        const path = url.pathname;
        const post = req.method === "POST";
        const dj = this.isDj(req.headers.get("Authorization")?.replace(/^Bearer /, "") ?? url.searchParams.get("key"));

        if (path === "/api/ws") {
            return this.join(req, dj, url.searchParams.get("guest"));
        }
        if (path === "/api/search" && req.method === "GET") {
            return this.search(url.searchParams.get("q") ?? "");
        }
        if (path === "/api/requests" && post) {
            return this.request(await this.body(req));
        }
        if (path === "/api/reset" && post) {
            if (!dj) {
                throw new HttpError(401, "DJ key required");
            }
            return this.reset();
        }
        if (path === "/api/disconnect" && post) {
            if (!dj) {
                throw new HttpError(401, "DJ key required");
            }
            return this.disconnect();
        }
        if (path === "/api/settings" && post) {
            if (!dj) {
                throw new HttpError(401, "DJ key required");
            }
            return this.settings(await this.body(req));
        }

        const match = path.match(/^\/api\/requests\/(\d+)\/(vote|approve|reject)$/);
        if (match && post) {
            const id = Number(match[1]);
            const action = match[2];
            if (action === "vote") {
                return this.vote(id, (await this.body(req)).guestId);
            }
            if (!dj) {
                throw new HttpError(401, "DJ key required");
            }
            return action === "approve" ? this.approve(id) : this.reject(id);
        }

        throw new HttpError(404, "Not found");
    }

    // RPC from the Worker's login callback: store this account's Spotify tokens and return the room's DJ key.
    // The key is created once, so logging in again with the same Spotify account gets the same key back.
    async login(token: { access_token: string; refresh_token?: string; expires_in: number }): Promise<string> {
        this.saveTokens(token);
        let key = this.ctx.storage.kv.get<string>("djKey");
        if (!key) {
            key = crypto.randomUUID();
            this.ctx.storage.kv.put("djKey", key);
        }
        this.broadcast();
        await this.ctx.storage.setAlarm(Date.now());
        return key;
    }

    isDj(key: string | null): boolean {
        const stored = this.ctx.storage.kv.get<string>("djKey");
        if (!key || !stored) {
            return false;
        }
        const given = new TextEncoder().encode(key);
        const expected = new TextEncoder().encode(stored);
        return given.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(given, expected);
    }

    async body(req: Request): Promise<Record<string, unknown>> {
        const body = await req.json().catch(() => null);
        if (!body || typeof body !== "object") {
            throw new HttpError(400, "JSON body required");
        }
        return body as any;
    }

    // --- Spotify ---

    async tokenRequest(params: Record<string, string>): Promise<string> {
        const res = await tokenFetch(this.env, params);
        if (!res.ok) {
            // A refresh token that stopped working (access revoked) never recovers, so forget it and show the Connect button again.
            if (res.status === 400 && params.grant_type === "refresh_token") {
                this.ctx.storage.kv.delete("tokens");
                this.broadcast();
            }
            throw new HttpError(502, `Spotify token error ${res.status}: ${(await res.text()).slice(0, 200)}`);
        }
        return this.saveTokens(await res.json<any>());
    }

    saveTokens(token: { access_token: string; refresh_token?: string; expires_in: number }): string {
        const previous = this.ctx.storage.kv.get<Tokens>("tokens");
        const tokens: Tokens = {
            access: token.access_token,
            // Refresh responses may omit it; keep the old one. A missing one fails the next refresh, which asks the DJ to log in again.
            refresh: token.refresh_token ?? previous?.refresh ?? "",
            expires: Date.now() + token.expires_in * 1000,
        };
        this.ctx.storage.kv.put("tokens", tokens);
        return tokens.access;
    }

    async token(): Promise<string> {
        const tokens = this.ctx.storage.kv.get<Tokens>("tokens");
        if (!tokens) {
            throw new HttpError(503, "The DJ hasn't connected Spotify yet");
        }
        if (Date.now() < tokens.expires - 60_000) {
            return tokens.access;
        }
        return this.tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh });
    }

    async spotify(path: string, init: RequestInit = {}): Promise<any> {
        const res = await fetch(API + path, { ...init, headers: { Authorization: `Bearer ${await this.token()}` } });
        const text = await res.text();
        if (!res.ok) {
            // 404 from the player API means no active device
            const noDevice = res.status === 404 && path.startsWith("/me/player");
            if (noDevice) {
                throw new HttpError(409, "No active Spotify device. Start playing something first.");
            }
            throw new HttpError(res.status === 404 ? 404 : 502, `Spotify error ${res.status}: ${text.slice(0, 200)}`);
        }
        // Some endpoints (e.g. add-to-queue) return 200 with a plain-text id, not JSON
        return res.headers.get("Content-Type")?.includes("json") && text ? JSON.parse(text) : null;
    }

    // --- handlers ---

    async search(rawQuery: string): Promise<Response> {
        const query = rawQuery.trim();
        if (!query || query.length > 100) {
            throw new HttpError(400, "Query must be 1-100 characters");
        }
        // shortcut: no caching of search results, add Cache API caching if Spotify starts returning 429
        const results = await this.spotify(`/search?${new URLSearchParams({ q: query, type: "track", limit: "10" })}`);
        return Response.json((results?.tracks?.items ?? []).map(track));
    }

    async request({ uri, guestId }: { uri?: unknown; guestId?: unknown }): Promise<Response> {
        if (typeof uri !== "string" || !URI_RE.test(uri)) {
            throw new HttpError(400, "Invalid track");
        }
        const guest = this.guest(guestId);
        const sql = this.ctx.storage.sql;

        const checkLimit = () => {
            const pending = sql
                .exec<{ count: number }>(
                    "SELECT COUNT(*) count FROM requests WHERE guest_id = ? AND status = 'pending'",
                    guest,
                )
                .one().count;
            if (pending >= MAX_PENDING) {
                throw new HttpError(429, `You can have at most ${MAX_PENDING} pending requests`);
            }
        };

        const existing = sql
            .exec<{ id: number; status: string }>("SELECT id, status FROM requests WHERE uri = ?", uri)
            .toArray()[0];
        if (existing?.status === "pending") {
            return this.vote(existing.id, guest);
        }
        if (existing?.status === "rejected") {
            throw new HttpError(409, "The DJ passed on this song");
        }
        checkLimit();
        if (existing) {
            // Queued earlier tonight: make it a fresh pending request.
            sql.exec(
                "UPDATE requests SET status = 'pending', guest_id = ?, created_at = ? WHERE id = ?",
                guest,
                Date.now(),
                existing.id,
            );
            sql.exec("DELETE FROM votes WHERE request_id = ?", existing.id);
            return this.submitted(existing.id, guest);
        }

        // Fetch metadata ourselves so guests can't inject fake titles.
        const details = track(await this.spotify(`/tracks/${uri.split(":")[2]}`));
        checkLimit(); // again: this guest's other requests may have landed during the fetch
        // Another request for the same uri may have landed during the fetch, so upsert.
        const row = sql
            .exec<{ id: number }>(
                `INSERT INTO requests (uri, title, artist, art, guest_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(uri) DO UPDATE SET uri = uri RETURNING id`,
                uri,
                details.title,
                details.artist,
                details.art,
                guest,
                Date.now(),
            )
            .one();
        return this.submitted(row.id, guest);
    }

    // A request just became pending: count the requester's vote, then queue it right away if the DJ turned that on.
    async submitted(id: number, guest: string): Promise<Response> {
        const response = this.vote(id, guest);
        // shortcut: no per-guest rate limit with auto-queue on; add a per-guest time window if guests flood the queue
        if (this.ctx.storage.kv.get("autoQueue")) {
            try {
                await this.approve(id);
            } catch (error) {
                if (!(error instanceof HttpError)) {
                    throw error;
                }
                // approve() put it back to pending (e.g. no active device), so the DJ handles it by hand
            }
        }
        return response;
    }

    vote(id: number, guestId: unknown): Response {
        const guest = this.guest(guestId);
        const sql = this.ctx.storage.sql;
        if (!sql.exec("SELECT 1 FROM requests WHERE id = ?", id).toArray().length) {
            throw new HttpError(404, "No such request");
        }
        sql.exec("INSERT OR IGNORE INTO votes (request_id, guest_id) VALUES (?, ?)", id, guest);
        this.broadcast();
        return Response.json({ id });
    }

    async approve(id: number): Promise<Response> {
        const sql = this.ctx.storage.sql;
        const row = sql
            .exec<{ uri: string; status: string }>("SELECT uri, status FROM requests WHERE id = ?", id)
            .toArray()[0];
        if (!row) {
            throw new HttpError(404, "No such request");
        }
        if (row.status === "queued") {
            throw new HttpError(409, "Already queued");
        }
        // Mark queued before the await so a double click can't add the track twice.
        sql.exec("UPDATE requests SET status = 'queued' WHERE id = ?", id);
        try {
            await this.spotify(`/me/player/queue?uri=${encodeURIComponent(row.uri)}`, { method: "POST" });
        } catch (error) {
            sql.exec("UPDATE requests SET status = ? WHERE id = ?", row.status, id);
            throw error;
        }
        this.broadcast();
        await this.ctx.storage.setAlarm(Date.now() + 1000); // refresh the queue view soon
        return Response.json({ id });
    }

    reject(id: number): Response {
        const changed = this.ctx.storage.sql.exec(
            "UPDATE requests SET status = 'rejected' WHERE id = ?",
            id,
        ).rowsWritten;
        if (!changed) {
            throw new HttpError(404, "No such request");
        }
        this.broadcast();
        return Response.json({ id });
    }

    // Partial update: only the fields present in the body change.
    settings({ autoQueue, name, accent }: Record<string, unknown>): Response {
        if (autoQueue !== undefined && typeof autoQueue !== "boolean") {
            throw new HttpError(400, "autoQueue must be true or false");
        }
        if (name !== undefined && (typeof name !== "string" || name.trim().length > MAX_NAME)) {
            throw new HttpError(400, `Room name must be at most ${MAX_NAME} characters`);
        }
        if (accent !== undefined && (typeof accent !== "string" || !ACCENT_RE.test(accent))) {
            throw new HttpError(400, "Accent must be a color like #ffc23d");
        }
        const kv = this.ctx.storage.kv;
        if (autoQueue !== undefined) {
            kv.put("autoQueue", autoQueue);
        }
        if (name !== undefined) {
            kv.put("name", name.trim()); // empty means the default name
        }
        if (accent !== undefined) {
            kv.put("accent", accent.toLowerCase());
        }
        this.broadcast();
        return Response.json({});
    }

    reset(): Response {
        this.ctx.storage.sql.exec("DELETE FROM votes; DELETE FROM requests;");
        this.broadcast();
        return Response.json({});
    }

    // Forget this room's Spotify tokens. The DJ key stays, so "Connect Spotify" logs back into the same room.
    disconnect(): Response {
        this.ctx.storage.kv.delete("tokens");
        this.ctx.storage.kv.delete("playback");
        this.broadcast();
        return Response.json({});
    }

    guest(id: unknown): string {
        if (typeof id !== "string" || !GUEST_RE.test(id)) {
            throw new HttpError(400, "Invalid guestId");
        }
        return id;
    }

    // --- live updates ---

    async join(req: Request, dj: boolean, guest: string | null): Promise<Response> {
        if (req.headers.get("Upgrade") !== "websocket") {
            throw new HttpError(426, "Expected WebSocket");
        }
        const [client, server] = Object.values(new WebSocketPair());
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment({ dj, guest: guest && GUEST_RE.test(guest) ? guest : null } satisfies Attachment);
        server.send(JSON.stringify(this.view(server)));
        if (!(await this.ctx.storage.getAlarm())) {
            await this.ctx.storage.setAlarm(Date.now());
        }
        return new Response(null, { status: 101, webSocket: client });
    }

    view(ws: WebSocket) {
        const { dj, guest } = ws.deserializeAttachment() as Attachment;
        // shortcut: one query per socket per broadcast, fine for a party, batch it if there are thousands of guests
        const rows = this.ctx.storage.sql
            .exec<any>(
                `SELECT r.id, r.uri, r.title, r.artist, r.art, r.status, r.guest_id = ?1 AS mine,
                COUNT(v.guest_id) AS votes, COALESCE(SUM(v.guest_id = ?1), 0) AS voted
                FROM requests r LEFT JOIN votes v ON v.request_id = r.id
                GROUP BY r.id
                ORDER BY r.status = 'pending' DESC, votes DESC, r.created_at`,
                guest ?? "",
            )
            .toArray();
        const requests = rows
            .filter((row) => dj || row.status !== "rejected" || row.mine)
            .map((row) => ({ ...row, mine: !!row.mine, voted: !!row.voted }));
        const playback = this.ctx.storage.kv.get("playback") ?? { nowPlaying: null, queue: [] };
        const djState = dj && {
            dj: true,
            connected: !!this.ctx.storage.kv.get("tokens"),
            autoQueue: !!this.ctx.storage.kv.get("autoQueue"),
        };
        // Everyone sees the room's look; null means the page default.
        const room = {
            name: this.ctx.storage.kv.get<string>("name") || null,
            accent: this.ctx.storage.kv.get<string>("accent") ?? null,
            autoQueue: this.ctx.storage.kv.get<boolean>("autoQueue") ?? null,
        };
        return { ...playback, requests, room, ...djState };
    }

    broadcast() {
        for (const ws of this.ctx.getWebSockets()) {
            try {
                ws.send(JSON.stringify(this.view(ws)));
            } catch {
                // socket already closing
            }
        }
    }

    async alarm() {
        if (!this.ctx.getWebSockets().length) {
            return; // nobody watching, stop polling
        }
        if (this.ctx.storage.kv.get("tokens")) {
            try {
                await this.poll();
            } catch (error) {
                console.error("poll failed", error);
            }
        }
        await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
    }

    async poll() {
        // shortcut: Spotify's queue API can't remove/reorder and shows ~20 upcoming tracks incl. autoplay
        const current = await this.spotify("/me/player/queue");
        const playback = {
            nowPlaying: current?.currently_playing ? track(current.currently_playing) : null,
            queue: (current?.queue ?? []).map(track),
        };
        if (JSON.stringify(playback) === JSON.stringify(this.ctx.storage.kv.get("playback"))) {
            return;
        }
        this.ctx.storage.kv.put("playback", playback);
        this.broadcast();
    }
}
