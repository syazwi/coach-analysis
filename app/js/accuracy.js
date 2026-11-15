// Shot quality & accuracy — a "game review" in the spirit of chess engines' accuracy %.
// Every detected shot gets a 0–100 score from what the data shows about it:
//   outcome (unforced error / winner / forced error, when rallies are labeled),
//   what the opponent could do with it (did they attack it?),
//   tactical fit for the situation (3rd-shot drop, reset from transition, return & move up, …),
//   and body mechanics at contact (reaching, upright).
// Accuracy % = average shot score per player.
import { bisect, mean } from './util.js';
import { distToNet } from './court.js';

export const CLASSES = [
  { id: 'brilliant', name: 'Brilliant', sym: '!!', min: 98, color: '#1baf7a' },
  { id: 'great', name: 'Great', sym: '!', min: 90, color: '#3987e5' },
  { id: 'good', name: 'Good', sym: '✓', min: 74, color: '#8f8e86' },
  { id: 'inaccuracy', name: 'Inaccuracy', sym: '?!', min: 55, color: '#c98500' },
  { id: 'mistake', name: 'Mistake', sym: '?', min: 30, color: '#d95926' },
  { id: 'blunder', name: 'Blunder', sym: '??', min: -1, color: '#e34948' },
];
export const classOf = score => CLASSES.find(c => score >= c.min);

export const PHASES = [
  { id: 'start', name: 'Serve & return', test: sh => sh.idx <= 1 },
  { id: 'third', name: '3rd shot', test: sh => sh.idx === 2 },
  { id: 'transition', name: 'Transition', test: sh => sh.idx > 2 && sh.zone !== 'kitchen' },
  { id: 'kitchen', name: 'Kitchen battle', test: sh => sh.idx > 2 && sh.zone === 'kitchen' },
];

const ATTACK_TYPES = new Set(['Volley / speed-up', 'Overhead']);

function playerIndex(value, count) {
  if (value === '' || value === null || value === undefined || value === -1 || value === '-1') return -1;
  const k = Number(value);
  return Number.isInteger(k) && k >= 0 && k < count ? k : -1;
}

// Resolve the shot that decided a labeled rally. Older/imported matches may
// store `by` as text. If it is absent, fall back to the appropriate team's
// last detected shot so a labeled winner is still reflected in the score.
export function decisiveOutcome(rally, outcome, shots, players) {
  if (!rally || !outcome || !['winner', 'error'].includes(outcome.how)) return null;
  const by = playerIndex(outcome.by, players.length);
  const candidates = rally.shots.filter(j => shots[j]);
  let j = by >= 0 ? candidates.filter(x => shots[x].slot === by).at(-1) : undefined;
  if (j === undefined && outcome.winner) {
    const team = outcome.how === 'winner'
      ? outcome.winner
      : (outcome.winner === 'A' ? 'B' : outcome.winner === 'B' ? 'A' : null);
    if (team) j = candidates.filter(x => players[shots[x].slot]?.team === team).at(-1);
  }
  if (j === undefined) return null;
  return { j, slot: shots[j].slot, how: outcome.how, inferred: by < 0 || shots[j].slot !== by };
}

export function computeAccuracy(match, A) {
  const { shots, rallies, series, handed, T } = A;
  const players = match.players;
  const paddleLow = (k, t) => {
    const i = bisect(T, t), s = series[k];
    if (!s.present[i]) return false;
    return handed[k] === 'R' ? s.dyR[i] > 0.05 && s.visR[i] > 0.3 : s.dyL[i] > 0.05 && s.visL[i] > 0.3;
  };
  const atKitchen = (k, t) => { const y = series[k].y[bisect(T, t)]; return Number.isFinite(y) && distToNet(y) <= 10; };
  const arrivalAfter = (k, t) => {
    const s = series[k];
    for (let i = bisect(T, t); i < T.length && T[i] <= t + 8; i++) if (Number.isFinite(s.y[i]) && distToNet(s.y[i]) <= 10) return T[i] - t;
    return Infinity;
  };
  const decisive = rallies.map(r => decisiveOutcome(r, r.outcome, shots, players));

  const review = shots.map((sh, j) => {
    const r = rallies[sh.rally];
    const o = r?.outcome;
    const next = shots[j + 1] && shots[j + 1].rally === sh.rally ? shots[j + 1] : null;
    const result = decisive[sh.rally];
    const opps = players.map((p, k) => (p.team !== sh.team ? k : -1)).filter(k => k >= 0);
    let score = 82;
    const why = [];
    const add = (d, text) => { score += d; why.push({ d, text }); };

    // --- outcome (needs labels)
    if (result?.j === j && result.how === 'error') { score = 8; why.push({ d: -74, text: 'Unforced error — ended the rally' }); }
    else if (result?.j === j && result.how === 'winner') { score = 100; why.push({ d: 18, text: result.inferred ? 'Point-winning shot' : 'Winner' }); }
    else {
      if (next && result?.j === j + 1) {
        if (result.how === 'error') add(10, 'Forced the opponent into an error');
        if (result.how === 'winner') add(-35, 'Set up the opponent’s winner');
      }
      // --- what the opponent did with it
      if (next && sh.type !== 'Serve') {
        if (next.type === 'Overhead') add(-28, 'Popped up — opponent hit an overhead');
        else if (ATTACK_TYPES.has(next.type) && sh.rel < 1.15 && !ATTACK_TYPES.has(sh.type)) add(-18, 'Attackable ball — opponent sped it up');
        else if (next.zone === 'kitchen' && next.type === 'Dink' && sh.type === 'Dink') add(2, 'Kept the dink unattackable');
      }
      // --- tactical fit
      switch (sh.type) {
        case 'Return': {
          const dt = arrivalAfter(sh.slot, sh.t);
          if (dt <= 2.6) add(6, 'Returned and moved up quickly');
          else if (dt > 3.6) add(-14, 'Stayed back after the return');
          break;
        }
        case '3rd-shot drop': {
          add(5, 'Drop lets the team move forward');
          if (arrivalAfter(sh.slot, sh.t) > 4.5) add(-8, 'Did not follow the drop in');
          break;
        }
        case '3rd-shot drive': {
          if (opps.length && opps.every(k => atKitchen(k, sh.t))) add(-6, 'Drove into a set kitchen line');
          else add(3, 'Drive while opponents were still moving up');
          break;
        }
        case 'Reset (transition)':
          if (sh.rel < 0.9) add(6, 'Soft reset from the transition zone');
          else add(-12, 'Hard shot from the transition zone');
          break;
        case 'Dink':
          add(3, 'Patient dink');
          break;
        case 'Volley / speed-up': {
          const target = next ? next.slot : opps[0];
          if (target !== undefined && paddleLow(target, sh.t)) add(12, 'Attacked a low paddle');
          else if (target !== undefined && !atKitchen(target, sh.t)) add(8, 'Attacked a player out of position');
          if (next && ATTACK_TYPES.has(next.type) && o?.winner && o.winner !== sh.team) add(-12, 'Speed-up was countered and the point lost');
          break;
        }
        case 'Overhead':
          add(10, 'Put away a high ball');
          break;
        case 'Drive (baseline)':
          if (sh.idx >= 4) add(-6, 'Still at the baseline late in the rally');
          break;
        default:
      }
      // --- mechanics at contact
      if (sh.reach > 2.2) add(-6, 'Reached instead of moving the feet');
      const knee = series[sh.slot].knee[sh.i];
      if (sh.zone === 'kitchen' && knee > 168) add(-4, 'Upright at contact');
    }
    // The final contact can be either a winner or an error. Without a resolved
    // outcome, do not call it a mistake from motion alone.
    if (!result && !next && score < 82) {
      why.push({ d: 82 - score, text: 'Rally result unlabeled — final shot kept neutral' });
      score = 82;
    }
    score = Math.max(0, Math.min(100, Math.round(score)));
    return { j, slot: sh.slot, t: sh.t, score, cls: classOf(score).id, why };
  });

  const perPlayer = players.map((p, k) => {
    const mine = review.filter(x => x.slot === k);
    const counts = Object.fromEntries(CLASSES.map(c => [c.id, 0]));
    mine.forEach(x => { counts[x.cls]++; });
    const byPhase = Object.fromEntries(PHASES.map(ph => [ph.id, mean(mine.filter(x => ph.test(shots[x.j])).map(x => x.score))]));
    const byRally = rallies.map(r => mean(mine.filter(x => shots[x.j].rally === r.index).map(x => x.score)));
    return { slot: k, n: mine.length, accuracy: mean(mine.map(x => x.score)), counts, byPhase, byRally };
  });
  const team = {};
  for (const tm of ['A', 'B']) team[tm] = mean(review.filter(x => players[x.slot].team === tm).map(x => x.score));
  const labeledCount = decisive.filter(Boolean).length;
  return { review, perPlayer, team, labeled: labeledCount > 0, labeledCount, totalRallies: rallies.length };
}
