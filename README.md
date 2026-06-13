<div align="center">

<img width="1536" height="1024" alt="image" src="https://github.com/user-attachments/assets/fc1dd26e-db7f-4e27-8f66-b0ab74db89e3" />

# Random Albums - A Roon extension

Latest version - https://github.com/meltface-80/Roon-Random-Albums-Extension/releases/latest

A web UI that shows a screenful of random albums from your Roon library, with
Play Now, Add to Queue, Play Next, Shuffle, and Start Radio
actions targeting any of your zones. Refresh button reshuffles the wall.
Roon-style dark theme (default) plus a light theme.

The Roon API does not let third-party code navigate the Roon app itself, so the album detail view (art, tracks, action buttons) is rendered inside this UI. Tapping Play Now still plays through Roon on the zone you select.
Also included is a mini transport bar, with a share function (generates a MusicD share card, with album review if available) and volume control if your Roon endpoints have variable control.

Now the why?

I love music and between local albums and Qobuz I have a combined album count of ~12k, so sometimes I just don’t want to choose. This presents 12 options on the screen at a time on a iPhone, more on tablets and desktops. Nothing taking your fancy, refresh the screen. Play now, add to queue etc. it scrapes Qobuz for album info. Roon’s API restrictions unfortunately restricts pulling this metadata.

I have a version for Lyrion Music Server and Volumio as well. LMS is my choice which has manual search function as well. I haven’t put search inside the Roon version, I may if the Roon API allows the way I want it.

It works on Linux, MacOS and Windows (not tested yet on MacOS or Windows, but there’s no reason why it should not). Installation instructions after screenshots.

Once installed it’ll show in Roon Extensions setting page. Just enable it.

To use it via a web browser enter the IP of the machine running the extension http://<IP_ADDRESS>:3399
With iOS you can save it to the Home Screen and it acts like a full screen app.

Linux

# 1. Install Node + git
```
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git curl
node --version        # must be v18+
which node            # NOTE this path for the service file
```

# 2. Download the latest version
Grab the newest release tarball straight from GitHub (no need to look up the
version number — this always fetches the latest):
```
cd ~
curl -s https://api.github.com/repos/meltface-80/Roon-Random-Albums-Extension/releases/latest \
  | grep "browser_download_url.*tar.gz" \
  | cut -d '"' -f 4 \
  | xargs curl -L -O   # → ~/roon-random-albums-vX.Y.Z.tar.gz
```
Or download it manually from
https://github.com/meltface-80/Roon-Random-Albums-Extension/releases/latest
and move it into your home directory.

# 3. Unpack
```
cd /opt && sudo tar -xzf ~/roon-random-albums-v*.tar.gz   # → /opt/roon-random-albums
```

# 4. Dependencies
```
cd /opt/roon-random-albums && npm install
```

# 5. Test by hand FIRST
```
cd /opt/roon-random-albums && node index.js   # should print "listening on http://0.0.0.0:3399", Ctrl-C
```

# Add as a service
```
sudo nano /etc/systemd/system/roon-random-albums.service

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

[Install]
WantedBy=multi-user.target
```
save it, then
```
sudo systemctl daemon-reload
sudo systemctl enable --now roon-random-albums
sudo systemctl status roon-random-albums
journalctl -u roon-random-albums -f     # live logs (Ctrl-C to exit)
```

# MacOS

Install Node (choose one):
- Download the macOS installer from https://nodejs.org  (LTS), OR
- With Homebrew:
`brew install node`
git is usually already present; if not:
`xcode-select --install`    # or: `brew install git`

`node --version`    # verify v18+

Unpack and install
```
cd ~/Applications            # or wherever you want it
tar -xzf ~/Downloads/roon-random-albums.tar.gz
cd roon-random-albums
npm install
node index.js               # test — should print the listening line
```
Open http://localhost:3399 (or http://:3399 from another device)

Auto-start on macOS (launchd, optional)
`Create ~/Library/LaunchAgents/com.local.roon.random-albums.plist`

```
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>            <string>com.local.roon.random-albums</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/YOU/Applications/roon-random-albums/index.js</string>
  </array>
  <key>WorkingDirectory</key> <string>/Users/YOU/Applications/roon-random-albums</string>
  <key>RunAtLoad</key>        <true/>
  <key>KeepAlive</key>        <true/>
</dict>
</plist>
```

Adjust the node path (which node) and the /Users/YOU/… paths, then:

```
launchctl load ~/Library/LaunchAgents/com.local.roon.random-albums.plist
```

# Windows

Install Node.js LTS from https://nodejs.org (the installer adds Node to
your PATH automatically).
Install Git for Windows from Redirecting….
Open PowerShell and verify: `node --version` (should be v18+).
Unpack the tarball (right-click → extract, or use 7-Zip), then in PowerShell:
```
cd C:\Apps\roon-random-albums      # wherever you extracted it
npm install
node index.js                      # test — should print the listening line
```
Open http://localhost:3399 (or http://:3399 from another device)
and enable it in Roon → Settings → Extensions.
Auto-start on Windows (optional)
Easiest is NSSM (the Non-Sucking Service Manager):
```
# After downloading nssm.exe:
nssm install RoonRandomAlbums "C:\Program Files\nodejs\node.exe" "C:\Apps\roon-random-albums\index.js"
nssm set RoonRandomAlbums AppDirectory "C:\Apps\roon-random-albums"
nssm start RoonRandomAlbums
```

Or create a Task Scheduler task: “At startup” → start a program →
node.exe with argument C:\Apps\roon-random-albums\index.js and “Start in”
set to the app folder.

Any errors, just post in this thread and I can assist.
