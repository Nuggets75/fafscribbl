# fafscribbl

Draw and guess Supreme Commander: Forged Alliance Forever units. One player draws, everyone
else types guesses in the chat. Skribbl-style, but the whole word list is FAF units and
buildings.

No FAF login and no accounts: players type a name and join a lobby by link or 5-letter code.

**Zero runtime dependencies.** Plain Node.js built-ins only (`http`, `crypto`, `fs`), including a
hand-rolled WebSocket server. JSON file storage, no build step, no `npm install` in production.
The container clones the repo and runs `server.js` directly, the same way faf-tourney does.

---

## Features

### Lobbies
- Create a lobby, get a 5-letter code and an invite link (`/r/CODE`). Anyone with the link joins.
- Public lobbies are listed on the front page. Private lobbies are link only. Toggle per lobby.
- The creator is the host. If the host leaves, the crown moves to the next player automatically.
- The host can kick players.
- Reloading the page or losing the connection rejoins the same seat with the same score for
  60 seconds. Reconnection is automatic, with backoff.
- A lobby with nobody in it is dropped after 45 minutes.

### Lobby settings (host only, applied to the next game)
| Setting | Range | Default |
|---|---|---|
| Rounds | 1-20 (UI offers 1-10) | 3 |
| Draw time | **off**, or 15-600 seconds | 80 |
| Max players | **unlimited**, or 2-60 | unlimited |
| Word choices | 1 (assigned, no picking) to 5 | 3 |
| Letter hints | off, or 1-5 letters | 2 |
| Visibility | private / public | private |
| Faction filter | uef, cybran, aeon, seraphim, shared, nomads | all |
| Unit type filter | land, air, naval, structure, experimental | all |
| Extra words | free text, optionally used on their own | empty |

With **draw time off** a turn only ends when everybody has guessed, or when the drawer (or the
host) presses **Skip turn**. Scoring falls back to guess order instead of the clock.

Selecting nothing in a filter means everything. Selecting a filter that leaves no words falls
back to the full list rather than breaking the game.

### A round
1. A round is one full pass: every player draws once, in a shuffled order. `rounds` full passes,
   then the final scoreboard.
2. The drawer gets N word choices and a 20 second pick timer. On timeout one is picked for them.
   With `wordChoices = 1` this step is skipped entirely.
3. Everyone else sees the word as underscores, with the length and the spaces visible. Letters
   are revealed one at a time as the clock runs down, up to the hint count. Hints never uncover
   more than 60% of the word.
4. Guesses go in the chat. A **correct guess is never shown to anybody**: the others only see
   "*name* guessed the word". The guesser is shown the word and can then chat with the other
   players who already guessed, and with the drawer, hidden from everyone still guessing.
5. A guess one letter away gets a private **"... is close!"** reply, visible only to that player.
   The near miss itself is still posted to the chat like any other wrong guess.
6. The drawer cannot leak the word: any message that contains it, or is one letter away, is
   blocked with a warning that only the drawer sees.
7. The turn ends when everyone has guessed, when the clock runs out, when the drawer presses
   Skip turn, or when the drawer disconnects. The word is then revealed to everybody along with
   the points scored.

### Matching
- Case, spaces, hyphens, apostrophes and accents are all ignored. `sou-atha`, `Sou Atha` and
  `SOUATHA` all match **Sou-atha**.
- Every word can carry extra accepted spellings (the "also accepted" column in the admin list).
  The seeded list already has the obvious ones: `Mex` for Mass Extractor, `Nuke` for Strategic
  Missile Launcher, `SMD`, `Colossus` for Galactic Colossus, `Perci`-style short names, and the
  full "... Class" ship names.
- "Close" is Levenshtein distance 1 for words up to 10 characters, 2 for longer ones (the
  Seraphim names need the slack).

### Scoring
- Guesser: `50 + round(350 * fraction of the clock left)`, so 400 at the very start down to 50.
  With the timer off it is based on guess order instead.
- Drawer: the average of what the guessers scored, scaled by how many of them actually got it.
  Nobody guesses, the drawer gets nothing.
- Per-turn deltas are shown on the reveal screen, running totals in the player list, and a
  podium plus a full table at the end of the game.

### Drawing
- Pen with four brush sizes, a 22 colour palette, eraser, flood fill, undo (also Ctrl+Z) and
  clear.
- Strokes stream live over the WebSocket, batched every 50 ms.
- The canvas is a fixed 900x560 logical surface, scaled to fit any screen. Everybody's canvas is
  identical regardless of window size or device pixel ratio.
- Anyone who joins mid-turn gets the full drawing replayed instantly.
- Only the current drawer can draw. The server enforces it, the toolbar is simply hidden for
  everybody else.
- Works with mouse, pen and touch.

### Chat
- Wrong guesses are visible to everyone.
- Correct guesses are invisible, replaced by a system line.
- Players who have guessed talk in a channel only they and the drawer can see.
- Join, leave, round and reveal notices are inline system messages.
- Rate limited to 6 messages per 4 seconds.

### Admin (`/admin`)
Password gated with `ADMIN_PASSWORD`. The token lasts 12 hours and lives in `sessionStorage`.
Wrong passwords are rate limited per IP.

- **Words**: the full editable list. Every field edits in place and saves on blur.
  - *Word* - what the drawer sees and what has to be typed.
  - *Note (admin only)* - what the unit actually is, e.g. "T3 UEF assault bot". **This is never
    sent to players**, not while guessing and not on the reveal screen. It only exists so the
    list is manageable.
  - *Also accepted* - alternative spellings that count as correct.
  - *Tags* - drive the lobby faction and type filters.
  - *On* - disabled words stay in the list but never come up in a game.
  - Search across every field, filter by enabled/disabled or by tag, 50/100/all per page.
  - Multi-select for bulk enable, disable, delete, add tag and remove tag.
- **Lobby defaults**: the settings every newly created lobby starts with.
- **Live lobbies**: every lobby on the server, who is in it, what is being drawn right now, and
  a button to close one.
- **Import / export**: import plain lines or a JSON export, merging (duplicates skipped) or
  replacing. Export downloads the whole list including disabled words. Reset reloads the list
  that ships with the repo.

Import line format, everything after the word optional:

```
Percival | T3 UEF assault bot | Perci, Percy | uef land t3
```

---

## The word list

282 entries seeded from the FAF unit database export, 242 enabled.

Mobile units keep their own names (Percival, Ythotha, Soul Ripper, ...). Everything that would
otherwise be the same drawing three times over is collapsed:

| Collapsed to | Entries |
|---|---|
| One entry, no faction, no tech | Power Generator, Hydrocarbon Power Plant, Mass Extractor, Mass Fabricator, Energy Storage, Mass Storage, Radar, Sonar, Omni Sensor, Quantum Gateway, Strategic Missile Launcher, Strategic Missile Defense, Heavy Artillery Installation (T3 arty), Point Defense (T1), Tactical Missile Launcher, Tactical Missile Defense, Torpedo Launcher, Air Staging Facility, Wall Section, Sonar Platform |
| One per faction, tech ignored | Land / Air / Naval Factory, Shield Generator, Stealth Field Generator, Engineer, ACU, SACU |
| One per faction per tier | Anti-Air (T1 turret, T2 flak, T3 SAM) |
| One per faction | T2 Point Defense, T2 Artillery |
| Kept as named one-offs | Paragon, Salvation, Mavor, Yolona Oss, Novax Center, Eye of Rhianne, Soothsayer, HARMS, Ravager, The Kennel, The Hive |

Factories are split by land / air / naval because those are three visibly different buildings.
Merge them in the admin list if you would rather have one "Cybran Factory".

40 Nomads units are in the list but shipped **disabled**, so they never appear unless you enable
them in the admin tab (filter by the `nomads` tag, select the page, Enable).

---

## Deployment

Same shape as faf-tourney: `node:20-alpine`, **no image build**, the container clones the repo at
start. App listens on port **8092**.

`docker-compose.yml` in the repo is ready to paste into Dockhand. Set `ADMIN_PASSWORD` and the
`REPO` URL, and it runs.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8092` | HTTP port |
| `HOST` | `0.0.0.0` | bind address |
| `DATA_DIR` | `/data` | where `fafscribbl.json` lives, mount a volume here |
| `ADMIN_PASSWORD` | *(random, printed to the log)* | password for `/admin` |
| `UNIT_DB_URL` | `https://faforever.github.io/etfreeman-db/#/` | where the "Unit DB" button points |
| `SITE_NAME` | `fafscribbl` | shown in the API config |

If `ADMIN_PASSWORD` is not set the server generates one, prints it to the container log and
carries on, so a missing variable never stops the site from running. It changes on every restart,
so set it properly.

### Nginx Proxy Manager

Two switches on the proxy host, both of which have bitten this stack before:

- **Websockets Support: ON.** The whole game runs over a WebSocket on `/ws`. Without this the
  page loads and then never connects. The front page says so if it cannot get through.
- **Cache Assets: OFF.** Otherwise updates do not show up after a container restart.

### Storage

One file, `$DATA_DIR/fafscribbl.json`, holding the word list and the default lobby settings.
Written atomically (temp file plus rename). A corrupt file is moved aside and the shipped word
list is loaded instead, rather than the server refusing to start.

Lobbies, players, scores and drawings are in memory only. Restarting the container ends every
game in progress. That is deliberate: nothing about a live lobby is worth persisting.

---

## Architecture

```
server.js            HTTP routing, static files, admin API, WebSocket wiring
lib/ws.js            RFC 6455 WebSocket server, ~200 lines, no dependencies
lib/game.js          rooms, turn engine, scoring, chat rules, drawing relay
lib/words.js         normalisation, Levenshtein, close-guess and leak detection, masking
lib/store.js         JSON persistence
data/words.seed.json the shipped word list
public/              index.html, app.js, admin.html, admin.js, style.css, favicon.svg
test/run.js          end to end test suite
```

The server is authoritative for everything: who may draw, who may start, what the mask looks
like per player, who sees which chat message, and every score. The client renders and sends
intent, nothing more.

### WebSocket protocol

Client to server: `hello`, `chat`, `draw`, `begin`, `undo`, `clearCanvas`, `pick`, `start`,
`settings`, `kick`, `skip`, `lobby`, `sync`, `ping`.

Server to client: `joined`, `state`, `players`, `settings`, `chat`, `draw`, `canvas`, `mask`,
`reveal`, `choices`, `turnend`, `gameend`, `error`, `kicked`, `closed`, `pong`.

Drawing ops are compact arrays: `['s', x0, y0, x1, y1, colour, width]` for a segment,
`['f', x, y, colour]` for a fill. Capped at 60000 ops per turn and 2000 ops per second per
player.

---

## Development

```bash
DATA_DIR=/tmp/fsdata ADMIN_PASSWORD=dev PORT=8092 node server.js
```

Before packaging anything:

```bash
npm run check      # node --check on every js file
npm test           # end to end suite, needs node 22+ for the WebSocket client
```

The test suite starts a real server on a random port and drives it over real WebSockets:
HTTP routes, the admin API, the whole game flow, the word list collapse rules, hints, close
guesses, chat visibility, drawing permissions, reconnection, kicking, host handover, filters and
custom words. 98 assertions.

To catch undefined identifiers, which `node --check` cannot:

```bash
npm i --no-save typescript
# tsconfig: allowJs, checkJs, noEmit, lib ["ES2020","DOM"], strict false, include public/*.js
./node_modules/.bin/tsc -p tsc-scan.json 2>&1 | grep "Cannot find name"
```
