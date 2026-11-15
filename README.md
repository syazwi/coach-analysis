# CourtSense — Pickleball Coach & Analytics

Upload a pickleball match video and get motion capture (a pose skeleton on every player), court-position tracking, shot and rally detection, and coaching findings. Each finding is either a **fix for your own game** or an **opportunity to exploit the opponents**, and comes with clips, a counter and a drill.

This is the **browser edition** (the CPU tier from [plan.md](plan.md)). Everything runs locally in your browser and **the video never leaves your computer**. The full Python/GPU pipeline is the next phase.

## Run it

Windows, no installs needed:

```
start.bat
```

This starts a small local server (`serve.ps1`) and opens http://localhost:8080. To use another port: `start.bat -Port 8090`.

Any static server works too, e.g. `python -m http.server 8080 -d app` or `npx serve app`. The page needs to be served over http; opening `index.html` directly from disk won't work because browsers block JavaScript modules on `file://`.

You need an internet connection the first time, because the MediaPipe pose model loads from a CDN.

## How to use

1. **New analysis**: drop a video, **or paste a link** (YouTube, Vimeo or a direct .mp4) and click *Import*. Then set the format (singles/doubles), skill level and which side your team is on. Optionally trim the start and end. Keep teams on the same ends; if they switch sides, analyze each part separately.
2. **Calibrate**: click the 4 outer court corners (far-left, far-right, near-right, near-left), then check that the projected lines sit on the real court lines.
3. **Processing**: pose estimation runs frame by frame, with a live preview. Expect roughly 1–3× the video length at 10 fps on a laptop.
4. **Match analysis**:
   - Video with skeleton, ball, court and label overlays
   - Rally/shot timeline
   - Coach panel with findings and clip playlists
   - Live top-down court view, heatmaps, shot inspector (joint angles at contact) and stats tabs
5. **Label rally outcomes** (in the *Rallies & outcomes* tab). This unlocks error analysis and ranks findings by points lost.
6. **Report** (printable, can be saved as PDF), **Training plan** (7 days, built from your top findings), **Compare** (progress between matches), **Drills** library, a **Highlights** playlist, and **Export reel** (.webm).

Analyses are saved in the browser (IndexedDB). Use *Export data* / *Import analysis* to move them between machines.

### Importing from a link
A browser can't read the pixels of an embedded YouTube player, so the local server downloads the video first using [yt-dlp](https://github.com/yt-dlp/yt-dlp). The browser then analyzes it like a normal file.
- The first import automatically downloads `yt-dlp.exe` into `tools/`. Downloaded videos are kept in `downloads/` (both folders are git-ignored), so re-opening the same link is instant.
- The server picks a browser-playable H.264 MP4 up to 1080p, video only, so ffmpeg is not needed.
- Saved matches remember their source link, so *Match analysis → Re-import from link* can reload the video later.
- Link import needs the bundled server (`start.bat`). With any other static server, only direct video links that allow cross-origin access will work.
- Only import videos you own or have permission to analyze, and respect the platform's terms of service.

### Recording tips
- Camera **behind the baseline, raised 2–3 m**, centered, with the whole court in frame.
- **60 fps, 1080p**, mounted on a tripod or fence.

## What it measures

| Area | Metrics |
|---|---|
| Positioning | Kitchen arrival after the return / 3rd shot, time in the transition zone, distance behind the NVZ line, partner gap, both partners on the same half |
| Technique (pose) | Paddle-hand height in ready position, knee angle / standing tall, stance width, reach at contact, forehand/backhand, detected handedness |
| Footwork | Split-step timing compared with the opponent's contact, first-step reaction, speed, distance covered, slowdown late in the match |
| Shots | Serve, return, 3rd-shot drop/drive, dink, volley/speed-up, reset, drive, overhead (classified from pose, position and rally order) |
| Outcomes (labeled) | Errors (forehand vs backhand), winners, points won when serving vs receiving |

The coaching rules are in [app/js/coach.js](app/js/coach.js). Each rule has a benchmark for every skill level (3.0–4.5), a *fix* text and an *exploit* text, and the drills that address it.

## Accuracy notes

- Single-camera 2D pose: far-side players are small, so their metrics are less certain. Use the two-pass crops setting (on by default).
- Shots are detected from wrist-swing peaks. Soft dinks can be missed, so use *Players & settings → sensitivity* to tune it.
- Ball tracking is experimental (color + motion). It is used only for the overlay.
- Every finding shows its confidence and sample size (n).

## Project layout

```
app/
  index.html, css/styles.css
  js/main.js        UI, views, playback
  js/processor.js   frame loop: pose -> tracking -> ball
  js/pose.js        MediaPipe Pose Landmarker (WASM/WebGL)
  js/court.js       homography, zones, crop regions
  js/tracking.js    player identity tracking
  js/ball.js        experimental ball finder
  js/analysis.js    shots, rallies, metrics
  js/coach.js       rules -> findings, training plan
  js/drills.js      drill library
  js/render.js      overlays, court view, heatmap, timeline, charts
  js/db.js          IndexedDB + JSON import/export
  js/highlights.js  highlight playlist + .webm reel recording
  js/importer.js    import video from a link (via the local server + yt-dlp)
  tests/selftest.html  synthetic-data tests for analysis + coach
serve.ps1, start.bat   zero-install local server (Windows) + link-import API
plan.md                product & technical plan
```

Run the tests by opening http://localhost:8080/tests/selftest.html. Every line should say PASS.
