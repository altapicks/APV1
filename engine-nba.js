// ============================================================
// OverOwned — NBA ENGINE
// Mirrors the engine.js / engine-mma.js interface: pure functions,
// no React, no imports. Consumed by App.jsx for NBA slates.
//
// Key concepts:
//  - Minute projection blends rotation data (L3/L5/L10/season)
//  - Pace factor adjusts counting stats by game tempo
//  - Blowout risk fades starters' minutes and boosts bench
//  - PP stat lines (where available) are used as the "truth" projection,
//    then DK/PP Fantasy Scores are DERIVED from those stat projections
//    so both tabs compute from one shared stat model.
//  - Injury cascade: OUT/DOUBTFUL player's minutes and usage get
//    redistributed to positional backups (60/30/10 mins, 50/25 usg).
// ============================================================

function round2(n) { return Math.round(n * 100) / 100; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// ------------------------------------------------------------
// ODDS → PROBABILITY helpers (for DD/TD odds lines)
// ------------------------------------------------------------
function americanToProb(odds) {
  if (!odds || odds === 0) return 0;
  return odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
}

// ------------------------------------------------------------
// MINUTES PROJECTION
// Blend of recent games + season. Playoff game 1 weighting:
//   20% L3, 50% L5, 20% L10, 10% season.
// This de-emphasizes garbage-time L3 spikes while still capturing
// recent lineup changes.
// ------------------------------------------------------------
export function projectMinutes(minsObj) {
  if (!minsObj) return 0;
  const L3  = Number(minsObj.L3)  || 0;
  const L5  = Number(minsObj.L5)  || 0;
  const L10 = Number(minsObj.L10) || 0;
  const All = Number(minsObj.All) || 0;
  // If L3/L5 are both zero (rest/injury return), fall back to L10/All weighted
  if (L3 === 0 && L5 === 0 && (L10 > 0 || All > 0)) {
    return 0.55 * L10 + 0.45 * All;
  }
  return 0.20 * L3 + 0.50 * L5 + 0.20 * L10 + 0.10 * All;
}

// Apply blowout adjustment to minutes.
// When a team is heavily favored to blow out (blowout_risk high), their
// starters sit in Q4 → minutes dip. The losing team keeps starters in
// to chase → minutes hold or increase slightly.
function applyBlowoutAdjustment(mins, blowoutRisk, isStarter, isBench) {
  if (!blowoutRisk || blowoutRisk < 0.4) return mins;
  // Linear fade: 0.4 risk = 0% adj, 1.0 risk = full adj
  const intensity = clamp((blowoutRisk - 0.4) / 0.6, 0, 1);
  if (isStarter) {
    // Starters lose minutes in blowout (up to -12% at risk=1.0)
    return mins * (1 - 0.12 * intensity);
  }
  if (isBench) {
    // Deep bench gains minutes (up to +25% at risk=1.0)
    return mins * (1 + 0.25 * intensity);
  }
  return mins;
}

// ------------------------------------------------------------
// STATS PROJECTION
// Uses PP stat lines (points, reb, ast, threes, stls+blks) as the
// "true" projected per-game stats when available. Falls back to
// avg_ppg-derived estimates otherwise.
//
// stls+blks is split by position archetype:
//   guards:  70/30 stl/blk
//   wings:   55/45
//   bigs:    35/65
// ------------------------------------------------------------
function stlBlkSplit(positions) {
  const pos = Array.isArray(positions) ? positions.join('/') : String(positions || '');
  const hasC = /C/.test(pos) || /PF/.test(pos);
  const hasG = /PG/.test(pos) || /SG/.test(pos);
  if (hasC && !hasG) return { stlPct: 0.35, blkPct: 0.65 };   // big
  if (hasG && !hasC) return { stlPct: 0.70, blkPct: 0.30 };   // guard
  return { stlPct: 0.55, blkPct: 0.45 };                       // wing / hybrid
}

// Turnover estimate based on usage proxy (assists + usage rank)
function estimateTurnovers(projMins, assists, points) {
  if (projMins <= 0) return 0;
  // TO per min roughly scales with creation load (ast + pts)
  // League average ~2.3 TO per 36 min, ball-dominant guards ~3.5, bigs ~1.5
  const perMinCreation = (assists + points * 0.15) / Math.max(projMins, 1);
  const toPer36 = clamp(1.5 + perMinCreation * 8, 1.0, 4.2);
  return round2(toPer36 * (projMins / 36));
}

// Gaussian approximation for DD/TD probabilities
// P(X >= 10) for stat X with mean μ, stdev σ.
// We use ratio σ/μ ≈ 0.35 for NBA counting stats (empirical).
function probOverTen(mean) {
  if (mean < 4) return 0;
  if (mean >= 15) return 0.95;
  const sigma = Math.max(1.5, mean * 0.35);
  const z = (10 - mean) / sigma;
  // Normal CDF approximation: 1 - Φ(z)
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (z >= 0) p = 1 - p;
  return clamp(1 - p, 0, 1);
}

// Build full stat projection for a single player.
//   player  — slate.dk_players entry
//   ctx     — { paceFactor, blowoutRisk, team }
//
// Returns: { projMins, pts, reb, ast, threesM, stl, blk, to, pDD, pTD,
//            usg, status }
export function buildPlayerStats(player, ctx = {}) {
  const paceFactor = ctx.paceFactor || 1.0;
  const blowoutRisk = ctx.blowoutRisk || 0;
  const status = (player.status || 'ACTIVE').toUpperCase();

  if (status === 'OUT') {
    return { projMins: 0, pts: 0, reb: 0, ast: 0, threesM: 0, stl: 0, blk: 0, to: 0, pDD: 0, pTD: 0, usg: 0, status };
  }

  // Base minutes from rotation blend
  let baseMins = projectMinutes(player.mins);
  // Adjust by cascade multiplier (set by applyInjuryAdjustments)
  baseMins *= (player.minCascadeMult || 1);

  // Blowout adjustment — starters dip, bench swells
  const isStarter = baseMins >= 24;
  const isBench   = baseMins > 0 && baseMins < 15;
  const projMins = Math.max(0, applyBlowoutAdjustment(baseMins, blowoutRisk, isStarter, isBench));

  // Status downgrade: GTD -5%, Q -12%
  let statusMult = 1;
  if (status === 'GTD') statusMult = 0.95;
  else if (status === 'Q' || status === 'DOUBTFUL') statusMult = 0.88;
  const finalMins = projMins * statusMult;

  // If no PP lines, we derive from avg_ppg (DK per game). Convert DK to raw stats roughly.
  const pp = player.pp_stats || {};
  let pts, reb, ast, threesM, stlBlkSum;
  if (pp.points != null) {
    pts = Number(pp.points);
  } else {
    // Derive from avg DK points and typical pts-per-DK ratio (~0.58 for guards, ~0.5 for bigs)
    const avgDK = player.avg_ppg || 0;
    pts = avgDK * 0.56 * (finalMins / 32);
  }
  if (pp.rebounds != null) reb = Number(pp.rebounds);
  else reb = (player.avg_ppg || 0) * 0.09 * (finalMins / 32);
  if (pp.assists != null) ast = Number(pp.assists);
  else ast = (player.avg_ppg || 0) * 0.08 * (finalMins / 32);
  if (pp.threes != null) threesM = Number(pp.threes);
  else threesM = (player.avg_ppg || 0) * 0.025 * (finalMins / 32);
  if (pp.stls_blks != null) stlBlkSum = Number(pp.stls_blks);
  else stlBlkSum = (player.avg_ppg || 0) * 0.028 * (finalMins / 32);

  // Minute scaling: if our projected minutes differ from the PP-implied
  // minutes (which we assume ≈ rotation L5), we scale all counting stats.
  // We take the L5 minutes as the "implied" baseline PP used when setting lines.
  const L5 = Number(player.mins?.L5) || finalMins;
  const minScale = L5 > 0 ? finalMins / L5 : 1;
  // Blend: don't over-scale — PP lines are already adjusted for expected minutes.
  // We use 50% of the scale delta (blended to avoid over-correction).
  const effScale = 1 + (minScale - 1) * 0.5;

  pts      = pts      * effScale * paceFactor;
  reb      = reb      * effScale * paceFactor;
  ast      = ast      * effScale * paceFactor;
  threesM  = threesM  * effScale * paceFactor;
  stlBlkSum= stlBlkSum* effScale * paceFactor;

  const { stlPct, blkPct } = stlBlkSplit(player.positions);
  const stl = stlBlkSum * stlPct;
  const blk = stlBlkSum * blkPct;

  const to = estimateTurnovers(finalMins, ast, pts);

  // DD/TD probability
  // Use odds if provided (preferred), else gaussian estimate
  let pDD = 0, pTD = 0;
  const statsOverTen = [pts, reb, ast, stl + blk].filter(s => s >= 10 || s >= 6).length;
  if (player.dd_odds) pDD = americanToProb(player.dd_odds);
  else {
    // Probability of at least 2 categories reaching 10
    const probs = [probOverTen(pts), probOverTen(reb), probOverTen(ast), probOverTen(stl + blk)];
    // P(≥2 categories ≥10) = 1 - P(0 or 1)
    // Approximate via inclusion-exclusion
    let p0 = 1, p1sum = 0;
    probs.forEach(p => { p0 *= (1 - p); });
    probs.forEach(p => {
      let term = p;
      probs.forEach(q => { if (q !== p) term *= (1 - q); });
      p1sum += term;
    });
    pDD = clamp(1 - p0 - p1sum, 0, 1);
  }
  if (player.td_odds) pTD = americanToProb(player.td_odds);
  else {
    // P(≥3 categories ≥10) — rare without explicit odds, keep small
    const probs = [probOverTen(pts), probOverTen(reb), probOverTen(ast), probOverTen(stl + blk)];
    const avgP = probs.reduce((a, b) => a + b, 0) / 4;
    pTD = clamp(avgP * avgP * avgP * 1.5, 0, 0.25);
  }

  // Usage estimate: roughly (FGA_eq + ast) / team possessions share
  // Quick proxy: (pts*0.55 + ast*1.2) / (finalMins / 48 * 100)
  const usg = finalMins > 0
    ? round2((pts * 0.55 + ast * 1.2) / Math.max(finalMins, 1) * 48)
    : 0;

  return {
    projMins: round2(finalMins),
    pts: round2(pts),
    reb: round2(reb),
    ast: round2(ast),
    threesM: round2(threesM),
    stl: round2(stl),
    blk: round2(blk),
    to,
    pDD: round2(pDD),
    pTD: round2(pTD),
    usg,
    status,
  };
}

// ------------------------------------------------------------
// DK NBA SCORING
//  +1 pt, +0.5 3PM, +1.25 reb, +1.5 ast, +2 stl, +2 blk, −0.5 TO
//  +1.5 DD, +3 TD
// ------------------------------------------------------------
export function dkProjection(stats) {
  if (!stats) return 0;
  return round2(
    (stats.pts       || 0) * 1
    + (stats.threesM || 0) * 0.5
    + (stats.reb     || 0) * 1.25
    + (stats.ast     || 0) * 1.5
    + (stats.stl     || 0) * 2
    + (stats.blk     || 0) * 2
    - (stats.to      || 0) * 0.5
    + (stats.pDD     || 0) * 1.5
    + (stats.pTD     || 0) * 3
  );
}

// Ceiling projection: what an 85th-percentile night looks like.
// Applies +25% to counting stats + doubles DD/TD bonus frequency.
export function dkCeiling(stats) {
  if (!stats) return 0;
  return round2(
    (stats.pts       || 0) * 1.25
    + (stats.threesM || 0) * 0.5 * 1.3
    + (stats.reb     || 0) * 1.25 * 1.2
    + (stats.ast     || 0) * 1.5 * 1.2
    + (stats.stl     || 0) * 2 * 1.3
    + (stats.blk     || 0) * 2 * 1.3
    - (stats.to      || 0) * 0.5 * 0.9
    + Math.min(1, (stats.pDD || 0) * 2) * 1.5
    + Math.min(1, (stats.pTD || 0) * 2.5) * 3
  );
}

// ------------------------------------------------------------
// PP NBA FANTASY SCORE
//  +1 pt, +1.2 reb, +1.5 ast, +3 blk, +3 stl, −1 TO
//  (3PM is NOT included; DD/TD bonuses are NOT included)
// ------------------------------------------------------------
export function ppProjection(stats) {
  if (!stats) return 0;
  return round2(
    (stats.pts || 0) * 1
    + (stats.reb || 0) * 1.2
    + (stats.ast || 0) * 1.5
    + (stats.stl || 0) * 3
    + (stats.blk || 0) * 3
    - (stats.to  || 0) * 1
  );
}

// Simple EV: projection − PP line
export function ppEV(projection, line) {
  return round2(projection - line);
}

// Computes projected value for an individual PP stat category.
export function projectPPStat(stats, statName) {
  if (!stats) return 0;
  const s = statName.toLowerCase();
  if (s === 'points' || s === 'pts') return stats.pts || 0;
  if (s === 'rebounds' || s === 'reb') return stats.reb || 0;
  if (s === 'assists' || s === 'ast') return stats.ast || 0;
  if (s === '3pm' || s === 'threes' || s === '3-pt made') return stats.threesM || 0;
  if (s === 'stls+blks' || s === 'blks+stls' || s === 'defense') return (stats.stl || 0) + (stats.blk || 0);
  if (s === 'pts+reb+ast' || s === 'pra') return (stats.pts || 0) + (stats.reb || 0) + (stats.ast || 0);
  if (s === 'fantasy score' || s === 'fs') return ppProjection(stats);
  if (s === 'doubledouble' || s === 'double-double' || s === 'dd') return stats.pDD || 0;
  if (s === 'tripledouble' || s === 'triple-double' || s === 'td') return stats.pTD || 0;
  if (s === 'turnovers' || s === 'to') return stats.to || 0;
  return 0;
}

// ------------------------------------------------------------
// INJURY CASCADE
// When a player's status is OUT (or DOUBTFUL), redistribute their minutes
// and usage to positional backups on the same team.
//   Top backup: 60% mins, 50% usg
//   2nd backup: 30% mins, 25% usg
//   Rest: 10% spread across remaining rotation
// Adds `minCascadeMult` to each affected player's record; buildPlayerStats
// reads this to bump their final projections.
// ------------------------------------------------------------
export function applyInjuryAdjustments(players) {
  // Clone so we don't mutate the slate file
  const out = players.map(p => ({ ...p, minCascadeMult: 1, usgCascadeMult: 1, cascadeNote: null }));

  const byName = {};
  out.forEach((p, i) => { byName[p.name] = i; });

  // Find OUT / DOUBTFUL starters whose minutes should cascade
  const outPlayers = out.filter(p => {
    const s = (p.status || 'ACTIVE').toUpperCase();
    return (s === 'OUT' || s === 'DOUBTFUL') && projectMinutes(p.mins) >= 15;
  });

  outPlayers.forEach(outP => {
    // Backups = same team, not self, not OUT, similar position bucket
    const posBucket = primaryPosBucket(outP.positions);
    const teammates = out.filter(p =>
      p.team === outP.team &&
      p.name !== outP.name &&
      (p.status || 'ACTIVE').toUpperCase() !== 'OUT' &&
      primaryPosBucket(p.positions) === posBucket
    );
    // Rank backups by current minutes (descending)
    teammates.sort((a, b) => projectMinutes(b.mins) - projectMinutes(a.mins));
    const outMins = projectMinutes(outP.mins);
    if (outMins <= 0 || teammates.length === 0) return;

    // Boost formula: mult = 1 + (shareOfOutMins / currentMins)
    const applyBoost = (idx, mins_share, usg_share) => {
      if (idx >= teammates.length) return;
      const backup = teammates[idx];
      const curMins = Math.max(projectMinutes(backup.mins), 1);
      const newMins = curMins + outMins * mins_share;
      backup.minCascadeMult = (backup.minCascadeMult || 1) * (newMins / curMins);
      backup.usgCascadeMult = (backup.usgCascadeMult || 1) * (1 + usg_share * 0.5);
      backup.cascadeNote = `+${Math.round(outMins * mins_share)} min from ${outP.name} OUT`;
    };
    applyBoost(0, 0.60, 0.50);
    applyBoost(1, 0.30, 0.25);
    // Remaining 10% spread across indexes 2..n
    const rest = teammates.slice(2);
    if (rest.length > 0) {
      const each = 0.10 / rest.length;
      rest.forEach((b, i) => applyBoost(i + 2, each, 0));
    }
  });

  return out;
}

function primaryPosBucket(positions) {
  const pos = Array.isArray(positions) ? positions.join('/') : String(positions || '');
  if (/C/.test(pos)) return 'big';
  if (/PF/.test(pos) || /SF/.test(pos)) return 'wing';
  return 'guard';
}

// ============================================================
// DK NBA SHOWDOWN OPTIMIZER (1 CPT + 5 UTIL)
// CPT = 1.5× projection, 1.5× salary. $50K cap. Both teams required.
//
// Strategy:
//   1. Greedy build top-N by projection, respecting min-salary floor ($45K)
//      and both-teams constraint
//   2. Exposure caps via maxExp/minExp (percentages)
//   3. Phase-1 min-exposure fill with urgency weighting (mirror tennis)
// ============================================================
export function optimizeShowdown(players, nLineups = 150, salaryCap = 50000, minSalary = 45000) {
  const valid = players.filter(p =>
    p.projection > 0 &&
    p.util_salary > 0 &&
    p.cpt_salary > 0 &&
    (p.status || 'ACTIVE').toUpperCase() !== 'OUT'
  );
  if (valid.length < 6) return { lineups: [], counts: [], total: 0 };

  const teams = [...new Set(valid.map(p => p.team))];
  const needBothTeams = teams.length >= 2;
  const byName = {}; valid.forEach((p, i) => { byName[p.name] = i; });

  // Build candidate pool: for each possible CPT, find top UTIL combinations.
  // Enumeration space is huge (C(36, 5) × 36), so we sample intelligently:
  //   - For each CPT, take top K UTIL by projection (K = 18) then combine
  const allLineups = [];
  const K = Math.min(18, valid.length - 1);

  for (let c = 0; c < valid.length; c++) {
    const cpt = valid[c];
    const cptProj = 1.5 * cpt.projection;
    const cptSal = cpt.cpt_salary;
    if (cptSal > salaryCap - 5 * 1000) continue;   // need at least $1K per FLEX

    // Pool of UTIL candidates, sorted by value (proj/sal * proj for ceiling-ish weight)
    const utilPool = valid
      .map((p, i) => ({ p, i }))
      .filter(({ i }) => i !== c)
      .sort((a, b) => {
        const va = a.p.projection / Math.max(a.p.util_salary, 1);
        const vb = b.p.projection / Math.max(b.p.util_salary, 1);
        return vb - va;
      })
      .slice(0, K);

    // Enumerate all 5-combinations from the top-K pool (C(18,5) = 8568 — fine)
    const pool = utilPool;
    for (let a = 0; a < pool.length - 4; a++) {
      const pa = pool[a].p;
      for (let b = a + 1; b < pool.length - 3; b++) {
        const pb = pool[b].p;
        for (let d = b + 1; d < pool.length - 2; d++) {
          const pd = pool[d].p;
          for (let e = d + 1; e < pool.length - 1; e++) {
            const pe = pool[e].p;
            for (let f = e + 1; f < pool.length; f++) {
              const pf = pool[f].p;
              const totalSal = cptSal + pa.util_salary + pb.util_salary + pd.util_salary + pe.util_salary + pf.util_salary;
              if (totalSal > salaryCap || totalSal < minSalary) continue;

              // Check both-teams constraint
              if (needBothTeams) {
                const teamSet = new Set([cpt.team, pa.team, pb.team, pd.team, pe.team, pf.team]);
                if (teamSet.size < 2) continue;
              }

              const totalProj = cptProj + pa.projection + pb.projection + pd.projection + pe.projection + pf.projection;
              allLineups.push({
                proj: round2(totalProj),
                sal: totalSal,
                cpt: c,
                utils: [pool[a].i, pool[b].i, pool[d].i, pool[e].i, pool[f].i],
                players: [c, pool[a].i, pool[b].i, pool[d].i, pool[e].i, pool[f].i],
              });
            }
          }
        }
      }
    }
  }

  if (allLineups.length === 0) return { lineups: [], counts: new Array(valid.length).fill(0), total: 0 };

  allLineups.sort((x, y) => y.proj - x.proj);

  // Exposure caps
  const maxCaps = {}, minCaps = {};
  const defCap = nLineups;
  valid.forEach(p => {
    if (p.maxExp != null) maxCaps[p.name] = Math.max(1, Math.round(nLineups * p.maxExp / 100));
    if (p.minExp != null && p.minExp > 0) minCaps[p.name] = Math.max(1, Math.round(nLineups * p.minExp / 100));
  });

  const counts = new Array(valid.length).fill(0);
  const cptCounts = new Array(valid.length).fill(0);
  const selected = [];
  const usedKeys = new Set();

  function canAdd(lu) {
    for (const pid of lu.players) {
      const cap = maxCaps[valid[pid].name] ?? defCap;
      if (counts[pid] + 1 > cap) return false;
    }
    return true;
  }

  function keyOf(lu) { return lu.players.join(','); }

  function addLU(lu) {
    const k = keyOf(lu);
    if (usedKeys.has(k)) return;
    selected.push(lu); usedKeys.add(k);
    lu.players.forEach(pid => counts[pid]++);
    cptCounts[lu.cpt]++;
  }

  // Phase 1: min-exposure fill
  const minNames = Object.keys(minCaps);
  while (minNames.some(n => counts[byName[n]] < minCaps[n]) && selected.length < nLineups) {
    const urgency = new Map();
    minNames.forEach(n => {
      const pid = byName[n];
      if (counts[pid] >= minCaps[n]) return;
      urgency.set(pid, (minCaps[n] - counts[pid]) / nLineups);
    });
    if (urgency.size === 0) break;
    let best = null, bestScore = 0, bestProj = -Infinity;
    for (const lu of allLineups) {
      if (usedKeys.has(keyOf(lu)) || !canAdd(lu)) continue;
      let score = 0;
      for (const pid of lu.players) if (urgency.has(pid)) score += urgency.get(pid);
      if (score === 0) continue;
      if (score > bestScore + 1e-9 || (Math.abs(score - bestScore) < 1e-9 && lu.proj > bestProj)) {
        best = lu; bestScore = score; bestProj = lu.proj;
      }
    }
    if (!best) break;
    addLU(best);
  }

  // Phase 2: greedy fill
  for (const lu of allLineups) {
    if (selected.length >= nLineups) break;
    if (usedKeys.has(keyOf(lu)) || !canAdd(lu)) continue;
    addLU(lu);
  }

  return { lineups: selected, counts, cptCounts, total: allLineups.length };
}

// ============================================================
// CLASSIC OPTIMIZER (PG/SG/SF/PF/C/G/F/UTIL)
// Single-game slates don't need this, but provided for future.
// Randomized greedy with position-eligibility check.
// ============================================================
export function optimizeClassic(players, nLineups = 500, salaryCap = 50000) {
  const valid = players.filter(p =>
    p.projection > 0 &&
    p.salary > 0 &&
    (p.status || 'ACTIVE').toUpperCase() !== 'OUT'
  );
  if (valid.length < 8) return { lineups: [], counts: [], total: 0 };

  const ELIG = {
    PG:   p => p.positions?.includes('PG'),
    SG:   p => p.positions?.includes('SG'),
    SF:   p => p.positions?.includes('SF'),
    PF:   p => p.positions?.includes('PF'),
    C:    p => p.positions?.includes('C'),
    G:    p => p.positions?.some(x => ['PG','SG'].includes(x)),
    F:    p => p.positions?.some(x => ['SF','PF'].includes(x)),
    UTIL: () => true,
  };
  const SLOTS = ['PG','SG','SF','PF','C','G','F','UTIL'];

  const counts = new Array(valid.length).fill(0);
  const selected = [];
  const usedKeys = new Set();

  // Weighted random attempts
  const weights = valid.map(p => Math.pow(p.projection, 1.8));
  let total = weights.reduce((a, b) => a + b, 0);

  function pick(elig, blocked) {
    let tries = 0;
    while (tries < 25) {
      let r = Math.random() * total;
      for (let i = 0; i < valid.length; i++) {
        r -= weights[i];
        if (r <= 0) {
          if (!blocked.has(i) && elig(valid[i])) return i;
          break;
        }
      }
      tries++;
    }
    // Fallback: linear scan
    for (let i = 0; i < valid.length; i++) if (!blocked.has(i) && elig(valid[i])) return i;
    return -1;
  }

  let attempts = 0;
  const MAX_ATTEMPTS = nLineups * 30;
  while (selected.length < nLineups && attempts < MAX_ATTEMPTS) {
    attempts++;
    const picks = [];
    const blocked = new Set();
    let sal = 0;
    let ok = true;
    for (const slot of SLOTS) {
      const idx = pick(ELIG[slot], blocked);
      if (idx < 0) { ok = false; break; }
      picks.push(idx);
      blocked.add(idx);
      sal += valid[idx].salary;
      if (sal > salaryCap) { ok = false; break; }
    }
    if (!ok) continue;
    if (sal > salaryCap) continue;
    const sortedPlayers = [...picks].sort((a, b) => a - b);
    const key = sortedPlayers.join(',');
    if (usedKeys.has(key)) continue;
    usedKeys.add(key);
    const proj = round2(picks.reduce((s, i) => s + valid[i].projection, 0));
    selected.push({ proj, sal, players: sortedPlayers });
    picks.forEach(i => counts[i]++);
  }

  selected.sort((a, b) => b.proj - a.proj);
  return { lineups: selected, counts, total: selected.length };
}
