# Random Albums — a Roon extension

A web UI that shows a screenful of random albums from your Roon library, with
**Play Now**, **Add to Queue**, **Play Next**, **Shuffle**, and **Start Radio**
actions targeting any of your zones. Refresh button reshuffles the wall.
Includes **instant whole-library search** (see below). Roon-style dark theme
(default) plus a light theme.

> The Roon API does not let third-party code navigate the Roon app itself, so
> the album detail view (art, tracks, action buttons) is rendered inside this
> UI. Tapping **Play Now** still plays through Roon on the zone you select.

## Install (Docker)

Each release ships a `*-docker.tar.gz`. Download it, build the image, and run:

```bash
wget https://github.com/meltface-80/Roon-Random-Albums-Extension/raw/main/roon-random-albums-v1.5.15-docker.tar.gz
tar -xzf roon-random-albums-v1.5.15-docker.tar.gz
cd roon-random-albums
docker build -t roon-random-albums:1.5.15 .
docker run -d \
  --name roon-random-albums \
  --restart unless-stopped \
  --network host \
  -v roon-random-albums-data:/app/data \
  roon-random-albums:1.5.15
```

`--network host` is required so the extension can discover your Roon Core on
the local network. The `-v` flag mounts a named Docker volume so that your
Roon pairing and accumulated label/logo cache survive container rebuilds.

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

## Migrating from a native install

If you're running an older native (non-Docker) install, the app will show a
migration banner automatically with copy-ready commands. Or follow these steps:

```bash
# 1. Download and build the Docker image
wget https://github.com/meltface-80/Roon-Random-Albums-Extension/raw/main/roon-random-albums-v1.5.15-docker.tar.gz
tar -xzf roon-random-albums-v1.5.15-docker.tar.gz
cd roon-random-albums
docker build -t roon-random-albums:1.5.15 .

# 2. Run the Docker container
docker run -d \
  --name roon-random-albums \
  --restart unless-stopped \
  --network host \
  -v roon-random-albums-data:/app/data \
  roon-random-albums:1.5.15

# 3. Stop and disable the native service
sudo systemctl stop roon-random-albums
sudo systemctl disable roon-random-albums
```

Your Roon pairing and label cache are stored under `/app/data` inside the
named Docker volume `roon-random-albums-data`, so they persist even if the
container is removed and recreated.

## Updating

Updates are detected automatically on startup and every 6 hours. Install with
one tap from the **settings cog → Updates → Check for updates** in the web UI,
or wait for the update toast to appear. The container restarts itself to apply
the update.

To force an immediate check (e.g. right after a new release):

```bash
docker restart roon-random-albums
```

To upgrade to a new version manually:

```bash
docker stop roon-random-albums && docker rm roon-random-albums
wget https://github.com/meltface-80/Roon-Random-Albums-Extension/raw/main/roon-random-albums-v{NEW_VERSION}-docker.tar.gz
tar -xzf roon-random-albums-v{NEW_VERSION}-docker.tar.gz
cd roon-random-albums
docker build -t roon-random-albums:{NEW_VERSION} .
docker run -d --name roon-random-albums --restart unless-stopped --network host -v roon-random-albums-data:/app/data roon-random-albums:{NEW_VERSION}
```

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
docker run -d ... -e RRA_DEBUG=1 roon-random-albums:1.5.15
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
  → The container image may be old; rebuild using the steps in the Updating
  section above. From v1.5.9 onward this is fixed automatically.

## File layout

```
roon-random-albums/
├── Dockerfile
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

## License

Roon Random Albums is released under the **MIT License**. The full text is in
the [`LICENSE`](./LICENSE) file. In short: do what you like with it, just keep
the copyright and license notice. It comes with no warranty.

Copyright (c) 2026 Lewis Menzies (Music Duck / MusicD).
