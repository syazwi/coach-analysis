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

  const review = shots.map((sh, j) => {
    const r = rallies[sh.rally];
    const o = r?.outcome;
    const next = shots[j + 1] && shots[j + 1].rally === sh.rally ? shots[j + 1] : null;
    const isLastOfRally = !next;
    const myLaterShot = r.shots.slice(r.shots.indexOf(j) + 1).some(x => shots[x].slot === sh.slot);
    const opps = players.map((p, k) => (p.team !== sh.team ? k : -1)).filter(k => k >= 0);
    let score = 82;
    const why = [];
    const add = (d, text) => { score += d; why.push({ d, text }); };

    // --- outcome (needs labels)
    if (o?.how === 'error' && o.by === sh.slot && !myLaterShot) { score = 8; why.push({ d: -74, text: 'Unforced error — ended the rally' }); }
    else if (o?.how === 'winner' && o.by === sh.slot && !myLaterShot) { score = 100; why.push({ d: 18, text: 'Winner' }); }
    else {
      if (next && o && shots[j + 1] === shots[r.shots[r.shots.length - 1]]) {
        if (o.how === 'error' && o.by === next.slot) add(10, 'Forced the opponent into an error');
        if (o.how === 'winner' && o.by === next.slot) add(-35, 'Set up the opponent’s winner');
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
  return { review, perPlayer, team, labeled: rallies.some(r => r.outcome?.winner) };
}
