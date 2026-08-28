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
- Create a lobby, get a 5-letter code and an invite link (`/r/CODE`). Opening that link asks for
  a name and nothing else: no code box, no Create button to press by mistake. Somebody who has
  played before is put straight into the lobby without being asked anything.
- Public lobbies are listed on the front page. Private lobbies are link only. Toggle per lobby.
- The creator is the host. If the host leaves, the crown moves to the next player automatically.
- The host can kick players.
- **The lobby is a screen, not a dialog.** While a lobby is waiting there is no drawing board at
  all: the middle column holds the lobby itself, with the player list and the chat either side,
  so you can talk while you wait. The board only exists once a game is actually running, which
  needs two players and the host pressing Start. There is nothing to dismiss and no way to end up
  looking at an empty white board that is not a game.
- Reloading the page or losing the connection rejoins the same seat with the same score for
  60 seconds. Reconnection is automatic, with backoff.
- A lobby drops itself 60 seconds after the last player leaves, so empty lobbies never pile up
  in the admin list. The minute of grace is there so a lone host can reload without losing it.
  A backstop sweep clears anything still empty after 10 minutes.

### Lobby settings (host only, applied to the next game)
| Setting | Range | Default |
|---|---|---|
| Rounds | 1-20 (UI offers 1-10) | 3 |
| Draw time | **off**, or 15-600 seconds | 80 |
| Max players | **unlimited**, or 2-60 | unlimited |
| Word choices | 1 (assigned, no picking) to 5 | 3 |
| Letter hints | off, or a minimum of 1-5 letters | 2 |
| Unit look-up | on / off | on |
| Visibility | private / public | private |
| Word pool filters | one chip row per admin-defined tag group | nothing, tags are opt in |
| Extra words | free text, optionally used on their own | empty |

With **draw time off** a turn only ends when everybody has guessed, or when the drawer (or the
host) presses **Skip turn**. Scoring falls back to guess order instead of the clock.

**Tags are opt in and additive.** A word can come up if it carries **any** selected tag, so
`naval` on its own gives every naval unit of every faction, and `land` plus `easy maps` gives land
units and those maps together. A lobby with nothing selected has nothing in play: it says so and
Start is blocked until at least one category is picked.

Each chip row has **all** and **none** links, and there is a **Select everything** button under
the count. The lobby shows a live count of exactly how many words the current selection leaves.

**A tag with no enabled words behind it is never offered.** Delete or disable every Nomads unit
and the `nomads` chip disappears by itself; a whole group with nothing live in it is not drawn at
all. Nothing to clean up by hand.

The 20 faction-less words (mexes, pgens, radar, sonar, gateway, nuke, SMD, T1 PD and so on carry
the `neutral` tag) are **always kept when a faction filter is on**, because they belong to every
faction. Picking `uef` gives you UEF units plus those shared buildings, not a game without mexes.
That is the Factions group's **always include** tag, and it is editable like everything else.

### A round
1. A round is one full pass: every player draws once, in a shuffled order. `rounds` full passes,
   then the final scoreboard.
2. The drawer gets N word choices and a 20 second pick timer. On timeout one is picked for them.
   With `wordChoices = 1` this step is skipped entirely. Each choice carries the admin note under
   it ("T3 UEF assault bot"), so the drawer does not have to look the unit up. This is the only
   place a player ever sees a note, it goes to the drawer alone, and it disappears the moment the
   choice is made.
3. Everyone else sees the word as underscores, with the length and the spaces visible. Letters
   are revealed one at a time as the clock runs down. The lobby setting is a **minimum**: a long
   name earns one hint per five letters, so "Stealth Field Generator" gets four while "Wasp" gets
   the configured two. Hints never uncover more than 60% of the word.
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
- The board takes a share of the space the panels leave, keeping the 900x560 ratio. The share is
  80% by default and adjustable from 40% to 100% in the display settings. It is measured against
  the live size of its container, with a `ResizeObserver` behind it, so it can never grow over
  the toolbar when the toolbar appears.
- **The drawer gets a reference picture.** Every unit word carries the in-game build icon, shown
  under each option on the pick screen and then in a small floating panel while drawing. The
  panel can be dragged anywhere, resized, hidden and brought back with the eye button in the
  toolbar. It is per browser and only the drawer ever sees it. The picture also appears on the
  reveal screen once the word is out.
- Anyone who joins mid-turn gets the full drawing replayed instantly.
- Only the current drawer can draw. The server enforces it, the toolbar is simply hidden for
  everybody else.
- Works with mouse, pen and touch.

### Unit pictures

506 unit icons from the [etfreeman unit database](https://faforever.github.io/etfreeman-db/#/)
ship with the repo, bundled into `data/icons.bundle.json` so the whole set uploads as one file.
`data/icons.map.json` maps a normalised word to its icon.

On every start, any word that has never had an icon is matched against that map by name, so a
word list restored from an export picks its pictures up by itself and nothing you have edited is
touched. A word whose icon you clear stays cleared. **Match missing icons** on the Import/export
tab runs the same pass on demand.

Words with no match, map names for instance, simply have no picture until you upload one.

### The word pool counter

While setting up a lobby the host sees how many words the current filters leave, updating live as
chips are toggled. Each chip carries its own word count too. With nothing selected it reads
"242 words in the pool, everything is in play".

### The unit look-up

A search box sits under the player list, always visible, no button to press. Type a description
in any order, "aeon t1 scout" or "scout t1 aeon", and it lists the units whose admin note and tags
contain all of those words, with their pictures. It is there so people learn unit names instead of
having to go and look them up every time.

It searches the notes and tags only, never the word list wholesale, and the search runs on the
server so a client cannot pull the answers out of it. **Map entries are excluded**: anything with a
tag containing `map` never appears in the results, so difficulty tags cannot be fished either.

The host can switch it off per lobby.

### Sound

The speaker in the header opens a volume slider and an on/off switch, both remembered per browser.
Every sound is generated with the Web Audio API, so there are no audio files to ship or load:

- a rising two-note chime when you guess correctly, and a quieter blip when somebody else does
- a short descending phrase at the end of a turn, and a fanfare at the end of the game
- the clock: one tone at 30 and 20 seconds, then a sharper one at each of the last five

The clock itself sits between the word and the board, large, and turns red and pulses at
10 seconds.

### Display settings

The gear in the header opens a small panel with two sliders:

- **Interface size**, 70% to 160%, scaling the player list, chat, header and toolbar.
- **Drawing board**, 40% to 100% (default 80%), how much of the free space the white board takes.

Both are per browser, remembered in `localStorage`, and affect nobody else in the lobby.

The header sits above the scoreboard panel, so Leave, the Unit DB link and the gear stay
reachable while it is open.

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
  - *Note (admin only)* - what the unit actually is, e.g. "T3 UEF assault bot". Guessers never
    see it, and it is not on the reveal screen either. The only exception is the drawer's own
    pick screen, where it is shown under each choice so they know what they are being asked to
    draw.
  - *Also accepted* - alternative spellings that count as correct.
  - *Tags* - drive the lobby faction and type filters.
  - *On* - disabled words stay in the list but never come up in a game.
  - *Icon* - the picture the drawer sees. Click the thumbnail to pick another from the 506 unit
    icons that ship with the repo, upload your own image (under 2 MB), or clear it.
  - Search across every field, filter by enabled/disabled or by tag, 50/100/all per page.
  - Multi-select for bulk enable, disable, delete, add tag and remove tag.
- **Lobby defaults**: the settings every newly created lobby starts with.
- **Lobby filters**: the chip rows hosts see. Each group has a name, a comma separated tag list
  and an optional *always include* tag whose words bypass that group. Add or remove groups
  freely: tag some words `map` and add a group called Maps with the tag `map`, and hosts can
  filter to maps only. Below the editor is every tag currently in use with its word count, so
  you can see what is available to build a group from.
- **Live lobbies**: every lobby on the server, who is in it, what is being drawn right now, and
  a button to close one.
- **Import / export**: import plain lines or a JSON export. **Import only ever adds.** Words
  already in the list are skipped, nothing is overwritten and nothing is removed. Export
  downloads the whole list including disabled words.
  Nothing in the admin tab can destroy the word list in one action: there is no "reset to the
  shipped list" button and no "replace the whole list" import mode, because everyone who knows
  the admin password would be one click away from wiping it. Removing words is done deliberately,
  in the Words tab, with a confirmation.

Import line format, everything after the word optional:

```
Percival | T3 UEF assault bot | Perci, Percy | uef, land, t3
```

Aliases and tags are separated by **commas only**, never by spaces, so a tag can contain spaces:

```
Setons Clutch | 20x20 | Setons | map, easy maps
```

gives one word with two tags, `map` and `easy maps`. The same is true of the tag boxes in the
words table and the add-a-word form.

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
| `FAFSCRIBBL_EMPTY_MS` | `60000` | how long an empty lobby is held open, testing knob |

Uploaded icons live in `$DATA_DIR/icons/` and are served from `/icons/custom/...`, so they
survive a redeploy along with the word list.

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
data/icons.bundle.json  506 unit icons, base64, one file
data/icons.map.json     word to icon lookup used to fill icons in automatically
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
custom words, self-closing lobbies, the editable filter groups, the pool counter, tags that
contain spaces, opt-in filtering, icon matching and uploads, the unit look-up and its map
exclusion, hint scaling, and that no admin request can wipe the word list. 171 assertions.

To catch undefined identifiers, which `node --check` cannot:

```bash
npm i --no-save typescript
# tsconfig: allowJs, checkJs, noEmit, lib ["ES2020","DOM"], strict false, include public/*.js
./node_modules/.bin/tsc -p tsc-scan.json 2>&1 | grep "Cannot find name"
```
