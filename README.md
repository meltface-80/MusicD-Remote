<div align="center"> 

<img width="1536" height="1024" alt="image" src="https://github.com/user-attachments/assets/fc1dd26e-db7f-4e27-8f66-b0ab74db89e3" />

</div>

# Random Albums + Labels — a Roon extension

> **Note:** If you are running a v1.6.x build, please roll back. A bad release sequence broke several features. Stop and remove your container, then reinstall from the v1.5.40 tarball using the instructions below.

A web UI that shows a screenful of random albums from your Roon library, with instant whole-library search, playback actions targeting any zone, and more.

> The Roon API does not let third-party code navigate the Roon app itself, so the album detail view (art, tracks, action buttons) is rendered inside this UI. Tapping **Play Now** still plays through Roon on the zone you select.


## Updates
**v1.5.40** - With this version I have been working on the labels section of the extension. I've changed the order to match labels and added a few extra tools to help.

I've resolved an issue where label fragmentation was happing. e.g. Universal Music America and Universal Music Europe would show separately. I didn't think this was ideal, because I had 10 Universal Music labels.

The biggest change is the `:ro` (read only) access to your local files. Why? If like me you have metadata including labels, this becomes the fast way to build the labels page. Its easily done if stored on the same server. For network shares, these will work once you `mnt` the share and then add its path to the docker build commands below. The choice is yours to add it or not. It's docker so needs to be added via terminal. I've also set the directory to `/opt/` and the `/app/data` directory remains untouched.

If you only use Qobuz or Tidal you can ignore the below and update within the webUI. 

```
sudo docker stop roon-random-albums
sudo docker rm roon-random-albums

# this can be skipped if you have installed to `/opt/` before
sudo mkdir -p /opt/roon-random-albums

cd /opt/roon-random-albums
wget https://raw.githubusercontent.com/meltface-80/Roon-Random-Albums-Extension/main/roon-random-albums-v1.5.40-docker.tar.gz
tar -xzf roon-random-albums-v1.5.40-docker.tar.gz
docker build -t roon-random-albums:1.5.40 .
docker run -d \
  --name roon-random-albums \
  --restart unless-stopped \
  --network host \
  -v roon-random-albums-data:/app/data \
# set your music path here
  -v /your/path/to/Music:/music:ro \
  roon-random-albums:1.5.40
```

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
sudo mkdir -p /opt/roon-random-albums
cd /opt/roon-random-albums
wget https://raw.githubusercontent.com/meltface-80/Roon-Random-Albums-Extension/main/roon-random-albums-v1.5.40-docker.tar.gz
tar -xzf roon-random-albums-v1.5.40-docker.tar.gz
docker build -t roon-random-albums:1.5.40 .
docker run -d \
  --name roon-random-albums \
  --restart unless-stopped \
  --network host \
  -v roon-random-albums-data:/app/data \
  -v /your/path/to/Music:/music:ro \
  roon-random-albums:1.5.40
```

`--network host` is required so the extension can discover your Roon Core on
the local network. The `-v roon-random-albums-data` flag mounts a named Docker
volume so that your Roon pairing, play history, and label cache survive container
rebuilds. The `-v .../Music:/music:ro` flag mounts your music directory read-only
so the extension can read label tags directly from your files — this is optional
but gives the most accurate label data. Adjust the path to match your music
library location.

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
migration banner automatically with copy-ready commands. Or follow these steps.

The Docker build goes into `/opt/roon-random-albums`, completely separate from
your native install, so there is no risk of old files interfering with the image.

```bash
# 1. Stop the native service
sudo systemctl stop roon-random-albums
sudo systemctl disable roon-random-albums

# 2. Create the build directory and download the tarball
sudo mkdir -p /opt/roon-random-albums
cd /opt/roon-random-albums
wget https://raw.githubusercontent.com/meltface-80/Roon-Random-Albums-Extension/main/roon-random-albums-v1.5.40-docker.tar.gz
tar -xzf roon-random-albums-v1.5.40-docker.tar.gz

# 3. Build the Docker image
docker build -t roon-random-albums:1.5.40 .

# 4. Run the Docker container
docker run -d \
  --name roon-random-albums \
  --restart unless-stopped \
  --network host \
  -v roon-random-albums-data:/app/data \
  -v /your/path/to/Music:/music:ro \
  roon-random-albums:1.5.40
```

Confirm the extension appears in **Roon → Settings → Extensions** and is working
before proceeding.

### Cleaning up the old install

Once Docker is confirmed working, remove the native install. If you're unsure
where it lives:

```bash
find / -name "roon-random-albums" -type d 2>/dev/null
```

Then remove it and the service file:

```bash
# Remove the service file
sudo rm /etc/systemd/system/roon-random-albums.service
sudo systemctl daemon-reload

# Remove the old native install directory
rm -rf /path/to/old/roon-random-albums
```

Your Roon pairing, listening history, and label cache are all safe — they are stored
in the Docker volume (`roon-random-albums-data`) and are completely independent of
the old directory.

## Updating

Updates are detected automatically on startup and every 7 days. Install with
one tap from **Settings → Check for updates** in the web UI, or wait for the
update toast to appear. The container restarts itself to apply the update.

To force an immediate check:

```bash
docker restart roon-random-albums
```

## Configuration

| Env var      | Default   | What it does |
|--------------|-----------|--------------|
| `PORT`       | `3399`    | HTTP port the UI listens on |
| `RRA_DEBUG`  | —         | Set to `1` for verbose logging |
| `MUSIC_DIR`  | `/music`  | Path where your music library is mounted inside the container |

Pass extra env vars with `-e` in the `docker run` command:

```bash
docker run -d ... -e RRA_DEBUG=1 roon-random-albums:1.5.40
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
  → Update to v1.5.40 or later.
- **Play Now does nothing**
  → Confirm a real zone is selected in the Settings dropdown.
- **"No zones available"**
  → No active outputs visible to Roon yet. Wake a device or pick one in
  Roon's own remote first.
- **Update fails with "extraction failed"**
  → The container image may be old; rebuild manually using the steps in the
  Updating section above.

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

Roon Random Albums is released under the **MIT License**. The full text is in
the [`LICENSE`](./LICENSE) file. In short: do what you like with it, just keep
the copyright and license notice. It comes with no warranty.

Copyright (c) 2026 Lewis Menzies (Music Duck / MusicD).
