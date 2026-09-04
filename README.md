# fafscribbl

Draw and guess Forged Alliance Forever. One player draws, everyone else types guesses in the
chat. Skribbl-style, but the whole word list is FAF related: units, buildings, maps, and whatever
else you add to it. The interface calls them **words**, not units, because the list stopped being
units only a long time ago.

No FAF login and no accounts: players type a name and join a lobby by link or 5-letter code.

There is a single player challenge too: every drawing people make in a lobby is kept, and the
challenge replays ten of them against the clock for a spot on a global highscore.

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
- The creator is the host. If the host leaves or drops out, the crown moves to the next connected
  player automatically, in join order, and that player gets every host control including pause.
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
| Reference pictures | on / off | on |
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
   the points scored. The reveal panel covers the whole middle column, not just the board, and
   the picture and the word stay pinned while the list of players scrolls, so a full lobby on a
   short window never pushes the unit off the top. On a window under 760px tall the picture sits
   right beside the word instead of above it, to hand the list back the space.
8. The host can pause at any point and nothing moves until he starts it again. See **Pause**.

### Pause

The host has a **Pause** button in the header from the moment a game starts. Press it and
everything stops: the clock freezes on the second it was on, the drawer cannot draw, guesses and
chat are held, and the unit look-up stops answering. Everybody sees a Paused panel over the board,
which also hides the half-finished drawing so nobody can study it with the clock stopped.

Press it again and the turn carries on with exactly the time it had. Every timer that drives the
turn (the pick timer, the draw clock, the letter hints, the reveal screen and the end-of-game
countdown) is frozen with the time it had left and put back untouched, and the deadlines all move
forward by the length of the pause, so a pause costs the drawer nothing.

There is no vote and no limit. It is the host's button, for as long as he wants, which is the
point: people play this alongside another game. A turn that starts during a pause (the drawer
left, say) starts paused too rather than quietly running down.

### Phones

The site works on a phone, and nothing about it changes on a desktop. Under 860px wide the
layout becomes one column: the board full width at the top, then a player strip you swipe
sideways, then the chat. The header collapses to two rows, controls above and the word on its own
line underneath, and the wordmark, the lobby code pill and the Unit DB link step aside to make
room. The reveal, the pick screen and the pause panel take the whole screen rather than the board
rectangle, and the unit look-up becomes a sheet you pull up from the magnifier in the header.

Drawing works with a finger. Every size in the mobile block is a fixed pixel value rather than a
multiple of the interface-size slider, because that slider is a desktop comfort setting stored per
browser and a 390px screen cannot afford somebody's 160%.

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
- **The drawer can look at the picture.** Every unit word carries the in-game build icon, shown
  under each option on the pick screen and available while drawing behind a
  **What does this look like** button in the toolbar. The picture is **hidden until that button
  is pressed**, and every turn starts hidden again, so seeing it is always a deliberate act. The
  button only appears when that particular word actually has a picture, and only people who are
  allowed to know the word get it. The panel parks itself in the empty gutter beside the board when there is one, and can
  be dragged, resized and closed. Only its title bar takes pointer events, so you can draw
  straight through the picture if it is over the board. The picture also appears on the reveal
  screen once the word is out. The **Reference pictures** lobby setting turns the whole thing off, and
  then no icon is sent to anybody.
- Anyone who joins mid-turn gets the full drawing replayed instantly.
- Only the current drawer can draw. The server enforces it, the toolbar is simply hidden for
  everybody else.
- Works with mouse, pen and touch.

### Reference pictures

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
"242 words in the pool, everything is in play". The front page counts the same pool as
"faf related words", since the list has grown well past units.

### Saved drawings

Every turn that ends with something actually drawn on the board is saved: the strokes, the word,
the picture that went with it and who drew it. Blank and near-blank pages are dropped
(fewer than 15 strokes), and lobby-only custom words are never saved, so the challenge cannot
show a word that is not in the list any more.

The store keeps the most recent 1000 drawings, one gzipped file each plus a small index, so a
save is one small write and nothing is ever rewritten wholesale. A busy drawing is about 18 KB
compressed, so a full store is roughly 18 MB. When the cap is reached the oldest one is deleted.

If the process is killed between writing a drawing and writing the index, the drawing is picked
back up on the next boot rather than being orphaned.

### Single player challenge

`/solo`, and a card on the front page. Ten random drawings, forty seconds each, one drawing at a
time. The strokes replay over the first ten seconds exactly as they were drawn.

- Scoring is the same formula as a lobby round: `50 + round(350 * fraction of the clock left)`,
  so 400 for an instant answer down to 50 at the buzzer.
- Two letters are revealed as the clock runs down, at the halfway mark and again near the end,
  and never more than 60% of the word.
- Between drawings the answer and its picture are shown. That pause is free: the next clock does
  not start until the browser asks for the next drawing.
- Giving up still banks what has been scored so far.
- The **unit look-up** is there too, behind a Look up button in the header rather than pinned
  open, since the page is one centred column. Same search, same server side rules, over
  `POST /api/solo/lookup` instead of the socket. It needs a live run, so it is not an open
  word-list endpoint, and it is rate limited per run.
- The global highscore keeps the top 50 runs, and shows the top 20.

**The answers never leave the server.** The browser is sent the strokes and a letter mask, and
every guess is checked server side, so the score is worth something. Run starts are rate limited
per IP.

### The unit look-up

Available in a lobby and in the single player challenge. The search itself lives in
`Store.lookup()` so both behave identically.

A search box sits at the bottom of the left column, always visible, no button to press. Type a description
in any order, "aeon t1 scout" or "scout t1 aeon", and it lists the units whose admin note and tags
contain all of those words, with their pictures. It is there so people learn unit names instead of
having to go and look them up every time.

It searches the notes and tags only, never the word list wholesale, and the search runs on the
server so a client cannot pull the answers out of it. **Map entries are excluded**: anything with a
tag containing `map` never appears in the results, so difficulty tags cannot be fished either.

The host can switch it off per lobby.

### Sound

The speaker in the header opens a volume slider, a master on/off, and a switch for each effect
on its own, all remembered per browser. Ticking one plays it, so you can hear what you are
turning on. Every sound is generated with the Web Audio API, so there are no audio files to ship
or load:

| Effect | Sound |
|---|---|
| You guess correctly | rising two-note chime |
| Somebody else guesses | short quiet blip |
| A new turn starts | two-note lift |
| End of a turn | short descending phrase |
| End of the game | four-note fanfare |
| Clock at 30 and 20 seconds | single soft tone |
| Final 5 second countdown | sharper tone on each of 5, 4, 3, 2, 1 |

The clock sits directly under the word, on the same centre line, and turns red and pulses at
10 seconds. The header is a three column grid so the word block is always on the page centre
whatever the sides weigh, which is what keeps the two aligned at any interface size.

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
- **Saved drawings**: every stored drawing, newest first, with the word it was drawn for and
  who drew it. The thumbnails are the real strokes, replayed; click one to see it full size.
  Delete one, delete a selection, delete every drawing, or reset the single player highscore.
  Deleting drawings only shrinks what the challenge can show, it never touches the word list.
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
| `FAFSCRIBBL_MAX_DRAWINGS` | `1000` | how many saved drawings to keep |
| `FAFSCRIBBL_MIN_OPS` | `15` | strokes a drawing needs before it is worth keeping |

Uploaded icons live in `$DATA_DIR/icons/` and are served from `/icons/custom/...`, so they
survive a redeploy along with the word list. Saved drawings live in `$DATA_DIR/drawings/` and the
single player highscore in `$DATA_DIR/highscores.json`, on the same volume.

If `ADMIN_PASSWORD` is not set the server generates one, prints it to the container log and
carries on, so a missing variable never stops the site from running. It changes on every restart,
so set it properly.

### Nginx Proxy Manager

Two switches on the proxy host, both of which have bitten this stack before:

- **Websockets Support: ON.** The whole game runs over a WebSocket on `/ws`. Without this the
  page loads and then never connects. The front page says so if it cannot get through.
- **Cache Assets: OFF.** Otherwise updates do not show up after a container restart.

### Storage

`$DATA_DIR/fafscribbl.json` holds the word list and the default lobby settings. Written
atomically (temp file plus rename). A corrupt file is moved aside and the shipped word list is
loaded instead, rather than the server refusing to start.

Alongside it on the same volume:

```
$DATA_DIR/fafscribbl.json     word list and lobby defaults
$DATA_DIR/icons/              pictures uploaded in the admin
$DATA_DIR/drawings/           saved drawings, gzipped, plus index.json
$DATA_DIR/highscores.json     single player challenge board
```

Lobbies, players and live scores are in memory only. Restarting the container ends every game in
progress. That is deliberate: nothing about a live lobby is worth persisting. Finished drawings
are the exception, and they are written as each turn ends.

---

## Architecture

```
server.js            HTTP routing, static files, admin API, WebSocket wiring
lib/ws.js            RFC 6455 WebSocket server, ~200 lines, no dependencies
lib/game.js          rooms, turn engine, scoring, chat rules, drawing relay
lib/words.js         normalisation, Levenshtein, close-guess and leak detection, masking
lib/store.js         JSON persistence
lib/gallery.js       saved drawings, gzipped one file each, capped and self-healing
lib/solo.js          single player challenge sessions, scoring and the highscore board
data/words.seed.json the shipped word list
data/icons.bundle.json  506 unit icons, base64, one file
data/icons.map.json     word to icon lookup used to fill icons in automatically
public/              index.html, app.js, solo.html, solo.js, admin.html, admin.js,
                     style.css, favicon.svg
test/run.js          end to end test suite
```

The server is authoritative for everything: who may draw, who may start, what the mask looks
like per player, who sees which chat message, and every score. The client renders and sends
intent, nothing more.

### WebSocket protocol

The single player challenge talks over HTTP instead: `/api/solo/start`, `/guess`, `/timeup`,
`/next`, `/hint`, `/lookup`, `/finish` and the public `/highscores`.

Client to server: `hello`, `chat`, `draw`, `begin`, `undo`, `clearCanvas`, `pick`, `start`,
`settings`, `kick`, `skip`, `pause`, `lobby`, `lookup`, `sync`, `ping`.

Server to client: `joined`, `state`, `players`, `settings`, `chat`, `draw`, `canvas`, `mask`,
`reveal`, `choices`, `turnend`, `gameend`, `lookup`, `error`, `kicked`, `closed`, `pong`.
The pause is carried on `state` as `paused` and `pausedLeft`, not as a message of its own, so a
client that reconnects mid-pause gets it for free.

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
exclusion, hint scaling, the picture toggle, the saved drawing store and its cap, and the whole
single player run from start to highscore, including that the answer is never sent to the
browser and that a finished run cannot be banked twice, the challenge look-up and its rate limit,
the host pause down to the second the clock is handed back, and the host role moving when the
host leaves. 265 assertions.

The browser suites additionally drive a real iPhone viewport: the layout, the look-up sheet,
drawing with a finger, and that a 1500px desktop is left exactly as it was.

To catch undefined identifiers, which `node --check` cannot:

```bash
npm i --no-save typescript
# tsconfig: allowJs, checkJs, noEmit, lib ["ES2020","DOM"], strict false, include public/*.js
./node_modules/.bin/tsc -p tsc-scan.json 2>&1 | grep "Cannot find name"
```
