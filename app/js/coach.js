// Coach engine: rules over metrics -> ranked findings (fix my game / exploit opponents) + training plan.
import { bisect, fmt, fmtPct, mean, median } from './util.js';
import { DRILLS } from './drills.js';

const LEVELS = ['3.0', '3.5', '4.0', '4.5'];
const B = (a, b, c, d) => ({ '3.0': a, '3.5': b, '4.0': c, '4.5': d });
const sec = v => `${fmt(v, 1)} s`;

/**
 * dir: 'lower' => lower value is better (bad when value > bench)
 *      'higher' => higher value is better (bad when value < bench)
 */
export const RULES = [
  {
    id: 'late_kitchen_return', title: 'Late to the kitchen after the return', category: 'Positioning', dir: 'lower',
    bench: B(3.0, 2.6, 2.2, 1.9), fmtV: sec, minN: 3,
    measure: m => ({ value: median(m.arrivalReturn.map(e => e.dt)), n: m.arrivalReturn.length, events: ctx => ctx.m.arrivalReturn.filter(e => e.dt > ctx.bench).map(e => e.t) }),
    fix: { problem: 'After returning you take too long to reach the kitchen line, so the serving team can hit 3rd shots at your feet.', counter: 'Return deep with height to buy time and move forward on contact. Split step as the server hits the 3rd shot, then keep moving.' },
    exploit: { opportunity: 'They are slow to reach the kitchen after returning — they get caught in the transition zone.', counter: 'Drive or drop the 3rd shot at their feet while they are still moving up; target the returner, not the partner already at the line.' },
    drills: ['return_and_rush', 'split_step_call'],
  },
  {
    id: 'late_kitchen_third', title: 'Slow to move up after the 3rd shot', category: 'Positioning', dir: 'lower',
    bench: B(5.0, 4.5, 4.0, 3.5), fmtV: sec, minN: 3,
    measure: m => ({ value: median(m.arrivalThird.map(e => e.dt)), n: m.arrivalThird.length, events: ctx => ctx.m.arrivalThird.filter(e => e.dt > ctx.bench).map(e => e.t) }),
    fix: { problem: 'After the 3rd shot you stay back too long, giving the opponents time to attack from the kitchen.', counter: 'After a good drop, move up 1–2 steps and split each time. After a drive, expect a block and follow it in with a 5th-shot drop.' },
    exploit: { opportunity: 'The serving team hangs back after their 3rd shot.', counter: 'Keep the 4th shot low and deep or at their feet; they will be forced into hard low volleys from the transition zone.' },
    drills: ['third_drop_ladder', 'drive_drop_combo'],
  },
  {
    id: 'transition_dwell', title: 'Too much time in the transition zone', category: 'Positioning', dir: 'lower',
    bench: B(0.30, 0.25, 0.20, 0.16), fmtV: v => fmtPct(v), minN: 1,
    measure: m => ({ value: m.zone.transition, n: m.readyFrames + 1, events: ctx => ctx.m.transitionContacts }),
    fix: { problem: 'You spend a large share of rally time in “no-man’s land”, where you receive the hardest balls (at your feet).', counter: 'Treat the transition zone as a place to pass through: split step, reset softly into the kitchen, and move up after each good reset.' },
    exploit: { opportunity: 'They live in the transition zone.', counter: 'Keep the ball low at their feet and attack anything that pops up. Avoid hitting deep balls that push them back to the baseline.' },
    drills: ['transition_reset', 'split_step_call'],
  },
  {
    id: 'paddle_low', title: 'Paddle drops low in ready position', category: 'Technique', dir: 'lower',
    bench: B(0.40, 0.32, 0.25, 0.18), fmtV: v => fmtPct(v), minN: 25,
    measure: m => ({ value: m.paddleLowPct, n: m.readyFrames }),
    fix: { problem: 'At the kitchen your paddle hand is often below your hips, so speed-ups to the chest and shoulder beat you.', counter: 'Reset to “paddle up, in front of the chest, backhand-ready” after every shot.' },
    exploit: { opportunity: 'Their paddle sits low at the kitchen line.', counter: 'Speed up to their paddle-side shoulder or chest, especially off any dink that sits up.' },
    drills: ['hands_battle', 'low_ready_wall'],
  },
  {
    id: 'standing_tall', title: 'Standing tall at the kitchen', category: 'Technique', dir: 'lower',
    bench: B(0.45, 0.38, 0.30, 0.22), fmtV: v => fmtPct(v), minN: 25,
    measure: m => ({ value: m.tallPct, n: m.readyFrames, extra: `avg knee angle ${fmt(m.kneeAvg, 0)}°` }),
    fix: { problem: 'Your legs are nearly straight (knee angle > 165°) for much of the kitchen play, which makes dinks pop up and slows your reaction.', counter: 'Sit into an athletic stance (knees ~140–150°), weight on the balls of your feet, and lift dinks with the legs.' },
    exploit: { opportunity: 'They stand up straight at the kitchen.', counter: 'Dink low to their feet and wide; their dinks will rise — speed up the high ones.' },
    drills: ['low_ready_wall', 'rope_dinks'],
  },
  {
    id: 'narrow_stance', title: 'Narrow stance', category: 'Technique', dir: 'higher',
    bench: B(1.0, 1.1, 1.2, 1.25), fmtV: v => `${fmt(v, 2)}× shoulders`, minN: 25,
    measure: m => ({ value: m.stanceAvg, n: m.readyFrames }),
    fix: { problem: 'Your feet are close together relative to your shoulders, so you lose balance on wide and body balls.', counter: 'Feet a bit wider than shoulders, knees out, weight centred.' },
    exploit: { opportunity: 'Their base is narrow.', counter: 'Move them side to side with wide dinks, then attack the body.' },
    drills: ['lateral_dink_footwork', 'low_ready_wall'],
  },
  {
    id: 'split_step', title: 'Split step late or missing', category: 'Footwork', dir: 'higher',
    bench: B(0.35, 0.45, 0.55, 0.65), fmtV: v => `${fmtPct(v)} on time`, minN: 8,
    measure: m => ({ value: m.splitOnPct, n: m.splitN, events: ctx => ctx.m.split.events }),
    fix: { problem: 'When the opponent hits, you are often still moving or land your split step late.', counter: 'Hop into a small split step as the opponent starts the forward swing; land as they make contact.' },
    exploit: { opportunity: 'They are moving when you hit.', counter: 'Hit behind them / to where they came from, and use pace through the middle.' },
    drills: ['split_step_call', 'transition_reset'],
  },
  {
    id: 'slow_reaction', title: 'Slow first step', category: 'Footwork', dir: 'lower',
    bench: B(0.65, 0.58, 0.50, 0.45), fmtV: sec, minN: 5,
    measure: m => ({ value: m.reactionAvg, n: m.reaction.length, events: ctx => ctx.m.reaction.filter(r => r.dt > ctx.bench).map(r => r.t) }),
    fix: { problem: 'Your first movement after the opponent’s contact is slow.', counter: 'Stay on the balls of your feet with a split step and read the opponent’s paddle face early.' },
    exploit: { opportunity: 'They react slowly to the ball.', counter: 'Change direction and pace; quick hands battles and angles favour you.' },
    drills: ['split_step_call', 'interval_footwork'],
  },
  {
    id: 'overreach', title: 'Reaching instead of moving the feet', category: 'Footwork', dir: 'lower',
    bench: B(0.25, 0.2, 0.15, 0.12), fmtV: v => fmtPct(v), minN: 10,
    measure: m => ({ value: m.shots ? m.overreach.length / m.shots : NaN, n: m.shots, events: ctx => ctx.m.overreach }),
    fix: { problem: 'On many shots your paddle arm is fully extended to the side — you reach instead of moving your feet.', counter: 'Shuffle to wide balls and set your feet before contact; return wide balls cross-court.' },
    exploit: { opportunity: 'They reach for wide balls.', counter: 'Dink wide to pull them off balance; look for an Erne or ATP when they over-extend.' },
    drills: ['lateral_dink_footwork'],
  },
  {
    id: 'off_kitchen_line', title: 'Playing a step behind the kitchen line', category: 'Positioning', dir: 'lower',
    bench: B(9.5, 9.0, 8.6, 8.3), fmtV: v => `${fmt(v - 7, 1)} ft behind line`, minN: 40,
    measure: m => ({ value: m.kitchenDepth, n: m.readyFrames }),
    fix: { problem: 'When you are “up”, you stand well behind the non-volley line, which gives opponents angles and feet to aim at.', counter: 'Toes just behind the line during dinking; step back only to defend a lob.' },
    exploit: { opportunity: 'They play a step off the line.', counter: 'Short, low dinks at their feet; drop-volleys and sharp angles.' },
    drills: ['rope_dinks', 'error_free_dinking'],
  },
  {
    id: 'bh_avoid', title: 'Avoiding the backhand', category: 'Technique', dir: 'higher',
    bench: B(0.25, 0.28, 0.30, 0.32), fmtV: v => `${fmtPct(v)} backhands`, minN: 12,
    measure: m => ({ value: m.shots ? m.bh / m.shots : NaN, n: m.shots }),
    fix: { problem: 'You hit few backhands — likely running around them, which pulls you out of position.', counter: 'Build a reliable backhand dink and drop; let middle balls go to the forehand player.' },
    exploit: { opportunity: 'They avoid their backhand.', counter: 'Target their backhand side, especially cross-court and at the feet; force them to hit it.' },
    drills: ['backhand_dinks'],
  },
  {
    id: 'bh_errors', title: 'Backhand errors', category: 'Consistency', dir: 'lower', needsOutcomes: true,
    bench: B(0.6, 0.55, 0.5, 0.5), fmtV: v => `${fmtPct(v)} of errors on BH`, minN: 4,
    measure: m => ({ value: m.errors.length ? m.errorsBH / m.errors.length : NaN, n: m.errors.length, events: ctx => ctx.m.errors }),
    fix: { problem: 'Most of your errors come off the backhand.', counter: 'Shorter backhand swing, paddle out front, firm wrist; use more margin over the net.' },
    exploit: { opportunity: 'Their backhand breaks down.', counter: 'Feed their backhand repeatedly; they will eventually miss.' },
    drills: ['backhand_dinks', 'error_free_dinking'],
  },
  {
    id: 'errors', title: 'Losing points on your own errors', category: 'Consistency', dir: 'lower', needsOutcomes: true,
    bench: B(4, 3.5, 3, 2.5), fmtV: v => `${fmt(v, 1)} errors / 10 rallies`, minN: 6,
    measure: (m, ctx) => ({ value: ctx.labeled ? m.errors.length / ctx.labeled * 10 : NaN, n: ctx.labeled, events: c => c.m.errors }),
    fix: { problem: 'You make frequent errors relative to rallies played.', counter: 'Raise your margin: aim higher over the net and further from the lines; reset instead of attacking low balls.' },
    exploit: { opportunity: 'They make frequent errors.', counter: 'Play patiently — keep the ball in play and make them hit one more ball.' },
    drills: ['error_free_dinking', 'transition_reset'],
  },
  {
    id: 'third_drive_heavy', title: 'Predictable 3rd shot (mostly drives)', category: 'Tactics', dir: 'lower',
    bench: B(0.85, 0.8, 0.75, 0.7), fmtV: v => `${fmtPct(v)} drives`, minN: 5,
    measure: m => { const n = m.thirdDrives + m.thirdDrops; return { value: n ? m.thirdDrives / n : NaN, n }; },
    fix: { problem: 'Almost all of your 3rd shots are drives, which opponents can predict and block.', counter: 'Mix in 3rd-shot drops, or follow drives with a 5th-shot drop.' },
    exploit: { opportunity: 'They almost always drive the 3rd shot.', counter: 'Stay ready with a soft block deep to the feet; counter-punch high drives.' },
    drills: ['third_drop_ladder', 'drive_drop_combo'],
  },
  {
    id: 'fatigue', title: 'Slowing down late in the match', category: 'Fitness', dir: 'lower',
    bench: B(1.2, 1.18, 1.15, 1.12), fmtV: v => `${fmtPct(v - 1)} slower`, minN: 6,
    measure: m => {
      const f = m.fatigue;
      const ratios = [];
      if (f.arr1 > 0 && f.arr2 > 0) ratios.push(f.arr2 / f.arr1);
      if (f.speed1 > 0 && f.speed2 > 0) ratios.push(f.speed1 / f.speed2);
      return { value: ratios.length ? mean(ratios) : NaN, n: m.arrivalReturn.length + m.arrivalThird.length + m.reaction.length };
    },
    fix: { problem: 'Your movement speed and kitchen arrival get slower in the second half of the match.', counter: 'Add conditioning; late in games, play higher-percentage shots and keep points shorter.' },
    exploit: { opportunity: 'They fade late in the match.', counter: 'Extend rallies and move them side to side; lobs and deep balls tire legs.' },
    drills: ['interval_footwork'],
  },
];

export const TEAM_RULES = [
  {
    id: 'partner_gap', title: 'Big gap between partners', category: 'Teamwork', dir: 'lower',
    bench: B(0.30, 0.25, 0.20, 0.15), fmtV: v => `${fmtPct(v)} of kitchen time > 12 ft apart`, minN: 30,
    measure: t => ({ value: t.gapPct, n: t.frames, events: () => t.gapEvents }),
    fix: { problem: 'At the kitchen you and your partner are often more than 12 ft apart, which opens the middle.', counter: 'Shift together as if tied by a 10 ft rope; the ball-side player covers the line, the other the middle.' },
    exploit: { opportunity: 'Their partners split apart at the kitchen.', counter: 'Attack the middle between them — dinks and drives down the centre cause hesitation.' },
    drills: ['shadow_shift', 'middle_call'],
  },
  {
    id: 'middle_open', title: 'Both partners on the same half', category: 'Teamwork', dir: 'lower',
    bench: B(0.30, 0.26, 0.22, 0.18), fmtV: v => `${fmtPct(v)} of rally time`, minN: 30,
    measure: t => ({ value: t.middleOpenPct, n: t.frames, events: () => t.middleEvents }),
    fix: { problem: 'You and your partner often end up on the same half of the court, leaving a whole side open.', counter: 'After chasing a wide ball, recover to your half; communicate “switch” when you cross.' },
    exploit: { opportunity: 'They bunch on one side.', counter: 'Hit to the open side or behind the partner who moved.' },
    drills: ['middle_call', 'shadow_shift'],
  },
];

function severity(ratio) {
  if (ratio >= 1.45) return 'high';
  if (ratio >= 1.15) return 'medium';
  return 'low';
}

function impactOf(events, A, team) {
  if (!events?.length) return null;
  const rallySet = new Set();
  events.forEach(t => { const i = bisect(A.T, t); if (A.inRally[i] >= 0) rallySet.add(A.inRally[i]); });
  const rs = [...rallySet].map(i => A.rallies[i]).filter(r => r.outcome?.winner);
  if (!rs.length) return null;
  const lost = rs.filter(r => r.outcome.winner !== team).length;
  const teamLost = A.rallies.filter(r => r.outcome?.winner && r.outcome.winner !== team).length;
  return { pointsLost: lost, share: teamLost ? lost / teamLost : 0, lossRate: lost / rs.length };
}

function evaluate(rule, subject, ctx, lens, who) {
  if (rule.needsOutcomes && !ctx.labeled) return null;
  const r = rule.measure(subject, ctx);
  if (!Number.isFinite(r.value) || r.n < rule.minN) return null;
  const bench = rule.bench[ctx.skill] ?? rule.bench['3.5'];
  const worse = rule.dir === 'lower' ? r.value > bench : r.value < bench;
  const ratio = rule.dir === 'lower' ? r.value / bench : bench / Math.max(r.value, 1e-3);
  const events = typeof r.events === 'function' ? r.events({ m: subject, bench }) : [];
  const conf = Math.min(1, r.n / (rule.minN * 4)) * Math.min(1, (who.conf ?? 0.7) + 0.2);
  const base = { rule, ruleId: rule.id, title: rule.title, category: rule.category, lens, who: who.label, team: who.team, slot: who.slot, value: r.value, bench, n: r.n, extra: r.extra, ratio, conf };
  if (!worse) return { ...base, strength: ratio < 0.85 };
  const impact = impactOf(events, ctx.A, who.team);
  const sev = severity(ratio);
  const sevW = { high: 3, medium: 2, low: 1 }[sev];
  const text = lens === 'fix' ? rule.fix : rule.exploit;
  return {
    ...base, worse: true, severity: sev, impact,
    score: sevW * (0.5 + conf) * (1 + (impact?.share ?? 0) * 2),
    problem: text.problem ?? text.opportunity, counter: text.counter, drills: rule.drills,
    clips: [...new Set(events.map(t => Math.round(t * 10) / 10))].slice(0, 30).map(t => ({ start: Math.max(0, t - 2.5), end: t + 2.0 })),
    evidence: `${rule.fmtV(r.value)} vs target ${rule.fmtV(bench)} · n=${r.n}${r.extra ? ' · ' + r.extra : ''}`,
  };
}

export function coach(match, A) {
  const skill = LEVELS.includes(match.cfg.skill) ? match.cfg.skill : '3.5';
  const labeled = A.rallies.filter(r => r.outcome?.winner).length;
  const ctx = { skill, labeled, A };
  const findings = [], strengths = [];
  match.players.forEach((p, k) => {
    const m = A.metrics[k];
    if (m.coverage < 0.2) return;
    const lens = p.team === match.cfg.myTeam ? 'fix' : 'exploit';
    const who = { label: p.label, team: p.team, slot: k, conf: m.conf };
    for (const rule of RULES) {
      const f = evaluate(rule, m, { ...ctx, m }, lens, who);
      if (!f) continue;
      if (f.worse) findings.push(f); else if (f.strength) strengths.push(f);
    }
  });
  if (match.cfg.format === 'doubles') {
    for (const tm of ['A', 'B']) {
      const t = A.team[tm];
      const names = match.players.filter(p => p.team === tm).map(p => p.label).join(' & ');
      const lens = tm === match.cfg.myTeam ? 'fix' : 'exploit';
      for (const rule of TEAM_RULES) {
        const f = evaluate(rule, t, ctx, lens, { label: names, team: tm, slot: -1, conf: 0.7 });
        if (!f) continue;
        if (f.worse) findings.push(f); else if (f.strength) strengths.push(f);
      }
    }
  }
  findings.sort((a, b) => b.score - a.score);
  findings.forEach((f, i) => { f.id = `${f.ruleId}-${f.slot}-${i}`; });
  return { findings, strengths, labeled, summary: summarize(match, A, findings, strengths, labeled) };
}

function summarize(match, A, findings, strengths, labeled) {
  const fix = findings.filter(f => f.lens === 'fix');
  const exp = findings.filter(f => f.lens === 'exploit');
  const parts = [];
  parts.push(`${A.rallies.length} rallies and ${A.shots.length} shots detected.`);
  if (fix[0]) parts.push(`Top priority for your team: <b>${fix[0].title.toLowerCase()}</b> (${fix[0].who}, ${fix[0].evidence.split(' · ')[0]}).`);
  if (fix[1]) parts.push(`Then: ${fix[1].title.toLowerCase()} (${fix[1].who}).`);
  if (exp[0]) parts.push(`Best opportunity against the opponents: <b>${exp[0].title.toLowerCase()}</b> — ${exp[0].who}. ${exp[0].counter}`);
  const mine = strengths.filter(s => s.lens === 'fix');
  if (mine[0]) parts.push(`Strength to keep: ${mine[0].who} passes the “${mine[0].title.toLowerCase()}” check comfortably (${mine[0].rule.fmtV(mine[0].value)} vs target ${mine[0].rule.fmtV(mine[0].bench)}).`);
  if (!labeled) parts.push('<span class="muted">Tip: label rally winners in “Rallies & outcomes” to unlock error analysis and point-impact ranking.</span>');
  return parts.join(' ');
}

export function buildPlan(result, match) {
  const fix = result.findings.filter(f => f.lens === 'fix');
  const drillIds = [];
  fix.forEach(f => f.drills.forEach(d => { if (!drillIds.includes(d)) drillIds.push(d); }));
  if (!drillIds.length) drillIds.push('error_free_dinking', 'third_drop_ladder', 'split_step_call');
  const focus = fix.filter((f, i) => fix.findIndex(g => g.ruleId === f.ruleId) === i).slice(0, 3);
  const d = i => drillIds[i % drillIds.length];
  const warm = { name: 'Warm-up dinking + mobility', minutes: 10 };
  const day = (title, items, note) => ({ title, items, note });
  const di = id => ({ id, name: DRILLS[id].name, minutes: DRILLS[id].minutes });
  return {
    focus,
    days: [
      day('Day 1 — Technique', [warm, di(d(0)), di(d(1))], focus[0] ? `Focus: ${focus[0].title}` : ''),
      day('Day 2 — Match play', [warm, { name: 'Games to 11 with one focus cue', minutes: 45 }], focus[0] ? `Cue: “${DRILLS[d(0)].cues[0]}”` : ''),
      day('Day 3 — Technique', [warm, di(d(2)), di(d(0))], focus[1] ? `Focus: ${focus[1].title}` : ''),
      day('Day 4 — Rest / mobility', [{ name: 'Stretching, light walk', minutes: 20 }], 'Recovery'),
      day('Day 5 — Footwork & pressure', [warm, di(d(3)), di('interval_footwork')], focus[2] ? `Focus: ${focus[2].title}` : ''),
      day('Day 6 — Match play + film', [warm, { name: 'Record a match and re-analyze it here', minutes: 60 }], 'Compare with this match in “Compare”'),
      day('Day 7 — Rest', [{ name: 'Rest', minutes: 0 }], ''),
    ],
  };
}
