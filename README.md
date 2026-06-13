# Random Albums — a Roon extension

A web UI that shows a screenful of random albums from your Roon library, with
**Play Now**, **Add to Queue**, **Play Next**, **Shuffle**, and **Start Radio**
actions targeting any of your zones. Refresh button reshuffles the wall.
Includes **instant whole-library search** (see below). Roon-style dark theme
(default) plus a light theme.

> The Roon API does not let third-party code navigate the Roon app itself, so
> the album detail view (art, tracks, action buttons) is rendered inside this
> UI. Tapping **Play Now** still plays through Roon on the zone you select.

## Requirements

- A machine running Roon Server (tested on DietPi).
- **Node.js 18 or newer.** Check with `node -v`.
- **git** (npm needs it to fetch the Roon API libraries from GitHub).

Install missing prerequisites:

```bash
# DietPi / Debian / Ubuntu
sudo apt-get update
sudo apt-get install -y git
# If Node is missing or too old:
sudo dietpi-software install 9     # DietPi
# or use NodeSource on plain Debian/Ubuntu
```

## Install

```bash
# 1. Put the project somewhere persistent
sudo mkdir -p /opt/roon-random-albums
sudo chown $USER:$USER /opt/roon-random-albums
# Copy roon-random-albums.tar.gz to the box, then:
mv ~/roon-random-albums.tar.gz /opt/
cd /opt
tar -xzf roon-random-albums.tar.gz
cd roon-random-albums

# 2. Install dependencies (needs internet + git)
npm install

# 3. Run it (recommended: the launcher enables one-tap updates)
npm start
# ...or run the server directly, without the auto-update restarter:
# node index.js
```

You should see:

```
Roon Random Albums UI listening on http://0.0.0.0:3399
Make sure to authorise the extension in Roon → Settings → Extensions.
```

Now:

1. Open any Roon remote.
2. **Settings → Extensions** — you'll see **Random Albums**. Click **Enable**.
3. Browse to `http://<your-server-ip>:3399`.
4. Pick a zone in the top-right, tap albums to play / queue.

## Search

The search bar lives behind the **magnifier icon** in the header (between the
theme and refresh buttons). Tap it to slide the bar open; it searches your
**whole** library and updates as you type. The **✕** in the bar works in two
stages: the first tap clears the text, the second tap closes the bar. Search is
prefix-aware and case-insensitive, so typing `The T` (or `the t`, or even
`thet`) immediately surfaces the band **The The** — the kind of short,
common-word query Roon's own search tends to ignore. Tapping a result opens the
same album view as the wall, with the usual Play / Queue actions.

How it works: on startup the extension walks your album list once and keeps a
small index in memory, then matches locally on each keystroke (instant, no
round-trip per letter). Matching is tiered — exact title, title prefix,
per-word prefix (the "The The" case), gapped multi-word (`dark moon` →
*Dark Side of the Moon*), artist match, then a loose typo-tolerant fallback —
with title hits ranked above artist hits.

The index refreshes automatically: it's rebuilt if it's more than 10 minutes
old, and a background check every 5 minutes rebuilds it whenever your album
count changes (e.g. after an import). You can also force a rebuild with
`curl -X POST http://<your-server-ip>:3399/api/reindex`.

Endpoints, if you want them: `GET /api/search?q=…&limit=60`,
`GET /api/search-status`, `POST /api/reindex`.

You only authorise once; subsequent launches reconnect automatically.

## Run as a systemd service (autostart on boot)

Create `/etc/systemd/system/roon-random-albums.service`:

```ini
[Unit]
Description=Roon Random Albums
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/roon-random-albums
ExecStart=/usr/bin/node /opt/roon-random-albums/index.js
Restart=on-failure
RestartSec=5
User=root
Environment=NODE_ENV=production
# Change port if 3399 clashes:
# Environment=PORT=3399

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now roon-random-albums
sudo systemctl status roon-random-albums
journalctl -u roon-random-albums -f          # live logs
```

## Sharing with others — make a self-contained tarball

Once you've successfully run `npm install`, you can build a tarball that
includes `node_modules`, so recipients don't need internet or git:

```bash
cd /opt
tar -czf roon-random-albums-bundled.tar.gz roon-random-albums/
```

Recipients then only need Node.js:

```bash
tar -xzf roon-random-albums-bundled.tar.gz
cd roon-random-albums
node index.js
```

## Configuration

| Env var     | Default | What it does |
|-------------|---------|--------------|
| `PORT`      | `3399`  | HTTP port the UI listens on |
| `RRA_DEBUG` | —       | Set to `1` for verbose logging |

### Album metadata sources

No keys required. The extension pulls in three pieces of external metadata:

- **Release year** — MusicBrainz (free, public API).
- **Album editorial review** — scraped from the public Qobuz album page when
  it exists; falls back to the Wikipedia article's intro paragraph.
- **Artist bio** — Wikipedia article intro.

Each source's results are independently checked against the album title and
artist name before being shown. If a match can't be found, the section is
simply hidden instead of showing data for the wrong album.

> **Caveat:** Qobuz has no official public API, so this uses light HTML
> scraping. If Qobuz changes their page markup, the review section may stop
> working — Wikipedia will still cover most albums.

The "screenful" album count is computed client-side from viewport size, so it
adapts between phones, tablets, and desktop browsers automatically.

## Customising

- **Albums per screen**: edit `computeAlbumCount()` in `public/app.js`. Cap is
  96, enforced server-side in `index.js`.
- **Image size**: change `size=500` / `size=800` query params in
  `public/app.js`. Larger = sharper, slower.
- **Action button order**: edit the `order` array in `public/app.js`.

## Troubleshooting

- **`npm install` fails with `git: command not found`**
  → `sudo apt-get install -y git`, then re-run.
- **`npm install` 404s on `node-roon-api`**
  → Your `package.json` still has the old `^1.0.0` versions. The fixed file
  uses `github:RoonLabs/...` references. Re-extract the tarball.
- **"Waiting for Roon Core" never goes away**
  → Roon → Settings → Extensions → click **Enable** on *Random Albums*.
- **Play Now does nothing**
  → Confirm a real zone is selected in the dropdown.
- **"No zones available"**
  → No active outputs visible to Roon yet. Wake a device or pick one in
  Roon's own remote first.

## File layout

```
roon-random-albums/
├── package.json
├── LICENSE                 # MIT
├── launcher.js             # supervises index.js; applies updates on restart
├── index.js                # Roon API + Express server
├── lib/
│   ├── updater.js          # GitHub release check + download/apply
│   └── radio.js            # random album radio decision logic
├── public/
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   └── sharecard.js
└── README.md
```

## Random album radio

Open the settings cog and turn on **Random album radio** for the selected zone.
While it's on and **Roon Radio is off** for that zone, the extension keeps the
music going with whole random albums: as the current album reaches its last
track it queues another at random (gaplessly), and if the zone is idle or its
queue runs out it starts a fresh one. Turn it off, or turn Roon Radio back on,
and the extension stays out of the way. The choice is remembered per zone across
restarts.

## Updating

The extension checks your GitHub repo for a newer release and can install it
in place — no SSH needed. You can trigger the update from **either**:

- **The web app** — a toast appears under the header when a new version exists,
  with an **Update** button. It shows progress and reloads when the new version
  is up.
- **Roon → Settings → Extensions → Random Albums → Settings** — shows the
  current version and, when an update is available, an **Install update**
  dropdown. Choose "Install … now" and **Save**.

How it works: the running app downloads the release tarball, unpacks it,
overlays the files onto the install dir (your Roon pairing in `config.json` and
your `node_modules` are left untouched), runs `npm install` only if dependencies
changed, then exits with code **75** to ask for a restart.

Restart behaviour depends on how you run it:

- **`npm start` (launcher)** — recommended. The launcher catches exit 75,
  applies the staged build, and relaunches cleanly. Works anywhere.
- **`node index.js` under systemd / Docker / pm2** — also fine: the app applies
  the files itself and exits 75, and your supervisor restarts it
  (`Restart=on-failure` or `always`, or Docker `--restart`).
- **`node index.js` with no supervisor** — the files are applied but you'll need
  to start it again yourself. Use `npm start` to avoid this.

If anything fails (no network, bad download), the update is simply not applied
and the current version keeps running. Optional: set `RRA_GITHUB_TOKEN` to raise
GitHub's API rate limit or to read a private repo. Requires `tar` on PATH
(standard on Linux/macOS/NAS).

### Publishing a new build

1. Bump `version` in `package.json` (semver: patch for fixes, minor for
   features, major for breaking changes) and commit.
2. Create a **GitHub Release** with a tag like `v1.3.0`.
3. Optionally attach the built tarball (`roon-random-albums-v1.3.0.tar.gz`) as a
   release asset — the updater prefers a `.tar.gz`/`.tgz` asset, and otherwise
   falls back to GitHub's auto-generated source tarball. If you don't use
   Releases at all, it falls back to your highest semver **tag**.

Within ~6 hours (or immediately if someone hits **Check** / reopens the app),
every install sees the new version and can update with one tap.

## License

Roon Random Albums is released under the **MIT License**. The full text is in
the [`LICENSE`](./LICENSE) file. In short: do what you like with it, just keep
the copyright and license notice. It comes with no warranty.

Copyright (c) 2026 Lewis Menzies (Music Duck / MusicD).
