# wordlle with Ishita

Private multiplayer word guessing with a paper-cutout game UI and a fullscreen Three.js night-garden loader. Two particle sunflowers grow from the bottom, bloom, and reveal “Welcome Ishita” before the page transitions into the game. No sunglasses or faces. Mobile-first, skippable, replayable, and respectful of reduced-motion settings. No accounts, API keys, or paid word API.

## Run

Use Node **22.13+** (Node 24 recommended):

```sh
npm ci
npm start
```

Open **http://localhost:4318**. Choose **Start a room**, enter a name, select **4–7 letters** and **3, 5, or 10 rounds**, then share the invite link or six-character room code. Invite friends before starting; up to eight people can play. Solo rooms work too.

```sh
npm test
```

The 26 isolated Node tests cover rules, permissions, all four lengths, private boards and archives, score replay/concurrency, deadlines, pause/resume, host handoff, restart preservation, legacy migration, one-year retention, zero-point final-round losses, and buffered-stream presence. Real-browser checks exercised two independent touch sessions, simultaneous guesses, private feedback, shared scoring, host departure, root-link discovery, same-team resume with saved attempts/time, third-round answer visibility, match/player histories, rematches, clipboard copying, and persisted high-contrast colors. Layout checks cover 360/390px portrait and 844px landscape. Earlier loader checks cover the real Three.js scene, fullscreen pending requests, replay, touch Skip, and reduced motion.

## Rules

Everyone gets the same randomly selected word and an independent board. Six valid guesses and three minutes per round. Green means correct position, gold means a letter belongs elsewhere, gray means no unmatched copy remains. Exact matches consume duplicate letters first. Invalid words do not consume guesses; repeated guesses are rejected.

Each person who solves earns **one point**, regardless of speed or attempt count. Others can keep playing after someone solves. The answer is revealed only once everyone finishes or the server deadline expires. The host advances rounds; highest score wins, including ties. Rematches reset scores, retain the roster and word length, and reopen invitations.

The classic five-letter rules follow the [New York Times Wordle help](https://help.nytimes.com/24611727334932-Wordle). Multiplayer, selectable lengths, scoring, and timed rounds are wordlle with Ishita variants; this is not an official NYT product.

## Saved teams, history and sharing

Visible game tabs refresh presence with authenticated HTTP every 2.5 seconds. SSE delivers fast updates but does not prove a player is still present: proxies may retain a stream after the page closes. Delayed stream closure never moves the recorded departure time.

- **Continue with your team:** reopen the same link and browser. The home screen lists your unfinished rooms; **Continue with team** returns to the same roster, round, private guesses and scores. A paused room link also offers **Resume with team**.
- **Pause and host handoff:** when everyone leaves, an eight-second presence grace confirms departure and saves the remaining clock. One person leaving does not pause an active teammate. An absent host hands control to an active member after the grace; any existing member can resume. Resuming an already-running game never extends its timer. Graceful server restarts save playing rounds as paused.
- **Game history:** completed matches are archived separately, so rematching resets only the current game. Review every completed answer, outcomes and recorded attempt counts, with your own archived boards. Final results prominently show **Correct word**, even when nobody scores.
- **All-time leaderboard:** points and wins come from completed games shared with you. Positive tied top scores share a win; all-zero games give nobody a win. There is no public directory of other private teams.
- **Player history:** view your totals or a teammate's results from games you played together. Another player's guess words and boards stay private, including in archives.
- **Sharing and contrast:** **Share result** previews a spoiler-free `G/Y/-` grid, with copy and native sharing where supported. If clipboard access is denied, select and copy the displayed text. **High-contrast tiles** uses blue/orange feedback and matching accessible rule labels; the preference survives reloads.

Migration keeps existing identities, memberships, scores and saved boards, and imports saved completed games once. Earlier round boards not recorded by the old version are marked as unrecorded; results already erased by an old rematch cannot be reconstructed.


## Fullscreen sunflower loader

The scene uses GPU shaders and three draw calls to assemble two natural sunflowers from luminous particles: growing stems, branching leaves, golden petals, and brown golden-angle seed cores. It uses Three.js WebGL 2 rather than requiring WebGPU. The visual approach draws on the [particle simulation reference](https://discourse.threejs.org/t/interactive-particle-simulation/67581) and [Three.js ShaderMaterial](https://threejs.org/docs/pages/ShaderMaterial.html); the flower artwork and choreography are procedural, not a prerecorded clip.

The initial bloom runs while fonts, your saved-game library and private room state are prepared. The greeting and exit wait for that work to settle. **Skip intro** settles the visual sequence but does not pretend network work has completed. Use the sun/replay control in the header to see the animation again.

Subsequent requests lasting over 250ms show the same full-viewport, fully bloomed scene with the real pending-work message. They close as soon as the request finishes; guessing never has a forced six-second animation. Rendering pauses when the loader closes or the tab is hidden. Reduced motion shows a static bloom. If WebGL cannot initialize, an explicit message lets the player continue without the animation.

Three.js **0.181.0** is pinned in `package-lock.json` and served locally from `public/vendor/three-0.181.0/`, including its MIT license. `npm ci` regenerates these browser assets using `scripts/vendor.mjs`; they are also committed so the Node-only runtime and Docker image can serve the app without a client build step.


## Fair play and privacy

- Answers, randomness (`crypto.randomInt`), dictionary checks, attempts, deadlines, and scores live on the server. No answer-selection or score-setting endpoint exists.
- Opponents receive progress and scores, never one another's guess words or tile marks. Running out of attempts does not reveal a word before other players finish.
- Membership uses random HTTP-only, same-site cookies. Tokens are stored hashed. Reloading or opening another tab retains the same attempts; new identities cannot join a started match.
- Only the current host can start, advance a completed round, or request a rematch; existing members may resume a paused round. An active member can inherit an absent host's role after the presence grace. All mutations are checked again after their request body arrives. Stale-round guesses cannot spend attempts in a new round.
- Mutations are same-origin, input/body sizes are bounded, guesses are throttled, and private dictionaries, server source, and SQLite files cannot be fetched as web assets.
- SQLite preserves team state and completed-game archives across restarts. Sessions renew for one year during use; live rooms expire after one year without a saved update. Archives survive live-room cleanup. Keep the same public hostname and browser cookies: another device, expired identity, or cleared cookies cannot recover your player without an account system.

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
