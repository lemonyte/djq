# djq: guest song requests for a Spotify DJ

Each DJ opens `/`, clicks **Start a room with Spotify**, and lands on their own console at `/r/<room id>/dj`.
Every Spotify account gets its own room, with its own requests, votes, queue and QR code.
Logging in again with the same account (on any device) returns to the same room.

Guests scan the room's QR code (`/r/<room id>`) to see what's playing, search, request, and upvote.
The DJ queues or rejects requests; queued tracks go straight into that DJ's Spotify queue.
With **Add requests to the queue automatically** ticked, requests skip approval and go straight into the queue.
Before each party, the DJ clicks **Clear all requests**.

## Setup

1. Create an app at <https://developer.spotify.com/dashboard> (Web API). Add redirect URIs
   `http://127.0.0.1:8787/auth/callback` and `https://<your-worker>/auth/callback`.
   In development mode, only Spotify accounts listed under _User Management_ can log in, so add every DJ there.
   To let any Spotify user start a room, the app needs extended quota from Spotify. DJs need Premium.
2. Fill in `.dev.vars` (see `.dev.vars.example`).
3. `bun run dev`, open <http://127.0.0.1:8787/>, click **Start a room with Spotify**, start playback on the laptop.

## Deploy

```bash
bunx wrangler secret put SPOTIFY_CLIENT_ID
bunx wrangler secret put SPOTIFY_CLIENT_SECRET
bun run deploy
```

## Test

`bun run test`
