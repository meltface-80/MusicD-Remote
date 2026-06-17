# Random Albums - A Roon extension

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
wget https://raw.githubusercontent.com/meltface-80/Roon-Random-Albums-Extension/main/roon-random-albums-v1.5.8-docker.tar.gz
tar -xzf roon-random-albums-v1.5.8-docker.tar.gz
cd roon-random-albums
docker build -t roon-random-albums:1.5.8 .
docker run -d \
  --name roon-random-albums \
  --restart unless-stopped \
  --network host \
  roon-random-albums:1.5.8
```

`--network host` is required so the extension can discover your Roon Core on
the local network.

You should see the extension appear in **Roon → Settings → Extensions**. Click
**Enable**, then browse to `http://<your-server-ip>:3399`.

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

## License

Roon Random Albums is released under the **MIT License**. The full text is in
the [`LICENSE`](./LICENSE) file. In short: do what you like with it, just keep
the copyright and license notice. It comes with no warranty.

Copyright (c) 2026 Lewis Menzies (Music Duck / MusicD).
