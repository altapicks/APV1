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
// DEVIG — remove bookmaker vig from a two-way market.
// Input: over/under American odds.
// Output: { pOver, pUnder, vig } where pOver + pUnder === 1.
// ------------------------------------------------------------
export function devig(overOdds, underOdds) {
  const pOverRaw  = americanToProb(overOdds);
  const pUnderRaw = americanToProb(underOdds);
  const total = pOverRaw + pUnderRaw;
  if (total <= 0) return { pOver: 0.5, pUnder: 0.5, vig: 0 };
  return {
    pOver:  pOverRaw / total,
    pUnder: pUnderRaw / total,
    vig:    total - 1,
  };
}

// ------------------------------------------------------------
// Beasley-Springer-Moro approximation for the inverse standard normal CDF.
// Accurate to ~1e-5 across the full (0,1) range; used to convert
// fair over-probability into z-scores for line→projection conversion.
// ------------------------------------------------------------
function invNormal(p) {
  if (p <= 0) return -10;
  if (p >= 1) return 10;
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969,
              138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887,
              66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184,
             -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const pLow = 0.02425, pHigh = 1 - pLow;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])
         / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  } else if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5]) * q
         / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])
         / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
}

// Per-stat standard deviation heuristics (NBA empirical). Used to convert
// devigged pOver → projected mean via the normal-approximation inverse.
//   projection = line + sigma * Φ⁻¹(pOverFair)
// Lines come in half-integers so the continuity correction is already
// baked into the half-line; we treat line as continuous for the normal approx.
function sigmaForStat(stat, line) {
  const m = Math.max(line, 1);
  switch (String(stat).toLowerCase()) {
    case 'points':    return Math.max(4.0, m * 0.33);
    case 'rebounds':  return Math.max(1.8, m * 0.35);
    case 'assists':   return Math.max(1.3, m * 0.40);
    case 'threes':
    case '3pm':       return 1.25;
    case 'stls_blks':
    case 'stls+blks': return Math.max(0.9, m * 0.45);
    case 'pra':       return Math.max(5.5, m * 0.28);
    default:          return Math.max(1.5, m * 0.35);
  }
}

// Convert a single devigged prop (line + fair over prob) to a projected
// mean using the normal approximation. Falls back gracefully when only
// one side of the market is offered.
export function lineToProjection(line, pOverFair, stat) {
  if (pOverFair == null || !isFinite(pOverFair)) return line;
  const p = clamp(pOverFair, 0.001, 0.999);
  const z = invNormal(p);
  const sigma = sigmaForStat(stat, line);
  return round2(line + sigma * z);
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
  // Only All available (e.g. playoff slate where rest/DNPs skew L3/L5/L10)
  if (L3 === 0 && L5 === 0 && L10 === 0 && All > 0) {
    return All;
  }
  // If L3/L5 are both zero (rest/injury return), fall back to L10/All weighted
  if (L3 === 0 && L5 === 0 && (L10 > 0 || All > 0)) {
    return 0.55 * L10 + 0.45 * All;
  }
  return 0.20 * L3 + 0.50 * L5 + 0.20 * L10 + 0.10 * All;
}

// Turnover estimate used only for the DK -0.5 scoring slot. Pure creation-load
// proxy from devigged projections; no minute dependency.
function estimateTurnovers(assists, points) {
  const creation = (assists || 0) + (points || 0) * 0.08;
  return round2(clamp(creation * 0.22, 0.3, 4.0));
}

// Gaussian approximation for DD/TD fallback — retained for the rare case
// a player has stat projections but no DD/TD odds (not used on current slate
// since all meaningful DD/TD markets are provided via odds).
function probOverTen(mean) {
  if (mean < 4) return 0;
  if (mean >= 15) return 0.95;
  const sigma = Math.max(1.5, mean * 0.35);
  const z = (10 - mean) / sigma;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (z >= 0) p = 1 - p;
  return clamp(1 - p, 0, 1);
}
function stlBlkSplit(positions) {
  const pos = Array.isArray(positions) ? positions.join('/') : String(positions || '');
  const hasC = /C/.test(pos) || /PF/.test(pos);
  const hasG = /PG/.test(pos) || /SG/.test(pos);
  if (hasC && !hasG) return { stlPct: 0.35, blkPct: 0.65 };   // big
  if (hasG && !hasC) return { stlPct: 0.70, blkPct: 0.30 };   // guard
  return { stlPct: 0.55, blkPct: 0.45 };                       // wing / hybrid
}

// Share of (rebounds + assists) combined, by position. Used when DK prices
// the PRA composite but not the individual Rebounds / Assists markets.
// Bigs rebound more and pass less; PGs pass more and rebound less.
function rebAstSplit(positions) {
  const pos = Array.isArray(positions) ? positions.join('/') : String(positions || '');
  if (/C/i.test(pos))  return { rebShare: 0.75, astShare: 0.25 };   // center
  if (/PF/i.test(pos)) return { rebShare: 0.65, astShare: 0.35 };   // power forward
  if (/SF/i.test(pos)) return { rebShare: 0.55, astShare: 0.45 };   // small forward / wing
  if (/PG/i.test(pos)) return { rebShare: 0.30, astShare: 0.70 };   // point guard
  return { rebShare: 0.40, astShare: 0.60 };                        // shooting guard / default
}

// Build a player stats object ENTIRELY from devigged DraftKings prop lines.
// No minute scaling, pace factor, blowout adjustment, cascade multiplier,
// or fallback estimation. If a stat has no DK line, it is treated as 0
// (and flagged via `hasStatData` so the UI can show which stats are missing).
// If a player has zero DK prop lines at all, `projectable` is false and the
// caller should exclude them from the showdown pool.
//
//   player  — slate.dk_players entry
//   ctx     — accepted for interface compatibility; all fields ignored
//
// Returns: { projectable, status, pts, reb, ast, threesM, stl, blk, to,
//            pDD, pTD, projMins (display only), usg, hasStatData }
export function buildPlayerStats(player, /* ctx */ _ctx = {}) {
  const status = (player.status || 'ACTIVE').toUpperCase();
  if (status === 'OUT') {
    return {
      projectable: false, status,
      pts: 0, reb: 0, ast: 0, threesM: 0, stl: 0, blk: 0, to: 0,
      pDD: 0, pTD: 0, projMins: 0, usg: 0,
      hasStatData: {},
    };
  }

  const props = player.dk_props || {};

  function readProp(key) {
    const pr = props[key];
    if (!pr || pr.line == null) return null;
    if (pr.over != null && pr.under != null) {
      const { pOver } = devig(pr.over, pr.under);
      return lineToProjection(pr.line, pOver, key);
    }
    // Single-sided market — treat line as the projection
    return pr.line;
  }

  const pts       = readProp('points');
  let   reb       = readProp('rebounds');
  let   ast       = readProp('assists');
  const threesM   = readProp('threes');
  const stlBlkSum = readProp('stls_blks');
  const pra       = readProp('pra');      // DK Points+Rebounds+Assists market

  // ─────────────────────────────────────────────────────────────────────
  // PRA BACK-CALC — when DK offers a PRA market but is missing one or
  // both of the component individual markets, back-calculate the missing
  // component(s). This is still PURE DK-market data (nothing fabricated),
  // just cross-sourced from the composite prop when the individual isn't
  // priced. Without this, players like Grayson Allen (PRA 13.5, Points
  // 8.5, but no Rebounds/Assists market) get projected using only their
  // Points line and badly underprojected.
  // ─────────────────────────────────────────────────────────────────────
  let rebFromPra = false, astFromPra = false;
  if (pra != null && pts != null && pra > pts) {
    const ra = Math.max(0, pra - pts);     // projected rebounds + assists
    if (reb == null && ast == null) {
      // Split the composite by position archetype
      const split = rebAstSplit(player.positions);
      reb = ra * split.rebShare;
      ast = ra * split.astShare;
      rebFromPra = true;
      astFromPra = true;
    } else if (reb == null && ast != null) {
      reb = Math.max(0, ra - ast);
      rebFromPra = true;
    } else if (ast == null && reb != null) {
      ast = Math.max(0, ra - reb);
      astFromPra = true;
    }
    // If both individual lines existed, we don't overwrite — those are the
    // most precise numbers. PRA just confirms the sum roughly matches.
  }

  const hasStatData = {
    points:    pts       != null,
    rebounds:  reb       != null,
    assists:   ast       != null,
    threes:    threesM   != null,
    stls_blks: stlBlkSum != null,
    rebFromPra, astFromPra,
    pra:       pra       != null,
  };

  // Needs Points at minimum to be "projectable" via DK prop devig.
  const projectableViaProps = hasStatData.points === true;

  // Manual projection fallback: a user-supplied DK fantasy score for
  // bench players DK hasn't priced with prop lines. This is the ONLY way
  // a no-DK-line player becomes projectable. If neither DK props nor a
  // manual projection exists, the player stays unprojectable (→ proj 0,
  // excluded from builder and ownership sim).
  const manualDk = (!projectableViaProps && player.manual_proj != null && player.manual_proj > 0)
    ? Number(player.manual_proj)
    : null;

  if (!projectableViaProps && manualDk == null) {
    return {
      projectable: false, status,
      pts: 0, reb: 0, ast: 0, threesM: 0, stl: 0, blk: 0, to: 0,
      pDD: 0, pTD: 0,
      projMins: round2(projectMinutes(player.mins)),   // informational
      usg: 0,
      hasStatData: {},
    };
  }

  if (manualDk != null) {
    // User-supplied DK fantasy value. Synthesize a minimal stats object
    // so scoring functions know to return it directly.
    return {
      projectable: true, status,
      manual: true, manualDk,
      pts: 0, reb: 0, ast: 0, threesM: 0, stl: 0, blk: 0, to: 0,
      pDD: 0, pTD: 0,
      projMins: round2(projectMinutes(player.mins)),
      usg: 0,
      hasStatData: {},
    };
  }

  // Projectable via DK props.

  // Position-aware steal/block split from the sum
  const { stlPct, blkPct } = stlBlkSplit(player.positions);
  const stl = (stlBlkSum || 0) * stlPct;
  const blk = (stlBlkSum || 0) * blkPct;

  // Turnovers: we only use this for the DK scoring component (-0.5 × TO).
  // Back-calculated from a simple creation-load proxy, capped so missing data
  // doesn't over-penalize.
  const to = estimateTurnovers(ast || 0, pts || 0);

  // DD/TD probabilities — direct from odds when present, else 0.
  // These also come from DraftKings markets (Same Game Parlay screen).
  const pDD = player.dd_odds ? americanToProb(player.dd_odds) : 0;
  const pTD = player.td_odds ? americanToProb(player.td_odds) : 0;

  // Minutes: INFORMATIONAL ONLY. Not used for scaling stats.
  const projMins = round2(projectMinutes(player.mins));

  return {
    projectable: true, status,
    pts: round2(pts || 0),
    reb: round2(reb || 0),
    ast: round2(ast || 0),
    threesM: round2(threesM || 0),
    stl: round2(stl),
    blk: round2(blk),
    to: round2(to),
    pDD: round2(pDD),
    pTD: round2(pTD),
    projMins,
    usg: 0,
    hasStatData,
  };
}

// Simplified TO estimate — kept as alias for back-compat with any older imports
function estimateTurnoversSimple(assists, points) {
  return estimateTurnovers(assists, points);
}

// ------------------------------------------------------------
// DK NBA SCORING
//  +1 pt, +0.5 3PM, +1.25 reb, +1.5 ast, +2 stl, +2 blk, −0.5 TO
//  +1.5 DD, +3 TD
//
// If stats came from a manual projection (no DK prop lines available),
// we return that manual value directly — no scoring recomputation.
// ------------------------------------------------------------
export function dkProjection(stats) {
  if (!stats) return 0;
  if (stats.manual && stats.manualDk != null) return round2(stats.manualDk);
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
// For manual projections, scale 1.25× as a reasonable ceiling.
export function dkCeiling(stats) {
  if (!stats) return 0;
  if (stats.manual && stats.manualDk != null) return round2(stats.manualDk * 1.25);
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
//
// For manual DK projections, approximate PP FS as 0.95× DK. This is a
// rough typical ratio for low-variance bench players where neither
// scoring formula gets big bonuses.
// ------------------------------------------------------------
export function ppProjection(stats) {
  if (!stats) return 0;
  if (stats.manual && stats.manualDk != null) return round2(stats.manualDk * 0.95);
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
// INJURY / STATUS PASSTHROUGH
// Previously this function redistributed minutes and usage from OUT
// players to their positional backups. Under the pure-DK-devig model,
// projections come directly from DraftKings' prop lines (which already
// reflect DK's view of who's playing when the lines were set), so we
// no longer mutate projections based on user-set statuses. The function
// is kept for API compatibility and simply clones the input so callers
// that mutate the result don't accidentally mutate the slate file.
// ------------------------------------------------------------
export function applyInjuryAdjustments(players) {
  return players.map(p => ({ ...p }));
}

// ============================================================
// FIELD OWNERSHIP SIMULATOR (Showdown)
// Weighted random sampling that models how the PUBLIC builds — chalk gravitates
// to high projection but not perfectly. Produces realistic ownership
// percentages (studs 40-65% rather than 95%+ from pure top-N enumeration).
//
// How it differs from optimizeShowdown:
//   - optimizeShowdown = top-N by projection → used for the USER'S builder
//   - simulateFieldShowdown = random weighted → used for ownership estimates
// ============================================================
export function simulateFieldShowdown(players, nSims = 1500, salaryCap = 50000) {
  const valid = players.filter(p =>
    p.projection > 0 &&
    p.util_salary > 0 &&
    p.cpt_salary > 0 &&
    (p.status || 'ACTIVE').toUpperCase() !== 'OUT'
  );
  if (valid.length < 6) return { counts: players.map(() => 0), lineups: 0 };

  // CPT weight: heavy emphasis on raw ceiling — field captains the best scorer
  // the vast majority of the time. Exponent 3.2 pushes the top stud to ~75%+
  // CPT frequency on showdown slates with a dominant player (matches observed
  // public ownership in contests like PHX@OKC Game 1).
  const cptWeights = valid.map(p => Math.pow(p.projection * 1.5, 3.2));
  const cptTotal = cptWeights.reduce((a, b) => a + b, 0);

  // UTIL weight: projection-dominated with a value tilt. Field chases pts
  // but still has some value awareness. Exponent on projection is higher
  // than before (1.7 vs 1.3) to match the fact that dominant players end
  // up in ~80% of field lineups once you add CPT + UTIL rosters together.
  const utilWeights = valid.map(p => {
    const v = p.projection / Math.max(p.util_salary / 1000, 1);
    return Math.pow(p.projection, 1.7) * Math.pow(v, 0.6);
  });

  const counts = new Array(valid.length).fill(0);
  let successes = 0;
  const maxAttempts = nSims * 6;

  function pickWeighted(wArr, total, blocked) {
    if (total <= 0) return -1;
    let r = Math.random() * total;
    for (let i = 0; i < wArr.length; i++) {
      if (blocked.has(i)) continue;
      r -= wArr[i];
      if (r <= 0) return i;
    }
    // Fallback: return first unblocked
    for (let i = 0; i < wArr.length; i++) if (!blocked.has(i)) return i;
    return -1;
  }

  for (let attempt = 0; attempt < maxAttempts && successes < nSims; attempt++) {
    // Pick CPT
    const cptIdx = pickWeighted(cptWeights, cptTotal, new Set());
    if (cptIdx < 0) continue;
    const cpt = valid[cptIdx];
    let salUsed = cpt.cpt_salary;
    if (salUsed > salaryCap - 5000) continue;   // impossible to fill 5 UTIL at $1k min

    // Pick 5 UTIL players
    const used = new Set([cptIdx]);
    const utils = [];
    let failed = false;
    for (let slot = 0; slot < 5; slot++) {
      // Remaining salary per slot
      const remainingSlots = 5 - slot;
      const maxPerSlot = (salaryCap - salUsed) - (remainingSlots - 1) * 1000;
      // Build a filtered weight list: only players with util_salary ≤ maxPerSlot
      let subTotal = 0;
      const effW = utilWeights.map((w, i) => {
        if (used.has(i) || valid[i].util_salary > maxPerSlot) return 0;
        subTotal += w;
        return w;
      });
      const pick = pickWeighted(effW, subTotal, used);
      if (pick < 0) { failed = true; break; }
      used.add(pick);
      utils.push(pick);
      salUsed += valid[pick].util_salary;
    }
    if (failed) continue;
    if (salUsed > salaryCap) continue;

    // Both-teams constraint
    const teams = new Set([cpt.team, ...utils.map(i => valid[i].team)]);
    if (teams.size < 2) continue;

    counts[cptIdx]++;
    utils.forEach(i => counts[i]++);
    successes++;
  }

  // Map counts back to original players array (not filtered)
  const nameIdx = {}; players.forEach((p, i) => { nameIdx[p.name] = i; });
  const fullCounts = new Array(players.length).fill(0);
  valid.forEach((p, i) => { fullCounts[nameIdx[p.name]] = counts[i]; });

  return { counts: fullCounts, lineups: successes };
}


// CPT = 1.5× projection, 1.5× salary. $50K cap. Both teams required.
//
// Strategy:
//   1. Greedy build top-N by projection, respecting min-salary floor ($45K)
//      and both-teams constraint
//   2. Exposure caps via maxExp/minExp (percentages)
//   3. Phase-1 min-exposure fill with urgency weighting (mirror tennis)
// ============================================================
export function optimizeShowdown(players, nLineups = 150, salaryCap = 50000, minSalary = 48000) {
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

  // ─── Exposure caps — three independent dimensions ────────────────────
  // 1. Total:   max/min times the player appears in ANY slot
  // 2. CPT:     max/min times the player is the captain specifically
  // 3. FLEX:    max/min times the player is in a UTIL slot specifically
  // Each player carries {maxExp, minExp, cptMaxExp, cptMinExp, flexMaxExp, flexMinExp}
  // (all as percentages of nLineups).
  const toCap = (pct) => (pct == null ? null : Math.max(1, Math.round(nLineups * pct / 100)));
  const toMin = (pct) => (pct == null || pct <= 0 ? 0 : Math.max(1, Math.round(nLineups * pct / 100)));
  const caps = valid.map(p => ({
    max:     p.maxExp     != null ? toCap(p.maxExp)     : nLineups,
    min:     toMin(p.minExp),
    cptMax:  p.cptMaxExp  != null ? toCap(p.cptMaxExp)  : nLineups,
    cptMin:  toMin(p.cptMinExp),
    flexMax: p.flexMaxExp != null ? toCap(p.flexMaxExp) : nLineups,
    flexMin: toMin(p.flexMinExp),
  }));

  const counts = new Array(valid.length).fill(0);
  const cptCounts = new Array(valid.length).fill(0);
  const flexCounts = new Array(valid.length).fill(0);
  const selected = [];
  const usedKeys = new Set();

  function canAdd(lu) {
    // CPT caps for the captain player
    const cc = caps[lu.cpt];
    if (counts[lu.cpt] + 1 > cc.max) return false;
    if (cptCounts[lu.cpt] + 1 > cc.cptMax) return false;
    // FLEX caps for each utility player
    for (const pid of lu.utils) {
      const fc = caps[pid];
      if (counts[pid] + 1 > fc.max) return false;
      if (flexCounts[pid] + 1 > fc.flexMax) return false;
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
    lu.utils.forEach(pid => flexCounts[pid]++);
  }

  // Phase 1: min-exposure fill (covers total, cpt, and flex mins)
  function hasUnmetMins() {
    for (let i = 0; i < valid.length; i++) {
      if (counts[i]     < caps[i].min)     return true;
      if (cptCounts[i]  < caps[i].cptMin)  return true;
      if (flexCounts[i] < caps[i].flexMin) return true;
    }
    return false;
  }
  while (hasUnmetMins() && selected.length < nLineups) {
    let best = null, bestScore = 0, bestProj = -Infinity;
    for (const lu of allLineups) {
      if (usedKeys.has(keyOf(lu)) || !canAdd(lu)) continue;
      let score = 0;
      // Reward addressing unmet mins
      const cc = caps[lu.cpt];
      if (counts[lu.cpt]    < cc.min)    score += (cc.min    - counts[lu.cpt])    / nLineups;
      if (cptCounts[lu.cpt] < cc.cptMin) score += (cc.cptMin - cptCounts[lu.cpt]) / nLineups;
      for (const pid of lu.utils) {
        const fc = caps[pid];
        if (counts[pid]     < fc.min)     score += (fc.min     - counts[pid])     / nLineups;
        if (flexCounts[pid] < fc.flexMin) score += (fc.flexMin - flexCounts[pid]) / nLineups;
      }
      if (score === 0) continue;
      if (score > bestScore + 1e-9 || (Math.abs(score - bestScore) < 1e-9 && lu.proj > bestProj)) {
        best = lu; bestScore = score; bestProj = lu.proj;
      }
    }
    if (!best) break;
    addLU(best);
  }

  // Phase 2: greedy fill by projection
  for (const lu of allLineups) {
    if (selected.length >= nLineups) break;
    if (usedKeys.has(keyOf(lu)) || !canAdd(lu)) continue;
    addLU(lu);
  }

  return { lineups: selected, counts, cptCounts, flexCounts, total: allLineups.length };
}

// ============================================================
// CLASSIC OPTIMIZER (PG/SG/SF/PF/C/G/F/UTIL)
// Single-game slates don't need this, but provided for future.
// Randomized greedy with position-eligibility check.
// ============================================================
export function optimizeClassic(players, nLineups = 500, salaryCap = 50000, minSalary = 48000) {
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
    if (sal < minSalary) continue;   // min-spend floor — avoid under-budget lineups
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
