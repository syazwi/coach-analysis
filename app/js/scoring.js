// Scoring: classic side-out scoring to 11, or rally scoring to 15 (both win by 2).
// Builds the running score from rally winners (labeled, or worked out automatically)
// and draws a scoreboard on the video.

export const SCORING = {
  classic: { id: 'classic', name: 'Classic (side-out) to 11', short: 'to 11', to: 11, winBy: 2, rally: false },
  rally: { id: 'rally', name: 'Rally scoring to 15', short: 'rally to 15', to: 15, winBy: 2, rally: true },
};
export const scoringOf = cfg => SCORING[cfg?.scoring] || SCORING.classic;
export const otherTeam = tm => (tm === 'A' ? 'B' : tm === 'B' ? 'A' : null);

/**
 * Who won a rally, from who serves the next one (null if it can't be told).
 *  classic: the same player serving again = serving team won; anyone else = serving team lost
 *           (second server or side out)
 *  rally:   the team that wins a rally always serves the next one
 */
export function winnerFromServe(r, nx, mode = SCORING.classic) {
  if (!r || !nx || !r.serverTeam || !nx.serverTeam || nx.start - r.end >= 45) return null;
  if (mode.rally) return nx.serverTeam;
  return nx.serverSlot === r.serverSlot ? r.serverTeam : otherTeam(r.serverTeam);
}

/** Score call as the server says it: "server-receiver-server#" (classic doubles) or "server-receiver". */
export function scoreCall(s, mode, doubles) {
  const srv = s[s.serving], rcv = s[otherTeam(s.serving)];
  return !mode.rally && doubles ? `${srv}-${rcv}-${s.serverNum}` : `${srv}-${rcv}`;
}

/**
 * Running score. winners[i] = 'A' | 'B' | null (unknown) for rallies[i].
 * Returns { rallies: [{ rally, winner, before, after, call, gameOver }], unknown, games, mode }.
 * before/after = { A, B, serving, serverNum, game, games: {A, B} }.
 */
export function computeScore(rallies, winners, mode = SCORING.classic, doubles = true) {
  const startNum = doubles && !mode.rally ? 2 : 1; // classic doubles: first serving team has one server
  let score = { A: 0, B: 0 }, games = { A: 0, B: 0 }, game = 1;
  let serving = rallies[0]?.serverTeam || 'A', serverNum = startNum, resync = true, unknown = 0;
  const out = [];
  rallies.forEach((r, i) => {
    // start of a game, or after a rally we couldn't score: trust who was seen serving
    if (resync && r.serverTeam) serving = r.serverTeam;
    resync = false;
    const before = { ...score, serving, serverNum, game, games: { ...games } };
    const w = winners[i] || null;
    if (!w) { unknown++; resync = true; }
    else if (mode.rally) { score[w]++; serving = w; }
    else if (w === serving) score[w]++;
    else if (doubles && serverNum === 1) serverNum = 2;
    else { serving = otherTeam(serving); serverNum = 1; }
    let gameOver = null;
    if (Math.max(score.A, score.B) >= mode.to && Math.abs(score.A - score.B) >= mode.winBy) {
      gameOver = score.A > score.B ? 'A' : 'B';
      games[gameOver]++;
    }
    const after = { ...score, serving, serverNum, game, games: { ...games } };
    out.push({ rally: r.index, winner: w, before, after, gameOver, call: scoreCall(before, mode, doubles) });
    if (gameOver) { game++; score = { A: 0, B: 0 }; serverNum = startNum; resync = true; }
  });
  return { rallies: out, unknown, games, mode };
}

/** Score to show at time t: before a rally ends show the score it was played at, after it the new score. */
export function scoreAt(S, rallies, t) {
  if (!S?.rallies.length) return null;
  let k = -1;
  for (let i = 0; i < rallies.length && rallies[i].start <= t; i++) k = i;
  if (k < 0) return { s: S.rallies[0].before, rally: S.rallies[0], live: false };
  const r = rallies[k], e = S.rallies[k];
  return t > r.end ? { s: e.after, rally: e, live: false, ended: true } : { s: e.before, rally: e, live: true };
}

/** Scoreboard in the top-left corner. names/colors keyed by team. */
export function drawScoreboard(ctx, w, h, at, { mode, doubles, names, colors, unknown = 0 }) {
  if (!at) return;
  const s = at.s;
  const u = Math.max(0.6, Math.min(w, h * 1.6) / 950);
  const fs = Math.round(15 * u), pad = 8 * u, rowH = 22 * u;
  ctx.save();
  ctx.font = `800 ${fs}px Inter, system-ui, sans-serif`; // widest weight, so the serve dot never touches the name
  const nameW = Math.max(...['A', 'B'].map(tm => ctx.measureText(names[tm]).width)) + 6 * u;
  const bw = nameW + 92 * u, bh = rowH * 2 + 26 * u;
  const x = 10 * u, y = 10 * u;
  ctx.fillStyle = 'rgba(17,18,20,0.82)';
  ctx.beginPath(); ctx.roundRect(x, y, bw, bh, 8 * u); ctx.fill();
  ctx.font = `600 ${Math.round(10 * u)}px Inter, system-ui, sans-serif`;
  ctx.fillStyle = '#b9b8b2';
  const head = `GAME ${s.game}${s.games.A + s.games.B ? ` (${s.games.A}–${s.games.B})` : ''} · ${mode.short.toUpperCase()}${unknown ? ' · ≈' : ''}`;
  ctx.fillText(head, x + pad, y + 14 * u);
  ['A', 'B'].forEach((tm, n) => {
    const ry = y + 22 * u + n * rowH;
    const serving = s.serving === tm;
    ctx.fillStyle = colors[tm];
    ctx.fillRect(x + pad, ry + 4 * u, 4 * u, rowH - 8 * u);
    ctx.font = `${serving ? 800 : 600} ${fs}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = '#f0efec';
    ctx.fillText(names[tm], x + pad + 10 * u, ry + rowH * 0.7);
    if (serving) {
      ctx.fillStyle = '#e6c84a';
      ctx.beginPath(); ctx.arc(x + pad + 18 * u + nameW, ry + rowH * 0.5, 4 * u, 0, Math.PI * 2); ctx.fill();
      if (!mode.rally && doubles) {
        ctx.font = `700 ${Math.round(10 * u)}px Inter, system-ui, sans-serif`;
        ctx.fillText(String(s.serverNum), x + pad + 25 * u + nameW, ry + rowH * 0.7);
      }
    }
    ctx.font = `800 ${Math.round(fs * 1.15)}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = '#f0efec';
    const sc = String(s[tm]);
    ctx.fillText(sc, x + bw - pad - ctx.measureText(sc).width, ry + rowH * 0.72);
  });
  ctx.restore();
}
