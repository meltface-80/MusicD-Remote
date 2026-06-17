<div align="center"> 

<img width="1536" height="1024" alt="image" src="https://github.com/user-attachments/assets/fc1dd26e-db7f-4e27-8f66-b0ab74db89e3" />

# Random Albums — a Roon extension

A web UI that shows a screenful of random albums from your Roon library, with
**Play Now**, **Add to Queue**, **Play Next**, **Shuffle**, and **Start Radio**
actions targeting any of your zones. Refresh button reshuffles the wall.
Includes **instant whole-library search** (see below). Roon-style dark theme
(default) plus a light theme.

> The Roon API does not let third-party code navigate the Roon app itself, so
> the album detail view (art, tracks, action buttons) is rendered inside this
> UI. Tapping **Play Now** still plays through Roon on the zone you select.

</div>

## Install (Docker)

```bash
wget https://github.com/meltface-80/Roon-Random-Albums-Extension/raw/main/roon-random-albums-v1.5.13-docker.tar.gz
tar -xzf roon-random-albums-v1.5.13-docker.tar.gz
cd roon-random-albums
docker build -t roon-random-albums:1.5.13 .
docker run -d \
  --name roon-random-albums \
  --restart unless-stopped \
  --network host \
  -v roon-data:/app/data \
  roon-random-albums:1.5.13
```

- `--network host` — required so the extension can discover your Roon Core.
- `-v roon-data:/app/data` — creates a named Docker volume that persists your
  Roon pairing and label database across every future upgrade.

You should see the extension appear in **Roon → Settings → Extensions**. Click
**Enable**, then browse to `http://<your-server-ip>:3399`.

### Install Docker

If Docker isn't installed yet:

```bash
# DietPi
sudo dietpi-software install 162

# Debian / Ubuntu
curl -sSL https://get.docker.com | sh
```

## Upgrading from any previous version

```bash
docker stop roon-random-albums && docker rm roon-random-albums
wget https://github.com/meltface-80/Roon-Random-Albums-Extension/raw/main/roon-random-albums-v1.5.13-docker.tar.gz
tar -xzf roon-random-albums-v1.5.13-docker.tar.gz
cd roon-random-albums
docker build -t roon-random-albums:1.5.13 .
docker run -d \
  --name roon-random-albums \
  --restart unless-stopped \
  --network host \
  -v roon-data:/app/data \
  roon-random-albums:1.5.13
```

Docker reuses the existing `roon-data` volume automatically — your label
database and Roon pairing carry over with no extra steps.

## Migrating from a native install

The app shows a migration banner automatically with copy-ready commands.
Or follow these steps manually:

```bash
# 1. Download and build
wget https://github.com/meltface-80/Roon-Random-Albums-Extension/raw/main/roon-random-albums-v1.5.13-docker.tar.gz
tar -xzf roon-random-albums-v1.5.13-docker.tar.gz
cd roon-random-albums
docker build -t roon-random-albums:1.5.13 .

# 2. Run
docker run -d \
  --name roon-random-albums \
  --restart unless-stopped \
  --network host \
  -v roon-data:/app/data \
  roon-random-albums:1.5.13

# 3. Stop the native service
sudo systemctl stop roon-random-albums
sudo systemctl disable roon-random-albums
```

## Updating (in-app)

Updates are detected automatically on startup and every 6 hours. Install with
one tap from the **settings cog → Updates → Check for updates** in the web UI,
or wait for the update toast to appear. The container restarts itself to apply
the update. The label database is preserved — it lives in the Docker volume,
outside the update path.

To force an immediate check:

```bash
docker restart roon-random-albums
```

## Label database

Record label names, MusicBrainz IDs, and Fan Art TV logo URLs are stored in a
SQLite database at `data/cache/labels.db` inside the `roon-data` Docker volume.
This file is **never touched by the updater** — it accumulates permanently.

Scanning is triggered the first time you open the Labels view and runs in the
background (~1 req/sec against Discogs and MusicBrainz, rate-limited). Logo
fetches happen after scanning in batches of 5 concurrent requests. On restart,
everything loads from the database instantly with no network calls.

## Search

The search bar lives behind the **magnifier icon** in the header. Tap it to
slide the bar open; it searches your **whole** library and updates as you type.
The **✕** in the bar works in two stages: the first tap clears the text, the
second tap closes the bar. Search is prefix-aware and case-insensitive, so
typing `The T` immediately surfaces the band **The The** — the kind of
short, common-word query Roon's own search tends to ignore. Tapping a result
opens the same album view as the wall, with the usual Play / Queue actions.

How it works: on startup the extension walks your album list once and keeps a
small index in memory, then matches locally on each keystroke (instant, no
round-trip per letter). Matching is tiered — exact title, title prefix,
per-word prefix, gapped multi-word (`dark moon` → *Dark Side of the Moon*),
artist match, then a loose typo-tolerant fallback — with title hits ranked
above artist hits.

The index refreshes automatically every 10 minutes and whenever your album
count changes. You can also force a rebuild with
`curl -X POST http://<your-server-ip>:3399/api/reindex`.

## Random album radio

Open the settings cog and turn on **Random album radio** for the selected
zone. While it's on and **Roon Radio is off** for that zone, the extension
keeps the music going with whole random albums: as the current album reaches
its last track it queues another at random, and if the zone goes idle it
starts a fresh one. Turn it off, or turn Roon Radio back on, and the extension
stays out of the way. The choice is remembered per zone across restarts.

## Configuration

| Env var     | Default | What it does |
|-------------|---------|--------------|
| `PORT`      | `3399`  | HTTP port the UI listens on |
| `RRA_DEBUG` | —       | Set to `1` for verbose logging |

Pass extra env vars with `-e` in the `docker run` command:

```bash
docker run -d ... -e RRA_DEBUG=1 roon-random-albums:1.5.13
```

### Album metadata sources

No keys required. The extension pulls in three pieces of external metadata:

- **Release year** — MusicBrainz (free, public API).
- **Album editorial review** — scraped from the public Qobuz album page when
  it exists; falls back to the Wikipedia article's intro paragraph.
- **Artist bio** — Wikipedia article intro.

## Customising

- **Albums per screen**: edit `computeAlbumCount()` in `public/app.js`. Cap is
  96, enforced server-side in `index.js`.
- **Image size**: change `size=500` / `size=800` query params in
  `public/app.js`. Larger = sharper, slower.
- **Action button order**: edit the `order` array in `public/app.js`.

## Troubleshooting

- **"Waiting for Roon Core" never goes away**
  → Roon → Settings → Extensions → click **Enable** on *Random Albums*.
- **Play Now does nothing**
  → Confirm a real zone is selected in the dropdown.
- **"No zones available"**
  → No active outputs visible to Roon yet. Wake a device or pick one in
  Roon's own remote first.
- **Update fails with "extraction failed"**
  → Rebuild the container from the latest tarball using the Upgrading steps
  above.

## File layout

```
roon-random-albums/
├── docker-compose.yml
├── Dockerfile
├── package.json
├── LICENSE                 # MIT
├── CHANGELOG.md
├── launcher.js             # supervises index.js; applies updates on restart
├── index.js                # Roon API + Express server
├── lib/
│   ├── updater.js          # GitHub release check + download/apply
│   └── radio.js            # random album radio decision logic
├── data/
│   └── labels-override.json  # shipped label corrections (updated with releases)
└── public/
    ├── index.html
    ├── style.css
    ├── app.js
    └── sharecard.js

# Runtime data (inside the roon-data Docker volume — never wiped on update):
/app/data/
├── config.json             # Roon pairing
└── cache/
    └── labels.db           # SQLite: label names, MBIDs, logo URLs
```

## License

Roon Random Albums is released under the **MIT License**. The full text is in
the [`LICENSE`](./LICENSE) file. In short: do what you like with it, just keep
the copyright and license notice. It comes with no warranty.

Copyright (c) 2026 Lewis Menzies (Music Duck / MusicD).
