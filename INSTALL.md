# Installing Random Albums from scratch

A short guide for a friend who's never seen this before.

## What you need

- **Roon** running on your network (Roon Server / ROCK / Optimised Core — anything that exposes the Roon Core to the LAN).
- **A computer on the same network** to run the extension on. Doesn't have to be the same box as Roon Server — it can be your existing Linux box, a Raspberry Pi, an always-on Mac, or even just your laptop.
- **Node.js 18 or newer** (`node -v` to check).
- **git** (npm fetches the Roon API libraries from GitHub during install). If you've been given a *bundled* tarball (one that already contains `node_modules/`), you don't need git or internet at install time.

## Linux (the common case — DietPi, Debian, Ubuntu, Pi OS, ROCK)

```bash
# Prereqs
sudo apt-get update
sudo apt-get install -y git
node -v   # if missing/old, install Node 18+ via NodeSource or DietPi's installer

# Put the project somewhere persistent
sudo mkdir -p /opt/roon-random-albums
sudo chown $USER:$USER /opt/roon-random-albums

# Drop the tarball on the box (scp / USB / however), then:
cd /opt
tar -xzf ~/roon-random-albums.tar.gz
cd roon-random-albums

# Install dependencies (skip this if you got a bundled tarball with node_modules)
npm install

# Run it
node index.js
```

You should see:

```
Roon Random Albums UI listening on http://0.0.0.0:3399
Make sure to authorise the extension in Roon → Settings → Extensions.
```

Then:

1. Open any Roon remote (phone, tablet, Mac, whatever).
2. **Settings → Extensions** — you'll see **Random Albums**. Click **Enable**.
3. Browse to `http://<that-box's-ip>:3399`.
4. Pick a zone in the top right, tap an album to play.

You only authorise once; subsequent launches reconnect automatically.

## Autostart on boot (systemd)

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
# Change port if 3399 clashes:
# Environment=PORT=4000

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

## macOS or Windows

Same idea, no systemd:

1. Install Node.js LTS from [nodejs.org](https://nodejs.org/).
2. macOS usually has git; on Windows install [Git for Windows](https://git-scm.com/download/win).
3. Extract the tarball anywhere.
4. Open a terminal in that folder, `npm install`, then `node index.js`.
5. Authorise in Roon → Settings → Extensions, then browse to `http://localhost:3399`.

For autostart use launchd (macOS) or NSSM / Task Scheduler (Windows).

## Configuration

| Env var     | Default | What it does |
|-------------|---------|--------------|
| `PORT`      | `3399`  | HTTP port the UI listens on |
| `RRA_DEBUG` | —       | Set to `1` for verbose logging |

## Troubleshooting

- **`npm install` fails with `git: command not found`**
  → `sudo apt-get install -y git`, then re-run. Or ask whoever sent you this for the *bundled* tarball that includes `node_modules/`.
- **"Waiting for Roon Core" never disappears in the UI**
  → Roon → Settings → Extensions → click **Enable** on *Random Albums*.
- **"No zones available"**
  → No active Roon endpoints visible. Wake a device or pick one in the Roon app first, then refresh.
- **Port 3399 in use**
  → `PORT=4000 node index.js`, or set `Environment=PORT=4000` in the systemd unit.
- **Album view shows but tracks say "no search entry in browse root"**
  → A library/permissions edge case in Roon's browse hierarchy. The modal still shows bio + queue; raise an issue if you see it repeatedly.

## What does it do?

- Shows a screenful of random albums from your Roon library, in 3 columns.
- Tap an album → see tracks, bio (Wikipedia / Qobuz), play / queue / shuffle / start radio.
- Mini transport bar at the bottom for whatever's playing in the selected zone.
- Tap the mini bar to open the now-playing album in detail; tab to see the queue.
- Zone selector at the top transfers playback when you change zones (music follows you).
- Generates a 1200×600 shareable card for any album, with cover, year, and review.
- All external metadata is keyless (MusicBrainz / Qobuz public page / Wikipedia).
