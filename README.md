<div align="center"> 

<img width="1536" height="1024" alt="image" src="https://github.com/user-attachments/assets/fc1dd26e-db7f-4e27-8f66-b0ab74db89e3" />

</div>

# Random Albums + Labels — a Roon extension

A web UI that shows a screenful of random albums from your Roon library, with instant whole-library search, playback actions targeting any zone, and more.

> The Roon API does not let third-party code navigate the Roon app itself, so the album detail view (art, tracks, action buttons) is rendered inside this UI. Tapping **Play Now** still plays through Roon on the zone you select.


## What's new since v1.5.49

**v1.5.72** is the current release. Here's a summary of everything added or improved since v1.5.49.

### Label browser

- **Label in album modal** — the record label now appears on the subtitle line alongside artist and year (e.g. `Kraftwerk · 1974 · Parlophone UK`). Tapping the label name navigates directly to that label's albums in the Labels browser.
- **Label merge** — long-press any label tile to enter select mode, tap two or more labels, then tap **Merge**. The first tile tapped becomes the merge target. Merges survive restarts and rescans. To undo, tap the "N merged" indicator on a tile and remove individual merges one at a time.
- **Logo picker** — tap the photo icon in a label's album header to open the logo picker. It searches Discogs automatically and shows up to six logo candidates as thumbnails — tap one to save immediately. Or paste any direct image URL. The image is downloaded and cached locally so it works even if the source URL changes.
- **Force rescan** — a **Force rescan** button in Settings clears the label name cache (logos and MBIDs are kept) and kicks off a fresh scan from all sources. Useful after importing new albums or if a label looks wrong.
- **Label fragmentation fixes** — labels like `"A&M Records, Inc."`, `"A&M Records"`, and `"A&M"` now correctly consolidate into one tile. Trailing punctuation and corporate suffixes are stripped progressively.

### Album wall

- **Multi-select albums** — long-press any album tile to enter select mode. Tap more tiles to add them, then use the action bar at the bottom to **Play Now** or **Queue** all selected albums at once. Play Now starts the first and queues the rest; albums 2–N are sent to Roon in parallel so the wait is minimal.
- **Play count badges** — album tiles show a small "N×" badge if that album appears in your play history, so you can see at a glance what you've heard before.

### Discogs & FanArt.tv integration

- **Discogs token in Settings** — enter your Discogs personal access token via the gear icon → Discogs token. No environment variables or config files needed; it is stored in your Docker volume and survives updates.
- **FanArt.tv key in Settings** — same for your FanArt.tv API key. Enter it in Settings → FanArt.tv key.
- **Improved logo search** — Discogs logo fetches now handle labels with leading symbols (e.g. `~scape`, `[PIAS]`, `(4AD)`) correctly. Placeholder/spacer images are filtered out automatically. Network errors can retry on the next scan; only definitive "not found" results are cached.

### Scan pipeline

- **Scan never locks up** — if any pass throws an exception, the scan now resets cleanly so the next auto-rescan or manual rescan can proceed.
- **Accurate progress bar** — the bar tracks all five passes correctly and never exceeds 100% or freezes mid-scan.
- **MusicBrainz MBID caching** — failed MBID lookups are now cached for the session so MusicBrainz isn't re-queried for the same label on every scan cycle.

### Other

- **Random Album Radio reliability** — fixed edge cases where radio would auto-start after a Roon restart or container restart when it should have stayed stopped.

---

## Setting up Discogs and FanArt.tv API keys

Both are free and significantly improve label logo coverage.

### Discogs personal access token

Discogs is used to find label names for albums that iTunes and MusicBrainz miss, and to fetch label logos.

1. Sign in (or register free) at [discogs.com](https://www.discogs.com)
2. Go to **Settings → Developers** → click **Generate new token**
3. Copy the token
4. In the extension, tap the gear icon → paste into **Discogs token** → tap **Save**

### FanArt.tv API key

FanArt.tv provides high-quality label logos for labels that have a MusicBrainz MBID.

1. Register free at [fanart.tv](https://fanart.tv)
2. Go to your profile → **API key** (top right menu)
3. Copy the key shown there
4. In the extension, tap the gear icon → paste into **FanArt.tv key** → tap **Save**

---

> **Note on label accuracy** — an album may appear under a label that differs from the one shown in Roon's own album view. This is usually correct: many albums were released under multiple labels simultaneously (for example, Daughtry's *Baptized* was released under 19 Recordings, RCA, and Sony Music). The extension shows whichever label your file tags or the scan sources attribute to the album in the case of being a Qobuz or Tidal version.

---

## Features

- **Random album grid** — fills your screen with random picks from your full library, refreshed on demand
- **Instant search** — whole-library search with results as you type
- **Album detail** — full track listing, play/queue actions, release year, label link, editorial review, and artist bio
- **Now Playing** — live panel showing the current track with album art and transport controls
- **Play unheard** — one tap to find and play an album not in your listening history; falls back to anything not played in the last 30 days once your whole library has been heard
- **Random Album Radio** — automatically queues a new random album when your queue runs dry, preferring albums not recently played
- **Record labels** — browse your library by label, with logos from FanArt.tv and Discogs where available
- **Label merge** — consolidate duplicate or variant label tiles into one
- **Multi-select** — select multiple album tiles and play or queue them all at once
- **Filters** — narrow the random pool by genre, decade, tag, or label
- **Artist view** — tap any artist name to see all their albums in your library
- **Share card** — generates a 1200×600 PNG of the current album, ready to share
- **In-app updater** — checks for new releases automatically; install with one tap from Settings

---

## Install (Docker)

```bash
sudo mkdir -p /opt/roon-random-albums
cd /opt/roon-random-albums
wget https://github.com/meltface-80/Roon-Random-Albums-Extension/releases/download/v1.5.72/roon-random-albums-v1.5.72-docker.tar.gz
tar -xzf roon-random-albums-v1.5.72-docker.tar.gz
docker build -t roon-random-albums:1.5.72 .
docker run -d \
  --name roon-random-albums \
  --restart unless-stopped \
  --network host \
  -v roon-random-albums-data:/app/data \
  -v /your/path/to/Music:/music:ro \
  roon-random-albums:1.5.72
```

`--network host` is required so the extension can discover your Roon Core on the local network. The `-v roon-random-albums-data` flag mounts a named Docker volume so that your Roon pairing, play history, and label cache survive container rebuilds. The `-v .../Music:/music:ro` flag mounts your music directory read-only so the extension can read label tags directly from your files — this is optional but gives the most accurate label data. Adjust the path to match your music library location.

You should see the extension appear in **Roon → Settings → Extensions** under **MusicD**. Click **Enable**, then browse to `http://<your-server-ip>:3399`.

### Install Docker

If Docker isn't installed yet:

```bash
# DietPi
sudo dietpi-software install 162

# Debian / Ubuntu
curl -sSL https://get.docker.com | sh
```

## Updating

```bash
sudo docker stop roon-random-albums
sudo docker rm roon-random-albums
sudo rm -f /opt/roon-random-albums/roon-random-albums-vPREVIOUS-docker.tar.gz
cd /opt/roon-random-albums
wget https://github.com/meltface-80/Roon-Random-Albums-Extension/releases/download/vNEW/roon-random-albums-vNEW-docker.tar.gz
tar -xzf roon-random-albums-vNEW-docker.tar.gz
docker build -t roon-random-albums:NEW .
docker run -d \
  --name roon-random-albums \
  --restart unless-stopped \
  --network host \
  -v roon-random-albums-data:/app/data \
  -v /mnt/dietpi_userdata/4tb/Music:/music:ro \
  roon-random-albums:NEW
```

## Migrating from a native install

If you're running an older native (non-Docker) install, the app will show a migration banner automatically with copy-ready commands. Or follow these steps.

```bash
# 1. Stop the native service
sudo systemctl stop roon-random-albums
sudo systemctl disable roon-random-albums

# 2. Create the build directory and download the tarball
sudo mkdir -p /opt/roon-random-albums
cd /opt/roon-random-albums
wget https://github.com/meltface-80/Roon-Random-Albums-Extension/releases/download/v1.5.72/roon-random-albums-v1.5.72-docker.tar.gz
tar -xzf roon-random-albums-v1.5.72-docker.tar.gz

# 3. Build and run
docker build -t roon-random-albums:1.5.72 .
docker run -d \
  --name roon-random-albums \
  --restart unless-stopped \
  --network host \
  -v roon-random-albums-data:/app/data \
  -v /your/path/to/Music:/music:ro \
  roon-random-albums:1.5.72
```

Confirm the extension appears in **Roon → Settings → Extensions** before removing the old install.

### Cleaning up the old install

```bash
# Remove the service file
sudo rm /etc/systemd/system/roon-random-albums.service
sudo systemctl daemon-reload

# Remove the old native install directory (find it first if unsure)
find / -name "roon-random-albums" -type d 2>/dev/null
rm -rf /path/to/old/roon-random-albums
```

Your Roon pairing, listening history, and label cache are all safe — they live in the Docker volume (`roon-random-albums-data`).

## Configuration

| Env var      | Default   | What it does |
|--------------|-----------|--------------|
| `PORT`       | `3399`    | HTTP port the UI listens on |
| `RRA_DEBUG`  | —         | Set to `1` for verbose logging |
| `MUSIC_DIR`  | `/music`  | Path where your music library is mounted inside the container |

Pass extra env vars with `-e` in the `docker run` command:

```bash
docker run -d ... -e RRA_DEBUG=1 roon-random-albums:1.5.72
```

### Album metadata sources

No keys required for basic operation. The extension pulls in external metadata from:

- **Release year** — MusicBrainz (free, public API)
- **Label name** — file tags → iTunes → TheAudioDB → MusicBrainz → Discogs (each free; Discogs needs a personal access token for best results)
- **Label logo** — FanArt.tv (requires free API key) → Discogs (requires personal access token)
- **Editorial review** — Qobuz public album page, falling back to Wikipedia
- **Artist bio** — Wikipedia

## Troubleshooting

- **"Waiting for Roon Core" never goes away**
  → Roon → Settings → Extensions → click **Enable** on *Random Albums*.
- **Extension shows "self" instead of "MusicD"**
  → Update to v1.5.31 or later.
- **Play Now does nothing**
  → Confirm a real zone is selected in the Settings dropdown.
- **"No zones available"**
  → No active outputs visible to Roon yet. Wake a device or pick one in Roon's own remote first.
- **Labels page shows no logos**
  → Add your Discogs token and FanArt.tv key in Settings (gear icon), then tap Force rescan.
- **Discogs token save doesn't stick**
  → Ensure the field shows your token in plain text before tapping Save. If it still fails, check `docker logs roon-random-albums` for a confirmation line.

## File layout

```
/opt/roon-random-albums/
├── Dockerfile
├── .dockerignore
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

Roon Random Albums is released under the **MIT License**. The full text is in the [`LICENSE`](./LICENSE) file. In short: do what you like with it, just keep the copyright and license notice. It comes with no warranty.

Copyright (c) 2026 Lewis Menzies (Music Duck / MusicD).
