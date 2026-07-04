<div align="center"> 

<img width="1536" height="1024" alt="image" src="https://github.com/user-attachments/assets/fc1dd26e-db7f-4e27-8f66-b0ab74db89e3" />

</div>

# Random Albums + Labels — a Roon extension v1.6.0

A web UI that shows a screenful of random albums from your Roon library, with instant whole-library search, playback actions targeting any zone, and more.

> The Roon API does not let third-party code navigate the Roon app itself, so the album detail view (art, tracks, action buttons) is rendered inside this UI. Tapping **Play Now** still plays through Roon on the zone you select.

---

## Features

- **Home** — lands on curated rows instead of a single grid: albums you haven't played in 6 months (with a daily Album of the Day pick), a fresh random shuffle, the Label of the Week, and a Browse by Genre grid; tap any row's header to open its full-screen view, or jump to the classic random album wall any time from the menu
- **Instant search** — always available from the Home top bar; whole-library search with results split into Artists, Labels, and Albums sections; tap an artist or label chip to navigate directly
- **Album detail** — full track listing, play/queue actions, release year, label link, editorial review, and artist bio; multiple artists are shown as individual tappable links
- **Now Playing** — live panel showing the current track with album art and transport controls
- **Play unheard** — one tap to find and play an album not in your listening history; falls back to anything not played in the last 30 days once your whole library has been heard
- **Random Album Radio** — automatically queues a new random album when your queue runs dry, preferring albums not recently played
- **Record labels** — browse your library by label, with logos from FanArt.tv and Discogs where available; includes Self-Released and Independent, plus a featured Label of the Week on Home
- **Label merge** — consolidate duplicate or variant label tiles into one; undo individual merges at any time
- **Multi-select** — long-press to select multiple album tiles and play or queue them all at once
- **Filters** — narrow the random pool by genre, decade, tag, or label
- **Artist view** — tap any artist name to see all their albums in your library
- **Share card** — generates a 1200×600 PNG of the current album, ready to share
- **In-app updater** — checks for new releases automatically; install with one tap from Settings

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

1. Register free at [fanart.tv](https://fanart.tv/get-an-api-key/#personal) for a personel API token
2. login or register
3. follow onscreen prompts (or come back here after registering/login and click on above link)
4. Copy the key shown there
5. In the extension, tap the gear icon → paste into **FanArt.tv key** → tap **Save**

---

> **Note on label accuracy** — an album may appear under a label that differs from the one shown in the album view. This could be correct: many albums could be released under multiple labels simultaneously (for example, Daughtry's *Baptized* was released under 19 Recordings, RCA, and Sony Music). The extension shows whichever label your file tags or the scan sources attribute to the album in the case of being a Qobuz or Tidal version.

---

## Install (Docker)

```bash
sudo mkdir -p /opt/roon-random-albums
cd /opt/roon-random-albums
wget https://github.com/meltface-80/Roon-Random-Albums-Extension/releases/download/v1.6.0/roon-random-albums-v1.6.0-docker.tar.gz
tar -xzf roon-random-albums-v1.6.0-docker.tar.gz
docker build -t roon-random-albums:1.6.0 .
docker run -d \
  --name roon-random-albums \
  --restart unless-stopped \
  --network host \
  -v roon-random-albums-data:/app/data \
# remove the below line (and this line) if you only use Qobuz/Tidal
  -v /your/path/to/Music:/music:ro \
  roon-random-albums:1.6.0
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
# remove the below line (and this line) if you only use Qobuz/Tidal
  -v /your/path/to/Music:/music:ro \
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
wget https://github.com/meltface-80/Roon-Random-Albums-Extension/releases/download/v1.6.0/roon-random-albums-v1.6.0-docker.tar.gz
tar -xzf roon-random-albums-v1.6.0-docker.tar.gz

# 3. Build and run
docker build -t roon-random-albums:1.6.0 .
docker run -d \
  --name roon-random-albums \
  --restart unless-stopped \
  --network host \
  -v roon-random-albums-data:/app/data \
# remove the below line (and this line) if you only use Qobuz/Tidal
  -v /your/path/to/Music:/music:ro \
  roon-random-albums:1.6.0
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
docker run -d ... -e RRA_DEBUG=1 roon-random-albums:1.6.0
```

### Album metadata sources

No keys required for basic operation. The extension pulls in external metadata from:

- **Release year** — MusicBrainz (free, public API)
- **Label name** — file tags → Bandcamp (for Bandcamp purchases) → iTunes → TheAudioDB → MusicBrainz → Discogs (each free; Discogs needs a personal access token for best results)
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
