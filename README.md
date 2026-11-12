# Wordbloom

Private multiplayer word guessing, with a paper-cutout botanical UI and an animated ASCII sunflower loader. No package dependencies, accounts, API keys, or paid word API.

## Run

Use Node **22.13+** (Node 24 recommended):

```sh
npm start
```

Open **http://localhost:4318**. Choose **Start a room**, enter a name, select **4–7 letters** and **3, 5, or 10 rounds**, then share the invite link or six-character room code. Invite friends before starting; up to eight people can play. Solo rooms work too.

```sh
npm test
```

The 15 isolated Node tests cover repeated letters, room permissions, private boards, dictionary validation, attempts, score replay/concurrency, stale rounds, deadlines, persistence, cross-origin protection, room limits, and all four lengths. Browser smoke checks also exercised the actual animated loader, public multiplayer on desktop/mobile, colored feedback, invalid guesses, scores, ties, and rematches.

## Rules

Everyone gets the same randomly selected word and an independent board. Six valid guesses and three minutes per round. Green means correct position, gold means a letter belongs elsewhere, gray means no unmatched copy remains. Exact matches consume duplicate letters first. Invalid words do not consume guesses; repeated guesses are rejected.

Each person who solves earns **one point**, regardless of speed or attempt count. Others can keep playing after someone solves. The answer is revealed only once everyone finishes or the server deadline expires. The host advances rounds; highest score wins, including ties. Rematches reset scores, retain the roster and word length, and reopen invitations.

The classic five-letter rules follow the [New York Times Wordle help](https://help.nytimes.com/24611727334932-Wordle). Multiplayer, selectable lengths, scoring, and timed rounds are Wordbloom variants; this is not an official NYT product.

## Fair play and privacy

- Answers, randomness (`crypto.randomInt`), dictionary checks, attempts, deadlines, and scores live on the server. No answer-selection or score-setting endpoint exists.
- Opponents receive progress and scores, never one another's guess words or tile marks. Running out of attempts does not reveal a word before other players finish.
- Membership uses random HTTP-only, same-site cookies. Tokens are stored hashed. Reloading or opening another tab retains the same attempts; new identities cannot join a started match.
- Only the host can start, advance a completed round, or request a rematch. All mutations are checked again after their request body arrives. Stale-round guesses cannot spend attempts in a new round.
- Mutations are same-origin, input/body sizes are bounded, guesses are throttled, and private dictionaries, server source, and SQLite files cannot be fetched as web assets.
- SQLite preserves room state and scores across server restarts. Rooms expire after seven days without a saved update; browser identities expire after seven days. Keep browser cookies to retain membership. Clearing cookies loses access to an active match.

No browser game can prevent outside word solvers, collusion, or cheating by someone with access to the hosting machine/database. This protects the application boundary; it is not proctoring or authenticated identity verification.

## Hosting

This is a **long-running Node service with persistent SQLite**, not a static site or a Vercel serverless function. Run one instance. Multiple replicas require shared transactional storage instead of process-local room state.

For a quick public HTTPS preview, keep `npm start` running and run:

```sh
cloudflared tunnel --url http://127.0.0.1:4318 --no-autoupdate --protocol http2
```

Use the HTTPS URL printed by `cloudflared`. The existing published preview is managed by two persistent local processes. **Quick Tunnel URLs are temporary:** they stop when the tunnel/server or this computer stops, change when a new tunnel starts, and have no uptime guarantee. This is not a permanent cloud deployment. The client uses 2.5-second authenticated state polling when SSE is unavailable, including on [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

For always-on hosting, the included `Dockerfile` runs Node 24 as an unprivileged user. Deploy to a Node/container host with HTTPS and a persistent writable volume mounted at `/state`, owned by UID 1000. Keep exactly one instance and preserve the same public hostname for sessions and invites. Do not expose `.data/` or the repository as a static directory. No paid hosting resources are provisioned automatically.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4318` (`3000` in Docker) | Listening port |
| `HOST` | `0.0.0.0` | Bind address |
| `DB_PATH` | `.data/wordbloom.sqlite` (`/state/wordbloom.sqlite` in Docker) | Persistent database file |
| `COOKIE_SECURE` | auto from HTTPS proxy | Set to `1` behind a TLS proxy that does not forward `X-Forwarded-Proto: https` |

`GET /health` is the health check. Preserve `Host` when proxying. SSE is used where supported; authenticated polling keeps rooms usable without streaming. Back up the SQLite database using SQLite-aware tooling (or stop the server before copying its database and WAL files).

## Dictionaries and licensing

Words are bundled privately and do not need network access during a game:

- `data/answers.txt`: 2,309 five-letter answers from [Alex Selby's archived NYT word list](https://github.com/alex1770/wordle), MIT license in `data/LICENSE`. `data/guesses.txt` contains that project's 14,855 accepted five-letter guesses.
- `data/extra-answers.txt`: curated common-word pools for other lengths: 477 four-letter, 333 six-letter, and 314 seven-letter answers. Answers do not repeat within a normal match.
- `data/english.txt`: 73,581 accepted four-to-seven-letter words filtered from [Sindre Sorhus's word-list](https://github.com/sindresorhus/word-list); MIT license in `data/WORD-LIST-LICENSE`.

Google Fonts supplies optional display fonts; system fallbacks remain usable when offline. All gameplay, assets other than these fonts, and word data are served by this app.
