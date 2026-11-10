import { HttpError, tokenFetch } from "./room";
export { Room } from "./room";

// Static files in public/ are served before this runs.
// /auth/* logs a DJ in with Spotify; /r/<room id>/... is one DJ's room.
export default {
    async fetch(req, env) {
        try {
            return await route(req, env);
        } catch (error) {
            if (error instanceof HttpError) {
                return Response.json({ error: error.message }, { status: error.status });
            }
            throw error;
        }
    },
} satisfies ExportedHandler<Env>;

async function route(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const redirectUri = `${url.origin}/auth/callback`;
    const secure = url.protocol === "https:" ? "; Secure" : ""; // browsers may drop Secure cookies on http://127.0.0.1

    if (url.pathname === "/auth/login") {
        const state = crypto.randomUUID();
        const params = new URLSearchParams({
            response_type: "code",
            client_id: env.SPOTIFY_CLIENT_ID,
            scope: "user-read-playback-state user-modify-playback-state",
            redirect_uri: redirectUri,
            state,
        });
        return redirect(`https://accounts.spotify.com/authorize?${params}`, {
            "Set-Cookie": `oauth_state=${state}; Path=/auth; Max-Age=600; HttpOnly; SameSite=Lax${secure}`,
        });
    }

    if (url.pathname === "/auth/callback") {
        const state = req.headers.get("Cookie")?.match(/(?:^|;\s*)oauth_state=([^;]+)/)?.[1];
        if (!state || url.searchParams.get("state") !== state) {
            throw new HttpError(400, "Bad OAuth state, try logging in again");
        }
        const code = url.searchParams.get("code");
        if (!code) {
            throw new HttpError(400, url.searchParams.get("error") ?? "Missing code");
        }

        const res = await tokenFetch(env, { grant_type: "authorization_code", code, redirect_uri: redirectUri });
        if (!res.ok) {
            throw new HttpError(502, `Spotify token error ${res.status}: ${(await res.text()).slice(0, 200)}`);
        }
        const token = await res.json<{ access_token: string; refresh_token?: string; expires_in: number }>();

        const me = await fetch("https://api.spotify.com/v1/me", {
            headers: { Authorization: `Bearer ${token.access_token}` },
        });
        if (!me.ok) {
            throw new HttpError(502, `Spotify profile error ${me.status}: ${(await me.text()).slice(0, 200)}`);
        }
        const userProfile = await me.json<{ account_id: string; display_name: string | null }>();
        // One room per Spotify account. The hex id hides the account name and needs no lookup table.
        // shortcut: room URLs are 64 hex chars, fine inside a QR code; add a short-slug lookup if people need to type them
        const id = env.ROOM.idFromName(userProfile.account_id);
        const key = await env.ROOM.get(id).login(token, userProfile.display_name);
        return redirect(`${url.origin}/r/${id}/dj#key=${key}`, {
            "Set-Cookie": `oauth_state=; Path=/auth; Max-Age=0; HttpOnly; SameSite=Lax${secure}`,
        });
    }

    const match = url.pathname.match(/^\/r\/([0-9a-f]{64})(\/.*)?$/);
    let id: DurableObjectId | undefined;
    try {
        if (match) {
            id = env.ROOM.idFromString(match[1]);
        }
    } catch {
        // not an id from this namespace
    }
    if (!match || !id) {
        throw new HttpError(404, "Not found");
    }

    const rest = match[2] ?? "/";
    // "/room" and "/dj", not ".html": the assets layer redirects .html paths to their extensionless form
    if (rest === "/") {
        return env.ASSETS.fetch(new URL("/room", url));
    }
    if (rest === "/dj") {
        return env.ASSETS.fetch(new URL("/dj", url));
    }
    if (rest.startsWith("/api/")) {
        return env.ROOM.get(id).fetch(new Request(new URL(rest + url.search, url), req));
    }
    throw new HttpError(404, "Not found");
}

function redirect(location: string, headers: Record<string, string>): Response {
    return new Response(null, { status: 302, headers: { Location: location, ...headers } });
}
