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

1. **New analysis**: drop a video, **or paste a link** (YouTube, Vimeo or a direct .mp4) and click *Import*. Then set the format (singles/doubles), skill level and which side your team is on.
   - **Game time**: play the video and press *Set game start* and *Set game end* so only real play is analyzed. Use *Split / add another game* to skip breaks between games. *Suggest from motion* quickly scans the video and proposes play segments for you to check. The panel shows how much time is skipped and estimates the processing time. If teams switch ends, analyze each part separately.
2. **Court calibration**: click the 4 outer court corners (far-left, far-right, near-right, near-left), then check that the projected lines sit on the real court lines.
3. **Player calibration**: on a frame where everyone is visible, the app detects everyone on and around the court (there is **no boundary**: players are followed wherever they move, even far behind the baseline or out wide) and suggests who is who. **Draw the skeleton (✏️, default tool):** select a name and drag a box around that player. Their skeleton is fitted inside the box with a zoomed-in pose pass. If nothing is found, a stick figure is placed in the box. Drag any joint (head, shoulders, elbows, hips, knees, feet) to correct it; the feet set the court position. *Click to pick* still lets you click a detected skeleton. **Following:** players are followed by their **skeleton and movement** (predicted position from their speed and direction, plus overlap with their last skeleton). Tracking starts at the frame you drew on and runs forward and backward from there, and a player missed for a moment gets a zoomed-in look around where they were last seen. Shirt colour only breaks ties, unless you choose *Skeleton + shirt colour* (useful when the teams wear very different colours). Far-away or small players (e.g. a partner deep behind the far baseline) are found with extra zoomed-in passes on that frame; anyone can be assigned wherever they stand (you only get a note if a player is on the other side of the net in that frame), and players placed by clicking their feet get a shirt color sampled from where their body is. **Eraser:** switch to 🧽 *Eraser* and paint over spectators, benches or the next court (*Un-erase* to fix mistakes). People standing there are never picked up as players and the ball finder ignores those pixels; a tracked player who briefly steps into an erased area is still followed. **Play the video** (▶ with ¼×–1× speed) in every calibration step to find a good frame; skeletons are re-detected when you pause. **Hands:** every identified skeleton shows **L**/**R** hand markers; click one (or use the Left/Right buttons) to set that player's **paddle hand**, or leave it on *Auto* to detect it from swings. The paddle hand drives forehand/backhand, ready-position and accuracy metrics, is ringed in the overlay, and can be changed later in *Players & settings*.
4. **Ball calibration**: press ▶ (slow motion helps) and pause when the ball is visible, then click it on 1–3 frames (sun and shade, near and far) and set the ring to the ball's size. The magnifier helps you click precisely. **Test detection** shows what the detector finds on the current frame. Detection then uses your ball's color and size instead of a generic yellow/green guess. You can also skip ball tracking.
5. **Processing**: pose estimation runs frame by frame, with a live preview. Expect roughly 1–3× the video length at 10 fps on a laptop.
6. **Match analysis**:
   - Video with a **square box following each player** (name on top), skeleton, ball, court and label overlays
   - **Video controls:** seek bar, −5s / +5s (J / L), frame step (← / →), play/pause (space or click the video), ¼×–2× speed
   - Rally/shot timeline
   - Coach panel with findings and clip playlists. **Click a finding to jump the video to when it happened**, or click one of its time chips (▶ 1:42) to jump to that moment. The **📣 Comments** tab lists every coach callout in time order; click one to jump there. The comment on screen is highlighted while the video plays.
   - Live top-down court view, heatmaps, shot inspector (joint angles at contact) and stats tabs
   - **📣 Coach callouts**: short lines a coach would shout appear in a speech bubble above the player at the moment they apply. Examples: *Follow your return — get to the kitchen!*, *They’re at the line — drop it soft!*, *Paddle up!*, *Split step — get set!*, *Close the middle!*, *Hit at Opp 2’s feet!*, *Great point!*. The rim colour shows the type: amber = fix, green = opening to attack, blue = well done. Show them for everyone, your team or the opponents (toggle next to the overlay switches). They can also be burned into a saved video.
   **Erase spectators** (Match analysis): paint over spectators on the video, then *Remove detections in erased areas* (whole match, with *Undo*), or *Re-analyze with erased areas* to rerun with them ignored from the start.
   If the labels ever jump to the wrong person, pause at that moment and use *Players & settings → Fix an identity switch*.
7. **Label rally outcomes** (in the *Rallies & outcomes* tab). This unlocks error analysis and ranks findings by points lost.
8. **Game review (accuracy)**: like a chess engine's game review. Every shot is rated **Brilliant !! / Great ! / Good ✓ / Inaccuracy ?! / Mistake ? / Blunder ??** and each player gets an **accuracy %**, also broken down by phase (serve & return, 3rd shot, transition, kitchen) and shown as a graph across the match. Click a count to replay those shots. The shot inspector explains each rating (e.g. "+12 attacked a low paddle", "−18 attackable ball").
9. **Save analyzed video**: saves an MP4 with skeletons, court, ball trail, labels, a mini court map, rally/shot info and coach notes drawn onto the video. You can export the whole match, rallies only (no dead time), highlights, or one finding's clips, at 720p, 1080p or source resolution. In Chrome and Edge it's encoded frame by frame with WebCodecs and saved where you choose. If the encoder isn't available, it falls back to WebM recorded in real time.
10. **Keep video in app**: stores the original video with the analysis (IndexedDB), so a saved match reopens without re-attaching. This is on by default for new analyses.
11. **Report** (printable, can be saved as PDF), **Training plan** (7 days, built from your top findings), **Compare** (progress between matches), **Drills** library, a **Highlights** playlist, and **Export reel** (.webm).

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
- Ball tracking uses your calibrated ball color and size plus motion. It is still used only for the overlay, and it needs the ball to move between analyzed frames.
- Identity tracking follows skeletons and movement, so same-colour shirts are fine. Two players standing exactly on top of each other (one hidden behind the other) can still swap labels; use *Fix an identity switch* if that happens.
- Every finding shows its confidence and sample size (n).

## Project layout

```
app/
  index.html, css/styles.css
  js/main.js        UI, views, playback
  js/processor.js   frame loop: pose -> tracking -> ball
  js/pose.js        MediaPipe Pose Landmarker (WASM/WebGL)
  js/court.js       homography, zones, crop regions
  js/calibration.js player & ball calibration steps
  js/detector.js    per-frame pose detection (crops) + shirt colour sampling
  js/tracking.js    skeleton-following identity tracker (motion prediction, box overlap, optional colour)
  js/callouts.js    coach callouts (what to do, as it happens) + speech-bubble drawing
  js/ball.js        ball finder (calibrated colour/size) + calibration helpers
  js/analysis.js    shots, rallies, metrics
  js/coach.js       rules -> findings, training plan
  js/drills.js      drill library
  js/render.js      overlays, court view, heatmap, timeline, charts
  js/db.js          IndexedDB + JSON import/export
  js/accuracy.js    shot ratings + accuracy % (game review)
  js/trim.js        game time: start/end, multiple games, motion scan
  js/exporter.js    save analyzed video (WebCodecs H.264 -> MP4, WebM fallback)
  vendor/mp4-muxer.mjs  MP4 muxer (MIT, bundled for offline use)
  js/highlights.js  highlight playlist + real-time recording fallback
  js/importer.js    import video from a link (via the local server + yt-dlp)
  tests/selftest.html  synthetic-data tests for analysis + coach
serve.ps1, start.bat   zero-install local server (Windows) + link-import API
plan.md                product & technical plan
```

Run the tests by opening http://localhost:8080/tests/selftest.html. Every line should say PASS.
