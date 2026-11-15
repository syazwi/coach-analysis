# Pickleball Coach & Analytics Web App — Plan

## 1. Goal

A web app where a player or coach uploads a pickleball match video and gets back:

1. **Motion capture** for every player: a 2D skeleton on every frame, and estimated 3D poses where possible.
2. **Match data**: rallies, shots, ball paths, court positions, heatmaps and movement metrics.
3. **Coaching analysis**: weaknesses, the **opportunities** each one opens for the opponent (or for us), and **how to counter** them, each linked to a timestamped clip as evidence.

The app works in two roles at once:
- **Data analyst**: objective metrics, with charts and filters.
- **Coach**: findings that rank what matters most and give concrete drills or tactics.

---

## 2. Users & Core Use Cases

| User | Wants |
|---|---|
| Recreational player | "What am I doing wrong? What should I practice?" |
| Coach | Review students' footage quickly and share annotated clips |
| Competitive player / team | Scout opponents: their tendencies, weak side, patterns to exploit |

Use cases:
- Upload a match, then get an automatic report (target: under 2× the video length for processing).
- Scrub the video with the skeleton, ball trail and court overlay on top.
- Click any finding to jump to the clips that prove it.
- Compare two matches (progress tracking) or two players (scouting).
- Export a PDF or shareable link of the report.

---

## 3. System Architecture

```
┌──────────────┐   upload (resumable)   ┌───────────────┐
│  Web Client  │ ─────────────────────▶ │  API (FastAPI)│
│  Next.js     │ ◀── status / results ─ │               │
└──────┬───────┘      (WebSocket/SSE)   └──────┬────────┘
       │ video + overlay JSON (CDN)            │ enqueue job
       ▼                                       ▼
┌──────────────┐                       ┌───────────────┐
│ Object Store │ ◀──── artifacts ───── │  GPU Workers  │
│ (S3 / MinIO) │                       │  (Celery/RQ)  │
└──────────────┘                       └──────┬────────┘
                                              │ metrics, events
                                              ▼
                                       ┌───────────────┐
                                       │ PostgreSQL    │
                                       │ + Redis queue │
                                       └──────┬────────┘
                                              │ structured stats
                                              ▼
                                       ┌───────────────┐
                                       │ Coach Engine  │
                                       │ rules + LLM   │
                                       └───────────────┘
```

### Tech stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Next.js (React, TypeScript), Tailwind, Canvas/WebGL overlay, Recharts/D3 | Fast UI; drawing skeletons on canvas stays smooth at 60 fps |
| 3D viewer | Three.js | Rotate the 3D pose of a stroke |
| API | Python FastAPI | Same language as the ML pipeline |
| Jobs | Celery + Redis (or RQ) | Long GPU jobs with progress reporting |
| ML | PyTorch, Ultralytics YOLO, RTMPose/MMPose (or MediaPipe for the CPU tier), OpenCV | Proven pose and detection models |
| Storage | S3-compatible (MinIO locally) | Videos, clips, overlay JSON |
| DB | PostgreSQL (+ TimescaleDB optional for per-frame series) | Relational data plus time series |
| Coaching text | LLM (Claude, e.g. `claude-sonnet-5-5`) fed **structured stats only** | Turns numbers into a natural coaching voice; it never invents data |

---

## 4. Video Analysis Pipeline (the core)

Each stage writes a versioned artifact, so any stage can be re-run on its own.

### Stage 0 — Ingest & normalize
- Transcode with FFmpeg to H.264, constant frame rate, and keep the original fps (recommend **60 fps** for ball tracking).
- Extract metadata. Create a low-res proxy for the scrubbing UI.
- Quality check: resolution, fps, blur and camera shake, then warn the user if the footage is poor.

### Stage 1 — Court detection & calibration
- Detect court lines (segmentation model or Hough lines plus a keypoint model for the 12+ court line intersections).
- Compute a **homography** from image pixels to court coordinates in feet (court is 20 × 44 ft, with the kitchen/NVZ 7 ft from the net).
- Fallback: the user clicks 4 court corners in the UI.
- Output: `court.json` (homography, zones: baseline, transition zone, kitchen, left/right side).

### Stage 2 — Player detection, tracking & identity
- Person detection with YOLO, then **ByteTrack/BoT-SORT** for tracking.
- Keep only people inside the court polygon, which filters out spectators and players on other courts.
- Give each of the 4 (doubles) or 2 (singles) players a stable ID, using appearance re-ID plus a team-side constraint.
- The user labels players once ("Me", "Partner", "Opp A", "Opp B") and the labels carry across the match.

### Stage 3 — Motion capture (pose estimation)
- **2D pose** per player per frame: RTMPose / ViTPose (17 COCO keypoints, or 133 whole-body for hands).
- **Temporal smoothing**: One-Euro filter or Kalman filter, plus filling gaps where a limb is hidden.
- **3D lifting** (optional, phase 2): MotionBERT / VideoPose3D, which turns 2D sequences into 3D joints for stroke mechanics.
- **Paddle estimation**: a small detector for paddle position and face angle, trained on custom labels (phase 2).
- Output: `pose_{player}.parquet` (frame, joint, x, y, z?, confidence).

### Stage 4 — Ball tracking
- **TrackNet-style** heatmap model (takes 3 consecutive frames) for the small, blurry ball.
- Trajectory fitting: physics-aware smoothing. Bounces show up as sharp changes in the vertical image direction combined with the homography ground point.
- Detect events: **contact** (ball near a wrist/paddle plus a change in direction), **bounce**, **net**, **out**.

### Stage 5 — Event segmentation
- **Rallies**: from serve to dead ball (ball lost, or the players' motion pattern resets).
- **Shots**: each contact becomes a shot with hitter, time, court position and ball speed estimate.
- **Shot classification** (sequence model over pose plus ball features): serve, return, third-shot drop, third-shot drive, dink, volley, speed-up, counter, reset, lob, overhead, erne, ATP, forehand/backhand.
- **Rally outcome**: winner, unforced error, forced error, and who won the point (score tracking with a manual override in the UI).

### Stage 6 — Metrics (data analyst layer)
See §5. Computed per frame, per shot, per rally and per match.

### Stage 7 — Coach engine (opportunities & counters)
See §6.

### Processing tiers
- **Fast (CPU / browser)**: MediaPipe pose plus a simple ball tracker, for a quick preview.
- **Full (GPU)**: all stages, for accurate analysis.

---

## 5. Metrics Catalogue

### 5.1 Movement / motion-capture metrics (per player)
| Metric | How it's computed | Why a coach cares |
|---|---|---|
| Ready position | Paddle-hand height relative to chest, knee flexion angle, stance width / shoulder width between shots | A low paddle or straight legs means slow hands at the kitchen |
| Split-step timing | Hip vertical dip relative to the opponent's contact time (ms) | Late split step means getting beaten by speed-ups and passes |
| Reaction time | Opponent contact to first movement of the center of mass | Anticipation |
| Center-of-mass height | Hip midpoint height, normalized by leg length | Players who stand tall pop the ball up |
| Contact point | Wrist/paddle position relative to the front foot and torso at contact | Contact late or behind the body means weak, high shots |
| Footwork at contact | Feet set or still moving at contact, and the lunge distance | Off-balance shots lead to errors |
| Torso rotation | Shoulder-line versus hip-line angle through the stroke | Power source on drives and serves |
| Wrist vs. arm use | Wrist angular velocity versus shoulder/elbow velocity on dinks | Wristy dinks are inconsistent |
| Recovery | Time and path back to position after a shot | Leaves gaps |
| Distance & speed | Court-space track from the homography | Fitness and efficiency |
| Kitchen arrival | Time from return/3rd shot to reaching the NVZ line | The core strategic metric in pickleball |
| Transition-zone dwell | Time spent between the baseline and the kitchen | Getting caught in "no-man's land" |

### 5.2 Shot & tactical metrics
- Serve/return **depth** (bounce position), serve fault rate.
- Third-shot drop success: does the ball land in the kitchen and stay unattackable (contact height below net height)?
- Dink: average **height over the net**, cross-court vs. straight percentage, error rate.
- Attackable-ball rate: share of a player's shots the opponent contacts **above net height**.
- Speed-up: who initiates, success rate, and the target (body, shoulder, hip, feet).
- Forehand/backhand split, error rate per side.
- **Partner spacing**: distance between partners, and gaps down the middle or the lines.
- Heatmaps: player positions, bounce points, and contact points by shot type.
- Point win rate when serving vs. receiving, and by rally length bucket (1–4, 5–8, 9+).

---

## 6. Coach Engine — Opportunities & Counters

### 6.1 Approach
1. **Rule-based detectors** run over the metrics and produce *findings*, each with severity, confidence and supporting clips.
2. **Ranking**: impact = how often it happens × points lost when it happens.
3. **LLM narrative**: the top findings plus their numbers go to the LLM, which writes the coaching text in a clear voice. The prompt forbids stating any number that isn't in the input.
4. **Two lenses** on every finding:
   - **Fix (self-coaching)**: a weakness in *my* game, with a correction and a drill.
   - **Exploit (scouting)**: a weakness in the *opponent's* game, with the tactic to attack it and how they might adjust.

### 6.2 Opportunity → counter library (starting set)

| Detected pattern (from data) | Opportunity it creates | Counter / fix | Drill |
|---|---|---|---|
| Returner stays behind the baseline / slow kitchen arrival (> X s) | Opponent drives the 3rd shot at their feet | Hit a deep return with height to buy time, then move up immediately after contact | Return-and-rush ladder |
| Player is often contacted in the transition zone | Opponent aims at feet; low balls are hard to attack | Split step, then hit a soft reset into the kitchen and move up in stages | Transition reset drill (feeder at the kitchen) |
| Dinks average high over the net / high attackable-ball rate | Opponent speeds up off high dinks | Bend knees more (knee angle target shown), open the paddle face, lift with the shoulder rather than the wrist | Target dinks under a rope placed over the net |
| Paddle drops below waist in ready position | Speed-ups to the shoulder or chest win | Keep the paddle up in front of the chest, backhand-ready | Rapid-fire hands battle |
| Late split step (after opponent contact) | Passing shots and body shots | Time the split step to the opponent's backswing | Partner-call split-step drill |
| Backhand error rate ≫ forehand | Target the backhand, especially cross-court | Strengthen the backhand dink and drop; when stacking, protect the weak side | Backhand-only dink games |
| Large gap between partners / no lateral shift | Hit down the middle, or the lines when partners split | Move with the ball as if tied together by a rope, and decide who takes middle balls | Shadow-shift drill |
| Partners both move to wide balls, middle open | Middle drive or dink | Agree who covers the middle (forehand-in-middle rule) | Middle-ball call drill |
| Poor 3rd-shot drop success (lands deep / high) | Opponent attacks the 4th shot | Drop with lift from the legs, aim for an arc peaking on your own side; drive-then-drop as an alternative | 3rd-shot drop + 5th-shot sequence |
| Player overreaches laterally on wide dinks (feet not moving) | Opponent sets up the erne or ATP, and errors follow | Shuffle the feet, don't reach; return wide balls cross-court | Lateral dink footwork |
| Opponent stays off the kitchen line by a step | Their dinks rise, and drop-volleys / angled dinks reach them | Dink to their feet, short angles | — (scouting) |
| Opponent always dinks cross-court | Predictable pattern | Poach or set up an erne | — (scouting) |
| Opponent's serve is short or shallow | Attackable return | Return deep to the backhand and rush the net | — (scouting) |
| Fatigue: reaction time and kitchen-arrival time drop late in the match | Longer rallies favour the opponent | Conditioning work; keep points short when tired | Interval footwork |

The library is data-driven (YAML), so coaches can add their own rules without changing code.

### 6.3 Finding format
```json
{
  "id": "late_kitchen_arrival",
  "player": "Me",
  "lens": "fix",
  "severity": "high",
  "confidence": 0.82,
  "evidence": {"metric": "kitchen_arrival_s", "value": 3.4, "benchmark": 2.0, "n": 27},
  "impact": {"points_lost": 9, "share_of_losses": 0.31},
  "opportunity": "Opponents drove 3rd shots at your feet in 14 of 27 return games.",
  "counter": "Return deep with height and move forward on contact; split step at the transition line.",
  "drill": "return_and_rush",
  "clips": [{"start": 132.4, "end": 139.0}, {"start": 410.2, "end": 417.5}]
}
```

### 6.4 Benchmarks
- Start with expert-set targets by skill level (3.0 / 3.5 / 4.0 / 4.5+).
- Later: build percentile benchmarks from anonymized analyzed matches (opt-in only).

---

## 7. Web App Design

### 7.1 Pages
1. **Dashboard**: list of matches, progress charts, top 3 focus areas.
2. **Upload**: drag-and-drop, resumable upload (tus / S3 multipart), match details (singles/doubles, skill level, date), camera-setup tips.
3. **Setup / calibration**: confirm court corners, name the players (click each player on a frame).
4. **Processing**: progress per pipeline stage, plus a preview as soon as pose results are ready.
5. **Match Analysis** (main screen, see below).
6. **Player Profile**: trends across matches, strengths and weaknesses radar.
7. **Scouting Report**: opponent-focused, "how to beat them".
8. **Compare**: two players or two matches side by side, with synced video.
9. **Share / Export**: PDF report, public link, clip downloads.

### 7.2 Match Analysis layout
```
┌───────────────────────────────────────────────┬──────────────────────────┐
│  VIDEO PLAYER                                 │  COACH PANEL             │
│  [overlay toggles: Skeleton | Ball trail |    │  ▸ Top Findings          │
│   Court zones | Player labels | Speed]        │   ● Late to kitchen  HIGH│
│                                               │     "31% of points lost" │
│        (skeletons + ball + court drawn        │     [▶ 9 clips] [Drill]  │
│         on canvas over video)                 │   ● High dinks       MED │
│                                               │   ● Backhand errors  MED │
│  ◀◀  ▶  ▶▶   0.25x 0.5x 1x   frame-step       │  ▸ Opportunities (opp.)  │
├───────────────────────────────────────────────┤   ● Opp B weak backhand  │
│ TIMELINE: rallies ▮▮▮ ▮▮ ▮▮▮▮ (colored by     │   ● Middle gap           │
│ outcome) + shot markers + finding markers     │                          │
├────────────────┬──────────────┬───────────────┴──────────────────────────┤
│ 2D COURT VIEW  │ HEATMAP      │ STATS TABS: Overview | Shots | Movement  │
│ (top-down live │ (positions / │ | Serve/Return | Kitchen | Rallies       │
│ player dots +  │  bounces)    │ charts + filters (player, shot, rally #) │
│ ball)          │              │                                          │
└────────────────┴──────────────┴──────────────────────────────────────────┘
```

Key interactions:
- **Click a finding**: the timeline filters to its clips, and the player plays them back to back (a playlist).
- **Click a shot marker**: the stroke panel opens with a slow-motion skeleton, joint-angle graphs (knee, elbow, torso), and contact-point position compared with an ideal-form ghost overlay.
- **Pause on any frame**: shows each player's live metrics (knee angle, paddle height, distance to kitchen).
- **Sync**: video, the top-down court view and the charts all follow one shared timeline.
- **Coach annotations**: draw on a frame, add voice or text notes, pin them to a timestamp.

### 7.3 Visual style
- Dark UI for video review, with team colors (blue/orange) used consistently on skeletons, court dots and charts.
- Severity colors: red (high), amber (medium), gray (low).
- Mobile: report and clips are usable on a phone. Deep analysis views target tablet and desktop.

---

## 8. Data Model (PostgreSQL)

```
users(id, name, email, role[player|coach], skill_level)
matches(id, owner_id, title, date, format[singles|doubles], status, video_url, fps, duration)
players(id, match_id, label, user_id?, team[A|B], track_ids[])
court_calibration(match_id, homography, zones_json)
rallies(id, match_id, start_t, end_t, server_id, winner_team, outcome_type)
shots(id, rally_id, hitter_id, t, type, hand[fh|bh], contact_xy, contact_height,
      bounce_xy, speed_est, result[in|out|net|winner|error])
player_frames(match_id, player_id, frame, court_x, court_y, pose_ref)   -- or parquet in S3
metrics(match_id, player_id, key, value, scope[match|rally|shot], scope_id)
findings(id, match_id, player_id, rule_id, lens, severity, confidence, evidence_json, text)
clips(id, finding_id?, match_id, start_t, end_t, url?)
annotations(id, match_id, author_id, t, drawing_json, note)
```
Large per-frame data (pose, ball) is stored as Parquet/JSON in object storage. The DB holds only summaries and indexes.

## 9. API (REST + WebSocket)

```
POST   /matches                    create match + get upload URL
POST   /matches/{id}/calibration   court corners / player labels
POST   /matches/{id}/process       start pipeline
WS     /matches/{id}/progress      stage progress
GET    /matches/{id}               summary
GET    /matches/{id}/overlay?from&to  pose + ball + court for a time window (chunked)
GET    /matches/{id}/rallies | /shots | /metrics | /findings
GET    /players/{id}/trends
GET    /players/{id}/scouting
POST   /matches/{id}/annotations
GET    /matches/{id}/report.pdf
```

---

## 10. Recording Guidelines (shown in the upload flow)
- Camera **behind the baseline, raised (2–3 m)**, centered, with the whole court and all players in frame.
- **60 fps** or more, 1080p, phone on a tripod or fence mount (no hand-held).
- Good lighting, and avoid shooting into the sun.
- A side-view second camera (phase 3) enables better 3D pose and ball height.

---

## 11. Accuracy & Validation
- Build a **labeled validation set** (~20 matches): court corners, player boxes, keypoints (sampled), ball positions, shot types, rally outcomes.
- Targets (MVP): court calibration error < 0.5 ft; player ID switches < 1 per 10 min; ball detection recall > 85% at 60 fps; shot-type accuracy > 80%; rally segmentation F1 > 0.9.
- Every finding shows its **confidence** and sample size **n**. Findings with n < 5 are hidden or marked "early signal".
- Human-in-the-loop: users can correct a shot label or rally outcome, which updates stats and feeds future training data.

## 12. Risks & Mitigations
| Risk | Mitigation |
|---|---|
| Single camera means the far players are small and their pose is noisy | Recommend camera height; use higher-res crops for far players; mark confidence lower |
| Ball blur and occlusion | Use 60 fps; TrackNet uses multiple frames; interpolate along physics-based paths |
| Occlusion between partners | Re-ID with appearance features plus side-of-court constraints; manual fix in the UI |
| Paddle not visible or hard to detect | Use the wrist/hand as a proxy in the MVP; add a paddle model later |
| LLM hallucinating stats | LLM gets only structured findings; numbers are rendered from data, not from generated text |
| GPU cost | Fast tier on CPU; batch frames; process only in-play segments at full resolution |
| Privacy (video of people) | Private by default, owner-controlled sharing, deletion on request, opt-in only for benchmark data |

---

## 13. Roadmap

### Phase 0 — Prototype (2–3 weeks)
- [ ] Python notebook/CLI: video → court homography (manual corners) → YOLO + ByteTrack → RTMPose skeletons → overlay MP4 output.
- [ ] Top-down court position plot and heatmap.
- [ ] 3 movement metrics: kitchen arrival, ready-position paddle height, knee flexion.

### Phase 1 — MVP web app (6–8 weeks)
- [ ] Upload, calibration and player labeling UI.
- [ ] Job queue + GPU worker + progress.
- [ ] Ball tracking (TrackNet) + bounce/contact detection.
- [ ] Rally segmentation + basic shot types (serve, return, dink, drive, drop, volley).
- [ ] Match Analysis screen: video + skeleton overlay + timeline + court view + stats tabs.
- [ ] Rule engine with ~10 findings from the §6.2 library, each with clips.
- [ ] LLM coaching summary.

### Phase 2 — Coach-grade (6–8 weeks)
- [ ] 3D pose lifting + stroke-mechanics view (joint-angle curves, ideal-form ghost).
- [ ] Full shot taxonomy (speed-up, reset, erne, ATP, lob, overhead) + FH/BH.
- [ ] Scouting report + opponent "how to beat them" page.
- [ ] Player profile trends across matches; compare view.
- [ ] Coach annotations, sharing, PDF export.
- [ ] User corrections feed back into training data.

### Phase 3 — Advanced
- [ ] Multi-camera sync for real 3D ball and player positions.
- [ ] Paddle detection + face-angle estimation.
- [ ] Pattern mining (sequence models: "after a cross-court dink, Opp A speeds up 40% of the time").
- [ ] Win-probability model per rally state, and "what if" shot recommendations.
- [ ] Real-time / near-real-time mode for live coaching.
- [ ] Skill-level benchmarks from the community dataset.

---

## 14. Repository Structure (proposed)
```
pickleball/
├─ plan.md
├─ apps/
│  └─ web/                 # Next.js frontend
├─ services/
│  ├─ api/                 # FastAPI
│  └─ worker/              # Celery GPU worker
├─ pipeline/
│  ├─ ingest/  court/  tracking/  pose/  ball/  events/  metrics/
│  └─ coach/               # rules (YAML), ranking, LLM prompts
├─ models/                 # weights (git-ignored), training scripts
├─ data/
│  └─ validation/          # labeled ground truth
├─ infra/                  # docker-compose (postgres, redis, minio), GPU deploy
└─ docs/
```

## 15. Build Status (2026-11-15)

**Browser edition built** in `app/`. This is the CPU/browser tier from §4, and it runs with no installs (see README).
The development machine has no NVIDIA GPU, Python or Node, so the GPU pipeline (§3, §4 full tier) has not been built yet.

| Area | Status |
|---|---|
| Upload, court calibration (4 corners + homography), trim range | ✅ |
| Import from link (YouTube/Vimeo/direct URL) via local server + yt-dlp, re-import for saved matches | ✅ (live YouTube download not yet tested) |
| Pose estimation (MediaPipe, two-pass crops for far players), player identity tracking | ✅ |
| Ball tracking | ⚠️ experimental (color + motion), used for the overlay only |
| Shot detection (wrist-swing peaks + team alternation), rallies, shot types, FH/BH, handedness | ✅ approximate |
| Movement metrics (§5.1): kitchen arrival, transition dwell, paddle height, knee angle, stance, split step, reaction, reach, fatigue, partner spacing | ✅ |
| Coach engine (§6): 15 player rules + 2 team rules, fix/exploit lenses, skill benchmarks, impact ranking from labeled outcomes | ✅ |
| Match Analysis screen (§7.2): overlays, timeline, coach panel, clip playlists, live court view, heatmaps, shot inspector, stats tabs | ✅ |
| Rally outcome labeling | ✅ manual |
| Report + PDF (print), dashboard trends, compare matches | ✅ |
| Drill library, weekly training plan, highlights playlist, .webm reel export | ✅ (extra features) |
| Persistence (IndexedDB) + JSON export/import | ✅ |
| LLM coaching narrative | ⏳ template-based for now; Claude API needs a backend for the key |
| Python FastAPI + GPU workers, 3D pose, TrackNet ball, paddle model | ⏳ Phase 1–3 |
| Coach marketplace, audio score tracking | ⏳ backlog |

## 16. Immediate Next Steps
1. Run the browser edition on real match videos, then tune the shot-detection sensitivity and rule benchmarks against what a coach sees.
2. Build a labeled validation set (§11) from those videos.
3. Stand up the Python GPU pipeline (FastAPI + worker) on a machine or cloud GPU with an NVIDIA card, reusing the same metrics and rules.
4. Add the Claude-written coaching narrative on the backend.
