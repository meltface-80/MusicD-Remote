<div align="center"> 

<img width="1536" height="1024" alt="image" src="https://github.com/user-attachments/assets/fc1dd26e-db7f-4e27-8f66-b0ab74db89e3" />

</div>

# Random Albums — a Roon extension

> **Note:** If you are running a v1.6.x build, please roll back. A bad release sequence broke several features. Stop and remove your container, then reinstall from the v1.5.35 tarball using the instructions below.

A web UI that shows a screenful of random albums from your Roon library, with instant whole-library search, playback actions targeting any zone, and more.

> The Roon API does not let third-party code navigate the Roon app itself, so the album detail view (art, tracks, action buttons) is rendered inside this UI. Tapping **Play Now** still plays through Roon on the zone you select.

## Features

- **Random album grid** — fills your screen with random picks from your full library, refreshed on demand
- **Instant search** — whole-library search with results as you type
- **Album detail** — full track listing, play/queue actions, release year, editorial review, and artist bio
- **Now Playing** — live panel showing the current track with album art and transport controls
- **Play unheard** — the compass - one tap to find and play an album not in your listening history. It selects anything you havent yet listened to. If every album has been played it will play anything that hasnt been played within 30 days
- **Random Album Radio** — automatically queues a new random album when your queue runs dry, keeping music going without repeating recent plays
- **Record labels** — browse your library by label, with Fan Art TV logos where available
- **Filters** — narrow the random pool by genre, decade, tag, or label
- **Artist view** — tap any artist name to see all their albums in your library
- **Share card** — generates a 1200×600 PNG of the current album, ready to share
- **In-app updater** — checks for new releases automatically; install with one tap from Settings, and also allows rollback with no terminal needed

---

## Install (Docker)

Each release ships a `*-docker.tar.gz`. Download it, build the image, and run:

```bash
wget https://github.com/meltface-80/Roon-Random-Albums-Extension/raw/main/roon-random-albums-v1.5.35-docker.tar.gz
tar -xzf roon-random-albums-v1.5.35-docker.tar.gz
docker build -t roon-random-albums:1.5.35 .
docker run -d \
  --name roon-random-albums \
  --restart unless-stopped \
  --network host \
  -v roon-random-albums-data:/app/data \
  roon-random-albums:1.5.35
```

`--network host` is required so the extension can discover your Roon Core on
the local network. The `-v` flag mounts a named Docker volume so that your
Roon pairing, play history, and label cache survive container rebuilds.

You should see the extension appear in **Roon → Settings → Extensions** under
**MusicD**. Click **Enable**, then browse to `http://<your-server-ip>:3399`.

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
wget https://github.com/meltface-80/Roon-Random-Albums-Extension/raw/main/roon-random-albums-v1.5.35-docker.tar.gz
tar -xzf roon-random-albums-v1.5.35-docker.tar.gz
docker build -t roon-random-albums:1.5.35 .

# 2. Run the Docker container
docker run -d \
  --name roon-random-albums \
  --restart unless-stopped \
  --network host \
  -v roon-random-albums-data:/app/data \
  roon-random-albums:1.5.35

# 3. Stop and disable the native service
sudo systemctl stop roon-random-albums
sudo systemctl disable roon-random-albums
```

The old installation is not removed automatically. Once you've confirmed the Docker
container is running and visible in Roon, clean up the native install:

```bash
# Remove the service file
sudo rm /etc/systemd/system/roon-random-albums.service
sudo systemctl daemon-reload

# Remove the application directory (adjust path if yours is different)
rm -rf ~/roon-random-albums
```

Your Roon pairing, listening history, and label cache are all safe — they are stored
in the Docker volume (`roon-random-albums-data`) and are completely independent of
the old directory.

If you're not sure where the old install lives:

```bash
find / -name "roon-random-albums" -type d 2>/dev/null
```

## Updating

Updates are detected automatically on startup and every 6 hours. Install with
one tap from **Settings → Check for updates** in the web UI, or wait for the
update toast to appear. The container restarts itself to apply the update.

To force an immediate check:

```bash
docker restart roon-random-albums
```

To upgrade manually:

```bash
docker stop roon-random-albums && docker rm roon-random-albums
wget https://github.com/meltface-80/Roon-Random-Albums-Extension/raw/main/roon-random-albums-v{NEW_VERSION}-docker.tar.gz
tar -xzf roon-random-albums-v{NEW_VERSION}-docker.tar.gz
docker build -t roon-random-albums:{NEW_VERSION} .
docker run -d --name roon-random-albums --restart unless-stopped --network host -v roon-random-albums-data:/app/data roon-random-albums:{NEW_VERSION}
```

## Configuration

| Env var     | Default | What it does |
|-------------|---------|--------------|
| `PORT`      | `3399`  | HTTP port the UI listens on |
| `RRA_DEBUG` | —       | Set to `1` for verbose logging |

Pass extra env vars with `-e` in the `docker run` command:

```bash
docker run -d ... -e RRA_DEBUG=1 roon-random-albums:1.5.35
```

### Album metadata sources

No keys required. The extension pulls in three pieces of external metadata:

- **Release year** — MusicBrainz (free, public API).
- **Album editorial review** — scraped from the public Qobuz album page when
  it exists; falls back to the Wikipedia article's intro paragraph.
- **Artist bio** — Wikipedia article intro.

## Troubleshooting

- **"Waiting for Roon Core" never goes away**
  → Roon → Settings → Extensions → click **Enable** on *Random Albums*.
- **Extension shows "self" instead of "MusicD"**
  → Update to v1.5.35 or later.
- **Play Now does nothing**
  → Confirm a real zone is selected in the Settings dropdown.
- **"No zones available"**
  → No active outputs visible to Roon yet. Wake a device or pick one in
  Roon's own remote first.
- **Stats page is blank**
  → Stats need at least one track to start playing after v1.5.27 is installed.
  The "Recently played" section appears as soon as any track starts.
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
