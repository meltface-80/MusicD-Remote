<div align="center"> 

<img width="1536" height="1024" alt="image" src="https://github.com/user-attachments/assets/fc1dd26e-db7f-4e27-8f66-b0ab74db89e3" />

</div>

# MusicD Remote (for Roon) - v1.6.48

**📖 Install guide & command builder: [meltface-80.github.io/MusicD-Remote](https://meltface-80.github.io/MusicD-Remote/)**

MusicD Remote is for Roon and is a feature-rich music discovery companion for Roon, helping you rediscover your library through album browsing in a random order, with rich metadata, beautiful wall displays and seamless playback with Roon Server at the heart.

---

## Features

🎵 Album Discovery

* Browse your music library in a fresh and engaging way
* Discover forgotten favourites and hidden gems
* Random album selection with configurable filtering
* Album of the day
* Label of the week
* Play Unheard albums
* Recently unplayed album recommendations
* Continue discovering music automatically with Random Album Radio

Over time with prolonged use the database learns when you last listened to an album and will offer up others instead so you rediscover forgotten albums.

⸻

📚 Rich Library Browsing

Browse your library in multiple ways:

* Albums
* Artists
* Genres
* Record Labels
* Decades
* Tags

Quickly jump between related artists, albums and labels from anywhere in the application.

⸻

🔍 Powerful Search

Search your music library instantly by:

* Album
* Artist
* Record Label

Optionally extend searches to supported streaming services including:

* Qobuz
* TIDAL

Also browse Qobuz and Tidal directly and add favourites to your Roon library. 

⸻

💿 Detailed Album Pages

Each album includes rich metadata including:

* High resolution artwork
* Track listing
* Release year
* Record label
* Album duration
* Multiple artist support
* Pitchfork review and rating (where available)

Play, queue or browse directly from the album page.

⸻

▶ Playback Integration

Control playback directly from the extension.

Features include:

* Play album immediately
* Queue album
* Queue individual tracks
* Multi-select albums
* Queue multiple albums
* Continue playback automatically when the queue finishes
* Move queue between zones - zone switcher

⸻

📺 Full Screen Wall Display

Turn a TV or tablet into a beautiful now-playing display.

Features include:

* Large album artwork
* Artist photography
* Album reviews
* Artist biographies
* Related albums
* Related artists
* Record label information
* YouTube music videos
* Playback progress
* Automatic information rotation
* Multiple display modes

Ideal for dedicated listening rooms.
YouTube videos, if suitable and available will play automatically at the start of a track but may not be in sync to the music.

⸻

🏷 Record Label Explorer

Explore your collection by record label.

Features include:

* Label of the week
* Label artwork
* Discogs integration
* FanArt.tv artwork
* Label merging
* Undo merged labels
* Browse every release from a selected label

⸻

📻 Random Album Radio

Automatically keeps the music flowing.

When the current queue finishes the extension can automatically:

* Select another album
* Avoid recently played albums
* Continue playback indefinitely

Perfect for effortless album listening.

⸻

⭐ Artist Discovery

Learn more about the music you’re listening to.

Includes:

* Artist biographies
* Artist images
* Related artists
* Navigation between artists and albums

⸻

🌐 Online Integrations

Supports information and artwork from:

* Roon
* Qobuz
* TIDAL
* Discogs
* FanArt.tv
* Pitchfork
* YouTube

⸻

📤 Sharing

Create attractive share cards for social media featuring:

* Album artwork
* Artist
* Album title
* Clean modern layout

⸻

🔄 Automatic Updates

Stay up to date with the latest features.

* Built-in update checker
* GitHub release integration
* One-click updates

⸻

🐳 Docker Support

Designed for simple deployment.

Includes:

* Docker image
* Docker Compose support
* Persistent configuration
* Automatic migration of pairing information
* Simple upgrades

⸻

⚡ Modern Interface

Designed specifically for large music libraries.

* Responsive interface
* Fast navigation
* Mobile friendly
* Desktop friendly
* TV friendly
* Dark/light themes
* Clean album-first design
  
---

## Setting up Discogs, FanArt.tv and YouTube API keys

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

### YouTube API key

Optional: Getting a YouTube Data API v3 key (free)

1. Go to console.cloud.google.com and sign in with any Google account.
2. Create a project: click the project dropdown (top bar) → New project → name it anything (e.g. “MusicD Display”) → Create, and make sure it’s selected.
3. Enable the API: menu → APIs & Services → Library → search “YouTube Data API v3” → open it → Enable.
4. Create the key: APIs & Services → Credentials → + Create credentials → API key. Copy the key shown.
5. (Recommended) Click Edit API key → under “API restrictions” choose Restrict key → tick only YouTube Data API v3 → Save. This makes the key useless for anything else if it ever leaks.
6. Paste the key into MusicD → Settings → YouTube API key → Save.
   
No billing account is needed — the free quota (10,000 units/day) comfortably covers a home display: each new track costs about 100 units, and results are cached, so that’s roughly 90+ fresh tracks per day before it would ever pause until midnight (Pacific time), when the quota resets.

---

> **Note on label accuracy** — an album may appear under a label that differs from the one shown in the album view. This could be correct: many albums could be released under multiple labels simultaneously (for example, Daughtry's *Baptized* was released under 19 Recordings, RCA, and Sony Music). The extension shows whichever label your file tags or the scan sources attribute to the album in the case of being a Qobuz or Tidal version.

---

## Install (Docker)

```bash
sudo mkdir -p /opt/musicd-remote
cd /opt/musicd-remote
wget https://github.com/meltface-80/MusicD-Remote/releases/download/v1.6.48/MusicD-Remote-v1.6.48.tar.gz
tar -xzf MusicD-Remote-v1.6.48.tar.gz
docker build -t musicd-remote:1.6.48 .
docker run -d \
  --name musicd-remote \
  --restart unless-stopped \
  --network host \
  -v musicd-remote-data:/app/data \
# remove the below line (and this line) if you only use Qobuz/Tidal
  -v /your/path/to/Music:/music:ro \
  musicd-remote:1.6.48
```

> **The `musicd-remote-data` volume holds your Roon pairing, play history, and label cache — never rename it once created.** Point every future `docker run` at the same name and everything carries over; a different name makes Docker silently create a fresh empty volume (new pairing, lost history). **Upgrading from v1.6.31 or earlier?** Your data lives in the old `roon-random-albums-data` volume — move it once with the copy step in [Updating](#updating) below before using this command.

`--network host` is required so the extension can discover your Roon Core on the local network. The `-v musicd-remote-data` flag mounts a named Docker volume so that your Roon pairing, play history, and label cache survive container rebuilds. The `-v .../Music:/music:ro` flag mounts your music directory read-only so the extension can read label tags directly from your files — this is optional but gives the most accurate label data. Adjust the path to match your music library location.

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

> **Coming from v1.6.31 or earlier (the Roon-Random-Albums days)?** Two one-time steps before the update commands below:
>
> 1. **Stop and remove the old container name**: `sudo docker stop roon-random-albums && sudo docker rm roon-random-albums` (and use the new `/opt/musicd-remote` folder below — the old `/opt/roon-random-albums` folder can be deleted afterwards).
> 2. **Move your data to the new volume name** — your Roon pairing, play history, and label cache live in the old `roon-random-albums-data` volume; copy them once into `musicd-remote-data`:
>
> ```bash
> sudo docker run --rm \
>   -v roon-random-albums-data:/from \
>   -v musicd-remote-data:/to \
>   alpine sh -c "cp -a /from/. /to/"
> ```
>
> Skip step 2 and the new container starts with an empty volume: Roon asks you to authorize again and your history is gone. (Once you've confirmed everything carried over, the old volume can be removed with `sudo docker volume rm roon-random-albums-data`.)


```bash
sudo docker stop musicd-remote
sudo docker rm musicd-remote
sudo rm -f /opt/musicd-remote/MusicD-Remote-vPREVIOUS.tar.gz
cd /opt/musicd-remote
wget https://github.com/meltface-80/MusicD-Remote/releases/download/vNEW/MusicD-Remote-vNEW.tar.gz
tar -xzf MusicD-Remote-vNEW.tar.gz
docker build -t musicd-remote:NEW .
docker run -d \
  --name musicd-remote \
  --restart unless-stopped \
  --network host \
  -v musicd-remote-data:/app/data \
# remove the below line (and this line) if you only use Qobuz/Tidal
  -v /your/path/to/Music:/music:ro \
  musicd-remote:NEW
```

## Migrating from a native install

If you're running an older native (non-Docker) install, the app will show a migration banner automatically with copy-ready commands. Or follow these steps.

```bash
# 1. Stop the native service
sudo systemctl stop roon-random-albums
sudo systemctl disable roon-random-albums

# 2. Create the build directory and download the tarball
sudo mkdir -p /opt/musicd-remote
cd /opt/musicd-remote
wget https://github.com/meltface-80/MusicD-Remote/releases/download/v1.6.48/MusicD-Remote-v1.6.48.tar.gz
tar -xzf MusicD-Remote-v1.6.48.tar.gz

# 3. Build and run
docker build -t musicd-remote:1.6.48 .
docker run -d \
  --name musicd-remote \
  --restart unless-stopped \
  --network host \
  -v musicd-remote-data:/app/data \
# remove the below line (and this line) if you only use Qobuz/Tidal
  -v /your/path/to/Music:/music:ro \
  musicd-remote:1.6.48
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

# MacOS installs as follows

For macOS, the main requirement is to install Docker Desktop first, since Docker is not included with the operating system.

## 1. Install Docker Desktop
• Download Docker Desktop for Mac from:
https://www.docker.com/products/docker-desktop/
(Ensure you’re installing the correct version for Mac or Intel chips)
• Open the downloaded .dmg.
• Drag Docker.app into your Applications folder.
• Launch Docker from Applications.
• Grant any permissions macOS requests.
• Wait until Docker Desktop reports Engine running (the whale icon in the menu bar will stop animating).
• Verify Docker is installed:

```
docker --version
docker compose version
```

You should see version information for both commands.

## 2. Download and build the extension
Open Terminal and run:

```
mkdir -p ~/musicd-remote
cd ~/musicd-remote
curl -L -o MusicD-Remote-v1.6.48.tar.gz \
https://github.com/meltface-80/MusicD-Remote/releases/download/v1.6.48/MusicD-Remote-v1.6.48.tar.gz
tar -xzf MusicD-Remote-v1.6.48.tar.gz
docker build -t musicd-remote:1.6.48 .
```

## 3. Run the container
If you use local music replace /Users/yourusername/Music with the folder containing your music library. Note: add your Roon server IP. 

```
docker run -d \
  --name musicd-remote \
  --restart unless-stopped \
  -p 3399:3399 \
  -e ROON_CORE_IP=<IP_OF_YOUR_ROON_CORE> \
  -v musicd-remote-data:/app/data \
  -v /Users/yourusername/Music:/music:ro \
  musicd-remote:1.6.48
```

Or if you only use Qobuz or TIDAL

```
docker run -d \
  --name musicd-remote \
  --restart unless-stopped \
  -p 3399:3399 \
  -e ROON_CORE_IP=<IP_OF_YOUR_ROON_CORE> \
  -v musicd-remote-data:/app/data \
  musicd-remote:1.6.48
```

## 4. Open the extension
In your browser, go to: (don’t forget to use your Roon server IP address)

`http://<your.server.IP>:3399`

Please let me know if you run into any trouble.

## Configuration

| Env var      | Default   | What it does |
|--------------|-----------|--------------|
| `PORT`       | `3399`    | HTTP port the UI listens on |
| `RRA_DEBUG`  | on in Docker | Verbose logging (timestamps, Roon API call traces with durations, API request traces). **On by default inside Docker** — set to `0` for quiet logs, or `1` to force it on outside Docker |
| `MUSIC_DIR`  | `/music`  | Path where your music library is mounted inside the container |
| `ROON_CORE_IP` | *(discover)* | Roon Core address, for setups where multicast discovery can't reach it (macOS / Docker Desktop). When set, the extension connects to the Core directly instead of discovering it |
| `ROON_CORE_PORT` | `9330` | Roon Core API port used with `ROON_CORE_IP` — only change it if your Core runs its API on a non-standard port |

### Logs

Everything the extension prints is also written to the data volume, Roon-style:
`data/logs/MusicD-Remote_log.txt` is the current file; at ~8 MB it rotates to
`MusicD-Remote_log.01.txt` (newest) through `.10.txt` (oldest, then dropped) — about
88 MB worst case, surviving container rebuilds and updates. Grab them for a bug report with:

```bash
docker run --rm -v musicd-remote-data:/data alpine tar -czf - -C /data logs > musicd-logs.tar.gz
```

`docker logs musicd-remote` shows the same lines live.

Pass extra env vars with `-e` in the `docker run` command:

```bash
docker run -d ... -e RRA_DEBUG=1 musicd-remote:1.6.48
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
  → Ensure the field shows your token in plain text before tapping Save. If it still fails, check `docker logs musicd-remote` for a confirmation line.

## File layout

```
/opt/musicd-remote/
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
