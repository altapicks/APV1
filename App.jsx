import { Component, useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { processMatch, dkProjection, ppProjection, ppEV, optimize, optimizeShowdown } from './engine.js';
import { processFight, dkMMAProjection, dkMMACeiling, ppMMAProjection, ppMMACeiling, optimizeMMA } from './engine-mma.js';
import {
  buildPlayerStats as nbaBuildPlayerStats,
  applyInjuryAdjustments as nbaApplyInjuryAdjustments,
  dkProjection as nbaDkProjection,
  dkCeiling as nbaDkCeiling,
  ppProjection as nbaPpProjection,
  projectPPStat as nbaProjectPPStat,
  ppEV as nbaPpEV,
  optimizeShowdown as nbaOptimizeShowdown,
  optimizeClassic as nbaOptimizeClassic,
  devig as nbaDevig,
  lineToProjection as nbaLineToProjection,
} from './engine-nba.js';

// ═══════════════════════════════════════════════════════════════════════
// ERROR BOUNDARY — catches any runtime crash and shows it on screen
// ═══════════════════════════════════════════════════════════════════════
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }
  static getDerivedStateFromError(error) { return { hasError: true, error }; }
  componentDidCatch(error, errorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
    this.setState({ errorInfo });
  }
  render() {
    if (this.state.hasError) {
      const errMsg = this.state.error?.message || String(this.state.error) || 'Unknown error';
      const stack = this.state.error?.stack || '';
      const compStack = this.state.errorInfo?.componentStack || '';
      return (
        <div style={{ padding: '40px 20px' }}>
          <div style={{ textAlign: 'center', marginBottom: 16 }}>
            <h2 style={{ color: '#EF4444', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="warning" size={18} color="#EF4444"/> Runtime error</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 8 }}>The app crashed rendering this view. Details below — please share this with support.</p>
          </div>
          <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.4)', borderRadius: 8, padding: 16, maxWidth: 900, margin: '0 auto', fontSize: 12, fontFamily: 'monospace', color: '#EF4444', whiteSpace: 'pre-wrap', overflow: 'auto', wordBreak: 'break-word' }}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>{errMsg}</div>
            {compStack && <div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 12 }}><strong style={{ color: '#F5C518' }}>Component stack:</strong>{compStack}</div>}
            {stack && <div style={{ color: 'var(--text-dim)', fontSize: 11 }}><strong style={{ color: '#F5C518' }}>Stack trace:</strong>{'\n' + stack}</div>}
          </div>
          <div style={{ textAlign: 'center', marginTop: 16 }}>
            <button onClick={() => this.setState({ hasError: false, error: null, errorInfo: null })}
              style={{ background: '#F5C518', color: '#0A1628', border: 'none', borderRadius: 6, padding: '8px 20px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
              Reset & Try Again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// GLOSSARIES — one per sport
// ═══════════════════════════════════════════════════════════════════════
const GLOSSARY_TENNIS = [
  { icon: 'trophy',        label: 'Top 3 Value', desc: 'Highest pts/$1K salary' },
  { icon: 'target',        label: 'Top 3 Straight Sets', desc: 'Most likely straight-set win (+6 bonus)' },
  { icon: 'gem',           label: 'Hidden Gem', desc: 'Low ownership + high upside' },
  { icon: 'bomb',          label: 'Trap', desc: 'High ownership + bust risk' },
  { icon: 'flame',         label: 'Top PP EV', desc: 'Best expected value vs PP line' },
  { icon: 'trending-down', label: 'Worst PP EV', desc: 'Strong LESS play' },
];
const GLOSSARY_MMA = [
  { icon: 'trophy',        label: 'Top 3 Value', desc: 'Highest pts/$1K salary' },
  { icon: 'fist',          label: 'Top 3 Finish Path', desc: 'Highest R1/R2 finish upside (+90/+70 bonus)' },
  { icon: 'gem',           label: 'Hidden Gem', desc: 'Low ownership + high ceiling' },
  { icon: 'bomb',          label: 'Trap', desc: 'High ownership + low ceiling' },
  { icon: 'flame',         label: 'Top PP EV', desc: 'Best expected value vs PP line' },
  { icon: 'trending-down', label: 'Worst PP EV', desc: 'Strong LESS play' },
];
const GLOSSARY_NBA = [
  { icon: 'trophy',        label: 'Top 3 Value', desc: 'Highest pts/$1K salary' },
  { icon: 'rocket',        label: 'Top 3 Ceiling', desc: 'Highest 85th-percentile projection' },
  { icon: 'gem',           label: 'Hidden Gem', desc: 'Best value in salary band below biggest trap' },
  { icon: 'bomb',          label: 'Biggest Trap', desc: 'Highest sim-owned — field-converged chalk' },
  { icon: 'flame',         label: 'Top PP EV', desc: 'Best expected value vs PP line' },
  { icon: 'trending-down', label: 'Worst PP EV', desc: 'Strong LESS play' },
];

// ═══════════════════════════════════════════════════════════════════════
// CONTRARIAN LOGIC (shared across sports)
// ═══════════════════════════════════════════════════════════════════════
// Value-aware fair ownership: players with elite value deserve higher "fair" ownership.
// Elite value (ratio 1.5x) → fair_own = 20 x 1.25 = 25%
// Poor value (ratio 0.5x) → fair_own = 20 x 0.75 = 15%
// So chalky STUDS get minor fades (lobby needs them), chalky TRAPS get heavy fades.
function computeFairOwn(value, avgValue, baseline = 20) {
  if (!avgValue || avgValue <= 0) return baseline;
  const ratio = value / avgValue;
  const clamped = Math.max(-0.5, Math.min(0.5, ratio - 1));
  return baseline * (1 + 0.5 * clamped);
}

// Projection multiplier driven by ownership delta × value context.
// BIGGEST TRAP (high own + low value) → maximum fade.
// Chalky stud (high own + high value) → mild fade.
// Underowned value → moderate boost (not as aggressive as fade side — avoids flier-stacking).
// At strength=0.6, 12pt ownership overweight, val=0.8×avg: ~17% projection fade
// At strength=0.6, 12pt ownership overweight, val=1.4×avg: ~7% projection fade
// At strength=1.0 max: chalky trap gets up to ~30% fade
function applyContrarian(proj, ownership, strength, fairOwn = 20, value = null, avgValue = null) {
  if (!strength || ownership == null) return proj;
  const delta = fairOwn - ownership;                        // +ve = under-owned, -ve = over-owned
  const clampedDelta = Math.max(-40, Math.min(40, delta));

  // Asymmetric scaling: fade side is more aggressive than boost side
  const isOverowned = clampedDelta < 0;
  const baseScale = isOverowned ? 0.022 : 0.012;            // fade 2.2%/pt, boost 1.2%/pt

  // Value weighting on fade side only: amplify fade for poor-value chalk (true traps)
  let valueWeight = 1;
  if (isOverowned && value != null && avgValue > 0) {
    const valRatio = value / avgValue;
    valueWeight = Math.max(0.5, Math.min(1.5, 2 - valRatio));
    // valRatio=0.7 → valueWeight=1.3 (amp fade by 30%) — true trap
    // valRatio=1.0 → valueWeight=1.0 (neutral)
    // valRatio=1.4 → valueWeight=0.6 (dampen fade by 40%) — chalky stud
  }

  return proj * (1 + strength * clampedDelta * baseScale * valueWeight);
}

function ContrarianPanel({ enabled, onToggle, strength, onStrengthChange }) {
  return (
    <div style={{
      background: 'linear-gradient(135deg, rgba(245,197,24,0.08), rgba(245,197,24,0.02))',
      border: '1px solid rgba(245,197,24,0.3)', borderRadius: 10,
      padding: '14px 18px', marginBottom: 16,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: enabled ? 12 : 0 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--primary)' }}>
          <Icon name="swords" size={15} color="#F5C518"/> Contrarian Mode
          <span style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 500, marginLeft: 8 }}>
            (fade chalk, leverage dogs)
          </span>
        </div>
        <button onClick={() => onToggle(!enabled)} aria-label="Toggle Contrarian Mode" style={{
          width: 40, minWidth: 40, height: 22, minHeight: 22, maxHeight: 22,
          padding: 0, flexShrink: 0,
          background: enabled ? 'var(--primary)' : 'var(--border)',
          borderRadius: 11, position: 'relative', cursor: 'pointer', border: 'none',
          transition: 'background 0.15s',
        }}>
          <span style={{
            position: 'absolute', width: 18, height: 18,
            background: enabled ? '#0A1628' : 'var(--text-dim)',
            borderRadius: '50%', top: 2, left: enabled ? 20 : 2,
            transition: 'left 0.15s',
          }} />
        </button>
      </div>
      {enabled && (<>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <label style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Strength</label>
          <input type="range" min="0" max="100" value={Math.round(strength * 100)}
            onChange={e => onStrengthChange(+e.target.value / 100)}
            style={{ flex: 1, accentColor: 'var(--primary)' }} />
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--primary)', minWidth: 90, textAlign: 'right' }}>
            {Math.round(strength * 100)}% · −{Math.round(strength * 50)}pp
          </span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 8 }}>
          Trap is capped at <strong style={{ color: 'var(--text-muted)' }}>field_own − {Math.round(strength * 50)}pp</strong> (defaults to −30 at 60%, max −50 at 100%). Below-avg-value underowned plays get boosted for differentiation.
        </div>
      </>)}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// SLATE DATA HOOK — sport-aware
// ═══════════════════════════════════════════════════════════════════════
function useSlateData(sport, slateDate) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const hasLoadedRef = useRef(false);
  useEffect(() => {
    setData(null); setError(null);
    const startTime = Date.now();
    // First load: full splash (5000ms). Tennis/NBA switch: 2000ms so the
    // ball-bounce animation plays. UFC switch: 900ms (dots only).
    // Archive picks: 600ms (quick).
    const isArchive = slateDate && slateDate !== 'live';
    const MIN_LOAD_MS = !hasLoadedRef.current
      ? 5000
      : isArchive ? 600
      : (sport === 'tennis' || sport === 'nba') ? 2000
      : 900;
    const finalize = (cb) => {
      const elapsed = Date.now() - startTime;
      const delay = Math.max(0, MIN_LOAD_MS - elapsed);
      setTimeout(cb, delay);
    };
    // Live = current slate.json (root). Archive = /slates/{sport}/{date}.json
    const liveUrl = sport === 'mma' ? './slate-mma.json'
                  : sport === 'nba' ? './slate-nba.json'
                  : './slate.json';
    const url = isArchive ? `/slates/${sport}/${slateDate}.json` : liveUrl;
    fetch(url)
      .then(r => { if (!r.ok) throw new Error('No slate'); return r.json(); })
      .then(d => finalize(() => { hasLoadedRef.current = true; setData(d); }))
      .catch(e => finalize(() => setError(e.message)));
  }, [sport, slateDate]);
  return { data, error };
}

// Loads the list of archived slates from /slates/{sport}/manifest.json.
// Manifest shape: { slates: [{ date: "YYYY-MM-DD", label: "optional label" }, ...] }
function useSlateManifest(sport) {
  const [slates, setSlates] = useState([]);
  useEffect(() => {
    fetch(`/slates/${sport}/manifest.json`)
      .then(r => r.ok ? r.json() : { slates: [] })
      .then(m => setSlates(m.slates || []))
      .catch(() => setSlates([]));
  }, [sport]);
  return slates;
}

// ═══════════════════════════════════════════════════════════════════════
// TENNIS PROJECTION BUILDER — UNCHANGED from v5
// ═══════════════════════════════════════════════════════════════════════
function buildProjections(data) {
  if (!data || !data.matches || !data.dk_players) return { dkPlayers: [], ppRows: [] };
  const dkMap = {}; data.dk_players.forEach(p => { dkMap[p.name] = p; });
  const oppMap = {}; data.matches.forEach(m => { oppMap[m.player_a] = m.player_b; oppMap[m.player_b] = m.player_a; });
  const mtMap = {}; data.matches.forEach(m => { mtMap[m.player_a] = { time: m.start_time, t: m.tournament }; mtMap[m.player_b] = { time: m.start_time, t: m.tournament }; });
  const dkPlayers = [];
  data.matches.forEach(match => {
    const stats = processMatch(match);
    [['player_a', stats.player_a], ['player_b', stats.player_b]].forEach(([side, s]) => {
      const name = match[side]; const dk = dkMap[name]; if (!dk) return;
      const proj = dkProjection(s);
      const val = dk.salary > 0 ? Math.round(proj / (dk.salary / 1000) * 100) / 100 : 0;
      dkPlayers.push({ name, salary: dk.salary, id: dk.id, avgPPG: dk.avg_ppg, opponent: oppMap[name] || '', tournament: mtMap[name]?.t || '', startTime: mtMap[name]?.time || '', wp: s.wp, proj, val, pStraight: s.pStraightWin, p3set: s.p3set, gw: s.gw, gl: s.gl, sw: s.setsWon, sl: s.setsLost, aces: s.aces, dfs: s.dfs, breaks: s.breaks, p10ace: s.p10ace, pNoDF: s.pNoDF, ppProj: ppProjection(s), stats: s,
        // Showdown tiers — undefined for classic slates (harmless)
        cpt_id: dk.cpt_id, cpt_salary: dk.cpt_salary,
        acpt_id: dk.acpt_id, acpt_salary: dk.acpt_salary,
        flex_id: dk.flex_id, flex_salary: dk.flex_salary,
      });
    });
  });
  const ppRows = [];
  if (data.pp_lines) {
    data.pp_lines.forEach(line => {
      const player = dkPlayers.find(p => p.name === line.player);
      let projected = 0;
      if (!player) { ppRows.push({ player: line.player, stat: line.stat, line: line.line, projected: 0, ev: 0, opponent: '?', wp: 0, direction: '-', mult: line.mult || '' }); return; }
      if (line.stat === 'Fantasy Score') projected = player.ppProj;
      else if (line.stat === 'Breaks') projected = player.breaks;
      else if (line.stat === 'Games Won') projected = player.gw;
      else if (line.stat === 'Total Games') projected = player.gw + player.gl;
      else if (line.stat === 'Aces') projected = player.aces;
      else if (line.stat === 'Double Faults') projected = player.dfs;
      else if (line.stat === 'Sets Won') projected = player.sw;
      const ev = ppEV(projected, line.line);
      ppRows.push({ player: line.player, stat: line.stat, line: line.line, projected: Math.round(projected * 100) / 100, ev, opponent: player.opponent, wp: player.wp, direction: ev > 0 ? 'MORE' : ev < 0 ? 'LESS' : '-', mult: line.mult || '' });
    });
  }
  return { dkPlayers, ppRows };
}

// ═══════════════════════════════════════════════════════════════════════
// MMA PROJECTION BUILDER — NEW
// ═══════════════════════════════════════════════════════════════════════
function buildMMAProjections(data) {
  if (!data || !data.fights || !data.dk_players) return { dkPlayers: [], ppRows: [] };
  const dkMap = {}; data.dk_players.forEach(p => { dkMap[p.name] = p; });
  const dkPlayers = [];
  data.fights.forEach(fight => {
    const { fighter_a, fighter_b } = processFight(fight);
    const totalRoundsMax = (fight.rounds || 3) * 5;
    // Expected fight time from round distribution (midpoint of each round)
    const fightTime = Math.round((
      (fighter_a.pR1 + fighter_b.pR1) * 2.5 +
      (fighter_a.pR2 + fighter_b.pR2) * 7.5 +
      (fighter_a.pR3 + fighter_b.pR3) * 12.5 +
      (fighter_a.pR4 + fighter_b.pR4) * 17.5 +
      (fighter_a.pR5 + fighter_b.pR5) * 22.5 +
      (fighter_a.pDec + fighter_b.pDec) * totalRoundsMax
    ) * 100) / 100;

    [['fighter_a', fighter_a], ['fighter_b', fighter_b]].forEach(([side, s]) => {
      const name = fight[side];
      const opp = side === 'fighter_a' ? fight.fighter_b : fight.fighter_a;
      const dk = dkMap[name];
      if (!dk) return;
      const proj = dkMMAProjection(s);
      const ceil = dkMMACeiling(s);
      const val = dk.salary > 0 ? Math.round(proj / (dk.salary / 1000) * 100) / 100 : 0;
      const cval = dk.salary > 0 ? Math.round(ceil / (dk.salary / 1000) * 100) / 100 : 0;
      const finishProb = s.pKO + s.pSub;
      const finishUpside = s.pR1 * 90 + s.pR2 * 70;  // expected finish bonus
      const ppProj = ppMMAProjection(s);
      const ppCeil = ppMMACeiling(s);
      dkPlayers.push({
        name, salary: dk.salary, id: dk.id, avgPPG: dk.avg_ppg, opponent: opp,
        startTime: fight.start_time || '', rounds: fight.rounds || 3,
        wp: s.wp, proj, ceil, val, cval,
        pR1: s.pR1, pR2: s.pR2, pR3: s.pR3, pR4: s.pR4, pR5: s.pR5, pDec: s.pDec,
        pKO: s.pKO, pSub: s.pSub, finishProb, finishUpside,
        sigStr: s.sigStr, takedowns: s.takedowns, ctMin: s.ctSec / 60,
        knockdowns: s.knockdowns, subAttempts: s.subAttempts,
        ppProj, ppCeil, fightTime, stats: s,
        // Source tag — determines PP SS tab inclusion (only fighters with Bet365 O/U SS line)
        ssSource: side === 'fighter_a' ? fight.ss_source_a : fight.ss_source_b,
        // Combined fight-level round probabilities (needed for bimodal Fight Time edge)
        fightPR1: fighter_a.pR1 + fighter_b.pR1,
        fightPR2: fighter_a.pR2 + fighter_b.pR2,
        fightPR3: fighter_a.pR3 + fighter_b.pR3,
        fightPR4: fighter_a.pR4 + fighter_b.pR4,
        fightPR5: fighter_a.pR5 + fighter_b.pR5,
        fightPDec: fighter_a.pDec + fighter_b.pDec,
        fightMaxMin: (fight.rounds || 3) * 5,
      });
    });
  });

  // Helper: median fight time — where 50% of outcomes fall below
  // This is what PP uses to set lines (not mean, which is pulled up by decisions)
  function medianFightTime(p) {
    const rounds = [p.fightPR1, p.fightPR2, p.fightPR3, p.fightPR4, p.fightPR5];
    const maxRounds = p.fightMaxMin / 5;
    let cum = 0;
    for (let i = 0; i < maxRounds; i++) {
      const newCum = cum + rounds[i];
      if (newCum >= 0.5) {
        const frac = (0.5 - cum) / rounds[i];
        return Math.round((i * 5 + frac * 5) * 100) / 100;
      }
      cum = newCum;
    }
    // Decision dominates (finishes < 50%) → median is at decision time
    return p.fightMaxMin;
  }

  // Helper: P(fight time > line) computed from combined round distribution
  function pFightTimeOver(p, line) {
    const rounds = [p.fightPR1, p.fightPR2, p.fightPR3, p.fightPR4, p.fightPR5];
    let pOver = 0;
    for (let i = 0; i < 5; i++) {
      const rStart = i * 5, rEnd = (i + 1) * 5;
      if (rEnd > p.fightMaxMin) break;
      if (line >= rEnd) continue;
      if (line < rStart) pOver += rounds[i];
      else pOver += rounds[i] * (rEnd - line) / 5;
    }
    if (line < p.fightMaxMin) pOver += p.fightPDec;
    return Math.max(0, Math.min(1, pOver));
  }

  // Build PP rows
  const ppRows = [];
  if (data.pp_lines) {
    data.pp_lines.forEach(line => {
      const player = dkPlayers.find(p => p.name === line.player);
      if (!player) { ppRows.push({ player: line.player, stat: line.stat, line: line.line, projected: 0, ev: 0, opponent: '?', wp: 0, direction: '-', mult: line.mult || '' }); return; }
      let projected = 0, ev = 0, direction = '-';
      if (line.stat === 'Significant Strikes') {
        // NEW RULE: only include PP SS rows for fighters with Bet365 direct O/U line.
        // Without Bet365 data, projection would equal PP line → no edge → drop.
        if (player.ssSource !== 'bet365') return;
        projected = player.sigStr;
        ev = Math.round((projected - line.line) * 100) / 100;
        direction = ev > 0 ? 'MORE' : ev < 0 ? 'LESS' : '-';
      } else if (line.stat === 'Fantasy Score') {
        projected = player.ppProj;
        ev = Math.round((projected - line.line) * 100) / 100;
        direction = ev > 0 ? 'MORE' : ev < 0 ? 'LESS' : '-';
      } else if (line.stat === 'Fight Time') {
        // Projected = MEDIAN fight time (where 50% of outcomes land below)
        // PP sets their lines at median, not mean — mean gets pulled up by decisions
        projected = medianFightTime(player);
        ev = Math.round((projected - line.line) * 100) / 100;
        direction = ev > 0 ? 'MORE' : ev < 0 ? 'LESS' : '-';
      } else if (line.stat === 'Takedowns') {
        projected = player.takedowns;
        ev = Math.round((projected - line.line) * 100) / 100;
        direction = ev > 0 ? 'MORE' : ev < 0 ? 'LESS' : '-';
      } else if (line.stat === 'Control Time') {
        projected = player.ctMin;
        ev = Math.round((projected - line.line) * 100) / 100;
        direction = ev > 0 ? 'MORE' : ev < 0 ? 'LESS' : '-';
      }
      ppRows.push({ player: line.player, stat: line.stat, line: line.line, projected: Math.round(projected * 100) / 100, ev, opponent: player.opponent, wp: player.wp, direction, mult: line.mult || '' });
    });
  }
  return { dkPlayers, ppRows };
}

// ═══════════════════════════════════════════════════════════════════════
// OWNERSHIP SIMULATORS
// ═══════════════════════════════════════════════════════════════════════
// Tennis ownership sim — exposure from top 1500 highest-scoring lineups.
// For showdown, also tracks captain-specific ownership (some players chalky
// as CPT but rare as FLEX, e.g. low-salary dogs optimizers love to captain).
// Returns { overall, cpt }.
function simulateOwnership(players, n = 1500) {
  const isShowdown = players.some(p => p.salary > 0 && p.cpt_salary != null);
  if (isShowdown) {
    const pData = players.filter(p => p.salary > 0).map(p => ({
      name: p.name, projection: p.proj, opponent: p.opponent,
      cpt_salary: p.cpt_salary, acpt_salary: p.acpt_salary, flex_salary: p.flex_salary,
      cpt_id: p.cpt_id, acpt_id: p.acpt_id, flex_id: p.flex_id,
      maxExp: 100, minExp: 0,
    }));
    try {
      const res = optimizeShowdown(pData, n, 50000, 48000);
      const overall = {}, cpt = {};
      pData.forEach((p, i) => {
        overall[p.name] = res.lineups.length ? res.counts[i] / res.lineups.length * 100 : 0;
        cpt[p.name] = res.lineups.length ? (res.cptCounts?.[i] || 0) / res.lineups.length * 100 : 0;
      });
      return { overall, cpt };
    } catch { return { overall: {}, cpt: {} }; }
  }
  const pData = players.filter(p => p.salary > 0).map(p => ({
    name: p.name, salary: p.salary, id: p.id, projection: p.proj,
    opponent: p.opponent, maxExp: 100, minExp: 0,
  }));
  try {
    const res = optimize(pData, n, 50000, 6, 48000);
    const overall = {};
    pData.forEach((p, i) => { overall[p.name] = res.counts[i] / res.lineups.length * 100; });
    return { overall, cpt: {} };
  } catch { return { overall: {}, cpt: {} }; }
}

function simulateMMAOwnership(fighters, n = 1500) {
  const pData = fighters.filter(f => f.salary > 0).map(f => ({
    name: f.name, salary: f.salary, id: f.id,
    projection: f.proj, ceiling: f.ceil,
    opponent: f.opponent, maxExp: 100, minExp: 0
  }));
  try {
    const res = optimizeMMA(pData, n, 50000, 6, "median", 48000);
    const overall = {};
    pData.forEach((p, i) => { overall[p.name] = res.counts[i] / res.lineups.length * 100; });
    return { overall, cpt: {} };
  } catch { return { overall: {}, cpt: {} }; }
}

// ═══════════════════════════════════════════════════════════════════════
// NBA PROJECTION BUILDER
// Pure DraftKings prop devig — no minute/pace/blowout/cascade scaling.
// Players without a DK Points line are marked unprojectable and excluded
// from the builder pool.
// ═══════════════════════════════════════════════════════════════════════
function buildNBAProjections(data) {
  if (!data || !data.dk_players) return { dkPlayers: [], ppRows: [] };
  const game = data.game || {};

  const dkPlayers = data.dk_players.map(p => {
    const stats = nbaBuildPlayerStats(p);   // context-free
    const proj = stats.projectable ? nbaDkProjection(stats) : 0;
    const ceil = stats.projectable ? nbaDkCeiling(stats) : 0;
    const ppProj = stats.projectable ? nbaPpProjection(stats) : 0;
    const sal = p.util_salary || p.salary || 0;
    const val  = stats.projectable && sal > 0 ? Math.round(proj / (sal / 1000) * 100) / 100 : 0;
    const cval = stats.projectable && sal > 0 ? Math.round(ceil / (sal / 1000) * 100) / 100 : 0;
    // Count how many of the 5 core stats we actually have DK lines for.
    const hasData = stats.hasStatData || {};
    const statCoverage = ['points', 'rebounds', 'assists', 'threes', 'stls_blks']
      .filter(k => hasData[k]).length;
    return {
      name: p.name,
      team: p.team,
      opponent: p.opponent || (p.team === game.home ? game.away : game.home),
      positions: p.positions || [],
      positions_str: p.positions_str || (p.positions || []).join('/'),
      salary: sal,
      id: p.util_id || p.id,
      util_id: p.util_id, util_salary: p.util_salary,
      cpt_id: p.cpt_id,   cpt_salary: p.cpt_salary,
      avgPPG: p.avg_ppg || 0,
      proj, ceil, val, cval, ppProj,
      projMins: stats.projMins,      // informational only
      projectable: stats.projectable,
      statCoverage,                   // 0–5
      hasStatData: hasData,
      status: stats.status,
      stats,
      startTime: game.tip || '',
    };
  });

  // PP rows — ONLY PP Fantasy Score. PrizePicks' individual Points / Rebounds /
  // Assists / 3PM / Stls+Blks lines are intentionally NOT shown here: that
  // would be comparing the devigged DK line for stat X against the PP line
  // for stat X, which is a comparison of two bookmakers' lines. The PP tab's
  // purpose is to surface PP Fantasy Score vs our devigged DK-derived PP
  // Fantasy Score projection, and report edge.
  const ppRows = [];
  if (data.pp_lines) {
    const byName = {}; dkPlayers.forEach(p => { byName[p.name] = p; });
    data.pp_lines.forEach(line => {
      if (line.stat !== 'Fantasy Score') return;
      const player = byName[line.player];
      if (!player || !player.projectable) return;
      const projected = Math.round(nbaPpProjection(player.stats) * 100) / 100;
      const ev = nbaPpEV(projected, line.line);
      ppRows.push({
        player: line.player, stat: 'Fantasy Score', line: line.line,
        projected, ev,
        opponent: player.opponent, team: player.team,
        direction: ev > 0.8 ? 'MORE' : ev < -0.8 ? 'LESS' : '-',
        mult: line.mult || 'normal',
      });
    });
  }
  return { dkPlayers, ppRows };
}

// ═══════════════════════════════════════════════════════════════════════
// NBA OWNERSHIP SIM — exposure from top 1500 highest-scoring lineups
// (top-N enumeration by DK Fantasy Score, NOT weighted random field sim).
// Returns { overall, cpt } where:
//   overall[name] = % of top-1500 lineups containing the player in ANY slot
//   cpt[name]     = % of top-1500 lineups where the player is captain
// ═══════════════════════════════════════════════════════════════════════
function simulateNBAOwnership(players, slateType = 'showdown') {
  const active = players.filter(p =>
    p.salary > 0 &&
    p.projectable !== false &&
    (p.status || 'ACTIVE').toUpperCase() !== 'OUT'
  );
  if (active.length < 6) return { overall: {}, cpt: {} };

  const pData = active.map(p => ({
    name: p.name, team: p.team, projection: p.proj,
    util_salary: p.util_salary || p.salary, cpt_salary: p.cpt_salary,
    util_id: p.util_id || p.id, cpt_id: p.cpt_id,
    positions: p.positions || [], salary: p.util_salary || p.salary,
    status: p.status,
  }));

  try {
    if (slateType === 'classic') {
      const res = nbaOptimizeClassic(pData, 1500, 50000, 48000);
      const overall = {};
      if (!res.lineups.length) return { overall, cpt: {} };
      pData.forEach((p, i) => { overall[p.name] = res.counts[i] / res.lineups.length * 100; });
      return { overall, cpt: {} };
    }
    // Showdown — top 1500 highest-scoring lineups by DK Fantasy projection
    const res = nbaOptimizeShowdown(pData, 1500, 50000, 48000);
    const overall = {}, cpt = {};
    if (!res.lineups.length) return { overall, cpt };
    pData.forEach((p, i) => {
      overall[p.name] = res.counts[i] / res.lineups.length * 100;
      cpt[p.name] = (res.cptCounts?.[i] || 0) / res.lineups.length * 100;
    });
    return { overall, cpt };
  } catch (e) {
    console.error('simulateNBAOwnership error:', e);
    return { overall: {}, cpt: {} };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SHARED HELPERS — UNCHANGED
// ═══════════════════════════════════════════════════════════════════════
function useSort(data, dk = 'val', dd = 'desc') {
  const [sk, setSk] = useState(dk); const [sd, setSd] = useState(dd);
  const sorted = useMemo(() => { const a = [...data]; a.sort((x, y) => { let va = x[sk], vb = y[sk]; if (typeof va === 'string') { va = va.toLowerCase(); vb = (vb||'').toLowerCase(); } if (va < vb) return sd === 'asc' ? -1 : 1; if (va > vb) return sd === 'asc' ? 1 : -1; return 0; }); return a; }, [data, sk, sd]);
  const toggle = useCallback(k => { if (k === sk) setSd(d => d === 'asc' ? 'desc' : 'asc'); else { setSk(k); setSd('desc'); } }, [sk]);
  return { sorted, sortKey: sk, sortDir: sd, toggleSort: toggle };
}
function SH({ label, colKey, sortKey, sortDir, onSort }) { const a = colKey === sortKey; return <th className={a ? 'sorted' : ''} onClick={() => onSort(colKey)}>{label}{a && <span className="sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>}</th>; }
const fmt = (n, d = 1) => typeof n === 'number' ? n.toFixed(d) : '-';
const fmtPct = n => typeof n === 'number' ? (n * 100).toFixed(0) + '%' : '-';
const fmtSal = n => '$' + n.toLocaleString();
const fmtTime = s => { if (!s) return '-'; const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(AM|PM)/i); if (m) { let h = parseInt(m[4]); const ap = m[6].toUpperCase(); if (ap === 'PM' && h !== 12) h += 12; if (ap === 'AM' && h === 12) h = 0; return (h > 12 ? h - 12 : h || 12) + ':' + m[5] + ' ' + ap; } try { const d = new Date(s); if (!isNaN(d)) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch {} return s; };
function Icon({ name, size = 14, color, style, className }) {
  const commonStyle = { width: size, height: size, flexShrink: 0, verticalAlign: '-0.15em', display: 'inline-block', ...style };
  const p = { viewBox: '0 0 24 24', fill: 'none', stroke: color || 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round', style: commonStyle, className };
  switch (name) {
    case 'warning':        return <svg {...p}><path d="M12 3l10 18H2L12 3z"/><path d="M12 10v5"/><circle cx="12" cy="18.5" r="0.7" fill={color || 'currentColor'} stroke="none"/></svg>;
    case 'trophy':         return <svg {...p}><path d="M7 4h10v4a5 5 0 0 1-10 0V4z"/><path d="M7 6H4a2 2 0 0 0 0 4h3"/><path d="M17 6h3a2 2 0 0 1 0 4h-3"/><path d="M12 13v4"/><path d="M8 21h8"/></svg>;
    case 'target':         return <svg {...p}><circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/></svg>;
    case 'gem':            return <svg {...p}><path d="M6 3h12l3 6-9 12L3 9z"/><path d="M3 9h18"/><path d="M9 3l3 6 3-6"/></svg>;
    case 'bomb':           return <svg {...p}><circle cx="10" cy="14" r="7"/><path d="M14 8l3-3"/><path d="M18 3h3M19.5 1.5v3"/></svg>;
    case 'flame':          return <svg {...p}><path d="M13 2C13 5 14 7 15 8C15 6 16 5 16 5C18 7 19 11 19 14A7 7 0 0 1 5 14C5 11 7 10 8 9C9 10 10 11 10 10C10 7 11 5 13 2Z"/><path d="M12 13C11 14 10 15 10 17A2.5 2.5 0 0 0 15 17C15 15 14 14 12 13Z"/></svg>;
    case 'trending-down':  return <svg {...p}><path d="M2 7l6.5 6.5 5-5 8.5 8.5"/><path d="M16 17h6v-6"/></svg>;
    case 'fist':           return <svg {...p}><path d="M9 4h5a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3z"/><path d="M5 10a1.5 1.5 0 0 0 0 3"/><path d="M8 17v3h6v-3"/></svg>;
    case 'swords':         return <svg {...p}><path d="M7 6l6 6-6 6"/><path d="M17 6l-6 6 6 6"/></svg>;
    case 'bolt':           return <svg {...p} fill={color || 'currentColor'} stroke="none"><path d="M13 2L4 14h7l-1 8 10-12h-7l1-8z"/></svg>;
    case 'link':           return <svg {...p}><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>;
    case 'download':       return <svg {...p}><path d="M12 4v12"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/></svg>;
    case 'check':          return <svg {...p}><path d="M5 12l5 5 9-10"/></svg>;
    case 'chart':          return <svg {...p}><path d="M3 3v18h18"/><rect x="7" y="10" width="3" height="8"/><rect x="13" y="6" width="3" height="12"/><rect x="19" y="13" width="2" height="5"/></svg>;
    case 'refresh':        return <svg {...p}><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>;
    case 'dollar':         return <svg {...p}><path d="M12 3v18"/><path d="M17 7h-6a3 3 0 0 0 0 6h2a3 3 0 0 1 0 6H6"/></svg>;
    case 'rocket':         return <svg {...p}><path d="M12 3c3 2 5 5 5 9v6l-5-3-5 3v-6c0-4 2-7 5-9z"/><circle cx="12" cy="10" r="1.5"/><path d="M7 17l-3 4M17 17l3 4"/></svg>;
    case 'tennis':         return <svg {...p}><circle cx="12" cy="12" r="9"/><path d="M5 6c3 3 3 9 0 12"/><path d="M19 6c-3 3-3 9 0 12"/></svg>;
    case 'basketball':     return <svg {...p}><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a9 9 0 0 1 0 18"/><path d="M5.5 5.5c3 2 3 11 0 13"/><path d="M18.5 5.5c-3 2-3 11 0 13"/></svg>;
    case 'chart-line':     return <svg {...p}><path d="M3 3v18h18"/><path d="M7 15l4-5 4 3 6-8"/></svg>;
    default: return null;
  }
}
function Tip({ icon, emoji, label, size = 14 }) {
  const [s, setS] = useState(false);
  return <span style={{ position: 'relative', cursor: 'help', display: 'inline-flex', alignItems: 'center' }} onMouseEnter={() => setS(true)} onMouseLeave={() => setS(false)}>{icon ? <Icon name={icon} size={size}/> : emoji}{s && <span style={{ position: 'absolute', bottom: '120%', left: '50%', transform: 'translateX(-50%)', background: '#1E2433', border: '1px solid #2A3040', borderRadius: 6, padding: '6px 10px', fontSize: 11, color: '#E2E8F0', whiteSpace: 'nowrap', zIndex: 999, fontWeight: 500 }}>{label}</span>}</span>;
}

// ═══════════════════════════════════════════════════════════════════════
// SPLASH SCREEN — cinematic first-load brand intro
// ═══════════════════════════════════════════════════════════════════════
function SplashScreen({ sport }) {
  const isTennis = sport === 'tennis';
  const isNba = sport === 'nba';
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'radial-gradient(ellipse at 50% 40%, #0F1D35 0%, #0A1628 40%, #060F1F 100%)', zIndex: 999, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px 20px', overflow: 'hidden' }}>
      <style>{`
        @keyframes oo-logo-enter  { 0% { opacity: 0; transform: scale(0.55); filter: blur(8px); } 60% { opacity: 1; filter: blur(0); } 100% { opacity: 1; transform: scale(1); filter: blur(0); } }
        @keyframes oo-halo-burst  { 0% { opacity: 0; transform: scale(0.6); } 50% { opacity: 1; transform: scale(1.15); } 100% { opacity: 0.65; transform: scale(1); } }
        @keyframes oo-halo-pulse  { 0%, 100% { opacity: 0.5; transform: scale(1); } 50% { opacity: 0.8; transform: scale(1.08); } }
        @keyframes oo-ring-fade   { to { opacity: 1; } }
        @keyframes oo-ring-spin   { to { transform: rotate(360deg); } }
        @keyframes oo-breathe     { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.04); } }
        @keyframes oo-fade-up     { to { opacity: 1; transform: translateY(0); } }
        @keyframes oo-fade-in     { to { opacity: 1; } }
        @keyframes oo-preserve    { 0%, 100% { transform: translateY(0) scaleX(1.18) scaleY(0.82); } 10% { transform: translateY(-8px) scaleX(1.04) scaleY(0.96); } 50% { transform: translateY(-58px) scaleX(0.95) scaleY(1.05); } 90% { transform: translateY(-8px) scaleX(1.04) scaleY(0.96); } }
        @keyframes oo-shadow-beat { 0%, 100% { opacity: 0.65; transform: translateX(-50%) scaleX(1); } 50% { opacity: 0.18; transform: translateX(-50%) scaleX(0.5); } }
        @keyframes oo-dot-blink   { 0%, 100% { opacity: 0.2; } 50% { opacity: 1; } }
        @keyframes oo-drift       { 0%, 100% { opacity: 0; transform: translateY(0); } 25% { opacity: 0.8; } 50% { transform: translateY(-20px); opacity: 0.4; } 75% { opacity: 0.7; } }
      `}</style>

      {/* Drifting particles */}
      {[{t:'20%',l:'15%',d:'0.5s',dur:'8s'},{t:'30%',l:'85%',d:'1.2s',dur:'7s'},{t:'65%',l:'10%',d:'0.8s',dur:'9s'},{t:'75%',l:'78%',d:'2s',dur:'6s'},{t:'45%',l:'92%',d:'1.5s',dur:'7.5s'},{t:'55%',l:'5%',d:'0.3s',dur:'8.5s'}].map((p, i) => (
        <div key={i} style={{ position: 'absolute', top: p.t, left: p.l, width: 2, height: 2, borderRadius: '50%', background: '#F5C518', opacity: 0, boxShadow: '0 0 4px #F5C518', animation: `oo-drift ${p.dur} ease-in-out ${p.d} infinite` }} />
      ))}

      {/* Logo with halo + rotating ring */}
      <div style={{ position: 'relative', width: 140, height: 140, marginBottom: 32, opacity: 0, transform: 'scale(0.55)', animation: 'oo-logo-enter 1.1s cubic-bezier(0.34, 1.35, 0.64, 1) 0.25s forwards' }}>
        <div style={{ position: 'absolute', inset: -40, borderRadius: '50%', background: 'radial-gradient(circle, rgba(245,197,24,0.5) 0%, rgba(245,197,24,0.15) 40%, transparent 70%)', opacity: 0, animation: 'oo-halo-burst 1.4s ease-out 0.35s forwards, oo-halo-pulse 3.2s ease-in-out 1.7s infinite' }} />
        <div style={{ position: 'absolute', inset: -8, border: '1px solid rgba(245,197,24,0.25)', borderTopColor: '#F5C518', borderRadius: '50%', opacity: 0, animation: 'oo-ring-fade 0.6s ease-out 0.9s forwards, oo-ring-spin 4s linear 0.9s infinite' }} />
        <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ position: 'relative', width: '100%', height: '100%', filter: 'drop-shadow(0 8px 32px rgba(245,197,24,0.35))', animation: 'oo-breathe 3.2s ease-in-out 1.7s infinite' }}>
          <circle cx="50" cy="50" r="38" fill="none" stroke="#F5C518" strokeWidth="14"/>
          <path d="M 30 64 L 45 40 L 54 52 L 63 40 L 70 64 Z" fill="#F5C518"/>
          <circle cx="45" cy="40" r="1.8" fill="#FFFFFF"/>
        </svg>
      </div>

      {/* Wordmark */}
      <div style={{ fontFamily: "'Inter', sans-serif", fontWeight: 800, fontSize: 48, letterSpacing: '-0.03em', color: '#F8FAFC', marginBottom: 20, opacity: 0, transform: 'translateY(12px)', animation: 'oo-fade-up 0.9s cubic-bezier(0.2, 0.8, 0.2, 1) 0.95s forwards' }}>
        Over<span style={{ color: '#F5C518', display: 'inline-block', textShadow: '0 0 20px rgba(245,197,24,0.4)' }}>O</span>wned
      </div>

      {/* Tennis ball pre-serve bounce — scaled up to sit with the wordmark */}
      {isTennis && (
        <div style={{ position: 'relative', width: 140, height: 100, marginBottom: 24, opacity: 0, animation: 'oo-fade-in 0.6s ease-out 1.4s forwards' }}>
          <div style={{ position: 'absolute', bottom: 0, left: '50%', transform: 'translateX(-50%)', width: 100, height: 2, background: 'linear-gradient(90deg, transparent 0%, rgba(245,197,24,0.55) 50%, transparent 100%)' }} />
          <div style={{ position: 'absolute', bottom: 2, left: '50%', marginLeft: -20, width: 40, height: 40 }}>
            <div style={{ position: 'absolute', bottom: -4, left: '50%', width: 34, height: 6, background: 'rgba(0,0,0,0.6)', borderRadius: '50%', filter: 'blur(2.5px)', transform: 'translateX(-50%)', animation: 'oo-shadow-beat 1.4s cubic-bezier(0.5, 0, 0.5, 1) 1.6s infinite' }} />
            <div style={{ transformOrigin: '50% 100%', animation: 'oo-preserve 1.4s cubic-bezier(0.5, 0, 0.5, 1) 1.6s infinite' }}>
              <svg width="40" height="40" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
                <defs>
                  <radialGradient id="ballGrad" cx="0.35" cy="0.3" r="0.75">
                    <stop offset="0%" stopColor="#F0FF7A"/>
                    <stop offset="60%" stopColor="#DDFF4F"/>
                    <stop offset="100%" stopColor="#B8D438"/>
                  </radialGradient>
                </defs>
                <circle cx="20" cy="20" r="18" fill="url(#ballGrad)" stroke="#8BA132" strokeWidth="0.6"/>
                <path d="M 3 20 C 9 13, 15 13, 20 20 C 25 27, 31 27, 37 20" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            </div>
          </div>
        </div>
      )}
      {isNba && (
        <div style={{ position: 'relative', width: 140, height: 100, marginBottom: 24, opacity: 0, animation: 'oo-fade-in 0.6s ease-out 1.4s forwards' }}>
          <div style={{ position: 'absolute', bottom: 0, left: '50%', transform: 'translateX(-50%)', width: 100, height: 2, background: 'linear-gradient(90deg, transparent 0%, rgba(245,197,24,0.55) 50%, transparent 100%)' }} />
          <div style={{ position: 'absolute', bottom: 2, left: '50%', marginLeft: -20, width: 40, height: 40 }}>
            <div style={{ position: 'absolute', bottom: -4, left: '50%', width: 34, height: 6, background: 'rgba(0,0,0,0.6)', borderRadius: '50%', filter: 'blur(2.5px)', transform: 'translateX(-50%)', animation: 'oo-shadow-beat 1.4s cubic-bezier(0.5, 0, 0.5, 1) 1.6s infinite' }} />
            <div style={{ transformOrigin: '50% 100%', animation: 'oo-preserve 1.4s cubic-bezier(0.5, 0, 0.5, 1) 1.6s infinite' }}>
              <svg width="40" height="40" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
                <defs>
                  <radialGradient id="bballSplash" cx="0.35" cy="0.3" r="0.8">
                    <stop offset="0%" stopColor="#FFB672"/>
                    <stop offset="55%" stopColor="#E8722C"/>
                    <stop offset="100%" stopColor="#A74712"/>
                  </radialGradient>
                </defs>
                <circle cx="20" cy="20" r="18" fill="url(#bballSplash)" stroke="#5C2A0A" strokeWidth="0.8"/>
                <path d="M 2 20 H 38" fill="none" stroke="rgba(0,0,0,0.6)" strokeWidth="1.4" strokeLinecap="round"/>
                <path d="M 20 2 V 38" fill="none" stroke="rgba(0,0,0,0.6)" strokeWidth="1.4" strokeLinecap="round"/>
                <path d="M 6.5 6.5 Q 20 20 6.5 33.5" fill="none" stroke="rgba(0,0,0,0.5)" strokeWidth="1.3" strokeLinecap="round"/>
                <path d="M 33.5 6.5 Q 20 20 33.5 33.5" fill="none" stroke="rgba(0,0,0,0.5)" strokeWidth="1.3" strokeLinecap="round"/>
              </svg>
            </div>
          </div>
        </div>
      )}
      {!isTennis && !isNba && (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 20, opacity: 0, animation: 'oo-fade-in 0.6s ease-out 1.4s forwards' }}>
          {[0, 1, 2].map(i => <div key={i} style={{ width: 10, height: 10, borderRadius: '50%', background: '#F5C518', animation: `oo-dot-blink 1.2s ease-in-out ${i * 0.18}s infinite` }} />)}
        </div>
      )}

      {/* Vignette */}
      <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.6) 100%)', pointerEvents: 'none' }} />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// SPORT SWITCH LOADER — simple, clean, quick (used after first load)
// ═══════════════════════════════════════════════════════════════════════
function SportSwitchLoader({ sport }) {
  const isTennis = sport === 'tennis';
  const isNba = sport === 'nba';
  const label = isTennis ? 'Tennis' : isNba ? 'NBA' : 'UFC';
  const iconName = isTennis ? 'tennis' : isNba ? 'basketball' : 'fist';
  return (
    <div style={{ padding: '80px 20px 60px', textAlign: 'center' }}>
      <style>{`
        @keyframes sw-fade      { 0% { opacity: 0; transform: translateY(6px); } 100% { opacity: 1; transform: translateY(0); } }
        @keyframes sw-preserve  { 0%, 100% { transform: translateY(0) scaleX(1.18) scaleY(0.82); } 10% { transform: translateY(-8px) scaleX(1.04) scaleY(0.96); } 50% { transform: translateY(-44px) scaleX(0.95) scaleY(1.05); } 90% { transform: translateY(-8px) scaleX(1.04) scaleY(0.96); } }
        @keyframes sw-shadow    { 0%, 100% { opacity: 0.5; transform: translateX(-50%) scaleX(1); } 50% { opacity: 0.15; transform: translateX(-50%) scaleX(0.4); } }
        @keyframes sw-dot       { 0%, 100% { opacity: 0.2; } 50% { opacity: 1; } }
        @keyframes sw-spin      { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
      <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 15, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 24, opacity: 0, animation: 'sw-fade 0.4s ease-out 0.1s forwards' }}>
        Switching to {label} <Icon name={iconName} size={16} color="#F5C518"/>
      </div>
      {isTennis && (
        <div style={{ position: 'relative', width: 100, height: 70, margin: '0 auto 20px', opacity: 0, animation: 'sw-fade 0.4s ease-out 0.2s forwards' }}>
          <div style={{ position: 'absolute', bottom: 0, left: '50%', transform: 'translateX(-50%)', width: 64, height: 2, background: 'linear-gradient(90deg, transparent, rgba(245,197,24,0.5), transparent)' }} />
          <div style={{ position: 'absolute', bottom: 2, left: '50%', marginLeft: -14, width: 28, height: 28 }}>
            <div style={{ position: 'absolute', bottom: -3, left: '50%', width: 22, height: 4, background: 'rgba(0,0,0,0.55)', borderRadius: '50%', filter: 'blur(2px)', transform: 'translateX(-50%)', animation: 'sw-shadow 1.3s cubic-bezier(0.5, 0, 0.5, 1) infinite' }} />
            <div style={{ transformOrigin: '50% 100%', animation: 'sw-preserve 1.3s cubic-bezier(0.5, 0, 0.5, 1) infinite' }}>
              <svg width="28" height="28" viewBox="0 0 40 40">
                <circle cx="20" cy="20" r="18" fill="#DDFF4F" stroke="#95A835" strokeWidth="0.8" />
                <path d="M 3 20 C 9 13, 15 13, 20 20 C 25 27, 31 27, 37 20" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </div>
          </div>
        </div>
      )}
      {isNba && (
        <div style={{ position: 'relative', width: 100, height: 70, margin: '0 auto 20px', opacity: 0, animation: 'sw-fade 0.4s ease-out 0.2s forwards' }}>
          <div style={{ position: 'absolute', bottom: 0, left: '50%', transform: 'translateX(-50%)', width: 64, height: 2, background: 'linear-gradient(90deg, transparent, rgba(245,197,24,0.5), transparent)' }} />
          <div style={{ position: 'absolute', bottom: 2, left: '50%', marginLeft: -14, width: 28, height: 28 }}>
            <div style={{ position: 'absolute', bottom: -3, left: '50%', width: 22, height: 4, background: 'rgba(0,0,0,0.55)', borderRadius: '50%', filter: 'blur(2px)', transform: 'translateX(-50%)', animation: 'sw-shadow 1.3s cubic-bezier(0.5, 0, 0.5, 1) infinite' }} />
            <div style={{ transformOrigin: '50% 100%', animation: 'sw-preserve 1.3s cubic-bezier(0.5, 0, 0.5, 1) infinite' }}>
              <svg width="28" height="28" viewBox="0 0 40 40">
                <defs>
                  <radialGradient id="bballSw" cx="0.35" cy="0.3" r="0.8">
                    <stop offset="0%" stopColor="#FFA05E"/>
                    <stop offset="55%" stopColor="#E8722C"/>
                    <stop offset="100%" stopColor="#A74712"/>
                  </radialGradient>
                </defs>
                <circle cx="20" cy="20" r="18" fill="url(#bballSw)" stroke="#5C2A0A" strokeWidth="0.8" />
                <path d="M 2 20 H 38" fill="none" stroke="rgba(0,0,0,0.55)" strokeWidth="1.3" strokeLinecap="round" />
                <path d="M 20 2 V 38" fill="none" stroke="rgba(0,0,0,0.55)" strokeWidth="1.3" strokeLinecap="round" />
                <path d="M 6.5 6.5 Q 20 20 6.5 33.5" fill="none" stroke="rgba(0,0,0,0.45)" strokeWidth="1.2" strokeLinecap="round" />
                <path d="M 33.5 6.5 Q 20 20 33.5 33.5" fill="none" stroke="rgba(0,0,0,0.45)" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </div>
          </div>
        </div>
      )}
      {!isTennis && !isNba && (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 20, opacity: 0, animation: 'sw-fade 0.4s ease-out 0.2s forwards' }}>
          {[0, 1, 2].map(i => <div key={i} style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--primary)', animation: `sw-dot 1.2s ease-in-out ${i * 0.15}s infinite` }} />)}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN APP — adds sport toggle on top of existing structure
// ═══════════════════════════════════════════════════════════════════════
export default function App() {
  const [sport, setSport] = useState('tennis');
  const [slateDate, setSlateDate] = useState('live'); // 'live' or YYYY-MM-DD
  const { data, error } = useSlateData(sport, slateDate);
  const manifestSlates = useSlateManifest(sport);
  const [tab, setTab] = useState('dk');
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  // Reset to live when sport changes so user isn't stuck on a date that may not exist in new sport
  useEffect(() => { setSlateDate('live'); }, [sport]);
  // Projection overrides: user-entered projection values keyed by player name. Reset when slate/sport swaps.
  const [projOverrides, setProjOverrides] = useState({});
  useEffect(() => { setProjOverrides({}); }, [sport, data]);
  const onOverrideProj = useCallback((name, value) => {
    setProjOverrides(prev => {
      if (value === '' || value == null || isNaN(+value)) {
        const next = { ...prev }; delete next[name]; return next;
      }
      return { ...prev, [name]: +value };
    });
  }, []);
  // Cursor-tracking gold glow: follows mouse, rendered via CSS custom properties on <body>.
  // Throttled via rAF so mousemove doesn't thrash layout.
  useEffect(() => {
    let raf = 0;
    const onMove = (e) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        document.body.style.setProperty('--mx', `${e.clientX}px`);
        document.body.style.setProperty('--my', `${e.clientY}px`);
        raf = 0;
      });
    };
    window.addEventListener('mousemove', onMove);
    return () => { window.removeEventListener('mousemove', onMove); if (raf) cancelAnimationFrame(raf); };
  }, []);
  useEffect(() => { if (data) setHasLoadedOnce(true); }, [data]);
  // Preload Instrument Serif (for the splash tagline) — runs once
  useEffect(() => {
    if (document.querySelector('link[href*="Instrument+Serif"]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&display=swap';
    document.head.appendChild(link);
  }, []);

  const tennisProjections = useMemo(() => {
    if (sport !== 'tennis' || !data || !data.matches) return { dkPlayers: [], ppRows: [] };
    try { return buildProjections(data); }
    catch (e) { console.error('buildProjections error:', e); return { dkPlayers: [], ppRows: [], buildError: e.message }; }
  }, [sport, data]);
  const mmaProjections = useMemo(() => {
    if (sport !== 'mma' || !data || !data.fights) return { dkPlayers: [], ppRows: [] };
    try { return buildMMAProjections(data); }
    catch (e) { console.error('buildMMAProjections error:', e); return { dkPlayers: [], ppRows: [], buildError: e.message }; }
  }, [sport, data]);
  const nbaProjections = useMemo(() => {
    if (sport !== 'nba' || !data || !data.dk_players) return { dkPlayers: [], ppRows: [] };
    try { return buildNBAProjections(data); }
    catch (e) { console.error('buildNBAProjections error:', e); return { dkPlayers: [], ppRows: [], buildError: e.message }; }
  }, [sport, data]);
  const { dkPlayers: rawDkPlayers, ppRows, buildError } =
    sport === 'tennis' ? tennisProjections
    : sport === 'mma' ? mmaProjections
    : nbaProjections;
  // Apply user projection overrides. For MMA, scale ceiling proportionally so proj:ceil ratio stays sane.
  // Value/cval are recomputed against salary so they reflect the new proj.
  const dkPlayers = useMemo(() => {
    if (!rawDkPlayers.length || Object.keys(projOverrides).length === 0) return rawDkPlayers;
    return rawDkPlayers.map(p => {
      const ov = projOverrides[p.name];
      if (ov == null) return p;
      const mult = p.proj > 0 ? ov / p.proj : 1;
      const newVal = p.salary > 0 ? Math.round(ov / (p.salary / 1000) * 100) / 100 : 0;
      const out = { ...p, proj: ov, val: newVal, _overridden: true };
      if (p.ceil != null) {
        out.ceil = Math.round(p.ceil * mult * 100) / 100;
        if (p.salary > 0) out.cval = Math.round(out.ceil / (p.salary / 1000) * 100) / 100;
      }
      return out;
    });
  }, [rawDkPlayers, projOverrides]);
  // Ownership now returns { overall, cpt } — captain-specific tracking for
  // showdown slates is critical since a player at 60% total ownership but
  // only 8% CPT is a different fade target than one at 60% / 40% CPT.
  const ownershipData = useMemo(() => {
    if (dkPlayers.length === 0) return { overall: {}, cpt: {} };
    if (sport === 'tennis') return simulateOwnership(dkPlayers);
    if (sport === 'mma') return simulateMMAOwnership(dkPlayers);
    if (sport === 'nba') return simulateNBAOwnership(dkPlayers, data?.slate_type || 'showdown');
    return { overall: {}, cpt: {} };
  }, [dkPlayers, sport, data]);
  const ownership = ownershipData.overall;
  const cptOwnership = ownershipData.cpt;

  if (error) {
    const expectedUrl = sport === 'mma' ? './slate-mma.json'
                      : sport === 'nba' ? './slate-nba.json'
                      : './slate.json';
    const expectedPath = sport === 'mma' ? 'public/slate-mma.json'
                       : sport === 'nba' ? 'public/slate-nba.json'
                       : 'public/slate.json';
    return <div className="app">
      <Topbar sport={sport} onSportChange={setSport} data={null} />
      <div className="empty" style={{ padding: '40px 20px' }}>
        <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}><Icon name="warning" size={18} color="#EF4444"/> Slate not loaded</h2>
        <p style={{ marginTop: 12 }}>Fetch failed for <code style={{ background: 'var(--card)', padding: '2px 8px', borderRadius: 4, color: 'var(--primary)' }}>{expectedUrl}</code></p>
        <p style={{ marginTop: 8, fontSize: 13 }}>Error: <span style={{ color: 'var(--red)' }}>{error}</span></p>
        <div style={{ marginTop: 20, padding: '16px 20px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, maxWidth: 600, margin: '20px auto', textAlign: 'left', fontSize: 13 }}>
          <div style={{ color: 'var(--primary)', fontWeight: 700, marginBottom: 8 }}>Troubleshooting checklist:</div>
          <div style={{ color: 'var(--text-muted)', lineHeight: 1.7 }}>
            1. File must be at <code style={{ color: 'var(--primary-light)' }}>{expectedPath}</code> in your repo<br/>
            2. Confirm the file is committed + pushed to GitHub<br/>
            3. Wait 30–60s for Vercel to redeploy, then hard-refresh (Cmd+Shift+R / Ctrl+F5)<br/>
            4. Open browser DevTools → Network tab → click this sport again → check slate-mma.json status code
          </div>
        </div>
      </div>
    </div>;
  }
  if (!data) return <div className="app">
    {hasLoadedOnce && <Topbar sport={sport} onSportChange={setSport} data={null} />}
    {hasLoadedOnce ? <SportSwitchLoader sport={sport} /> : <SplashScreen sport={sport} />}
  </div>;

  // Shared icon set — tennis and MMA use the same tabs.
  // Label `l` becomes a hover tooltip via the title attribute; the tab bar shows icons only for a cleaner look.
  const buildTabs = () => [
    { id: 'dk', l: 'DraftKings Projections', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M3 17V9.5l4 3 2-6.5 3 6 3-6 2 6.5 4-3V17z"/><path d="M3 19h18"/></svg> },
    { id: 'pp', l: 'PrizePicks Projections', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/></svg> },
    { id: 'build', l: 'Lineup Builder', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L4 14h7l-1 8 10-12h-7l1-8z"/></svg> },
    { id: 'leverage', l: 'Live Leverage', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M7 3v18M4 7l3-4 3 4"/><path d="M17 21V3M14 17l3 4 3-4"/></svg> },
    { id: 'record', l: 'Track Record', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18"/><path d="M7 15l4-5 4 3 6-8"/></svg> }
  ];
  const tabs = buildTabs();

  return (<div className="app">
    <style>{`
      /* Hide number input spinners in builder rows (desktop only — mobile already clean) */
      .ctrl-row input[type="number"]::-webkit-outer-spin-button,
      .ctrl-row input[type="number"]::-webkit-inner-spin-button {
        -webkit-appearance: none;
        margin: 0;
      }
      .ctrl-row input[type="number"] {
        -moz-appearance: textfield;
        text-align: center;
      }
      /* Cursor-tracking gold glow — fixed, pointer-events:none, subtle */
      .cursor-glow {
        position: fixed;
        top: 0; left: 0;
        width: 100vw; height: 100vh;
        pointer-events: none;
        z-index: 0;
        background: radial-gradient(
          600px circle at var(--mx, 50%) var(--my, 50%),
          rgba(245, 197, 24, 0.13),
          rgba(245, 197, 24, 0.08) 40%,
          transparent 70%
        );
        transition: background 0.05s ease-out;
        mix-blend-mode: screen;
      }
      @media (hover: none) { .cursor-glow { display: none; } }
      /* Projection table override input — transparent so parent cell-top3/cell-proj
         classes handle the colors (top-value gold highlight, etc). Overridden state
         wins over both via !important. */
      .proj-edit {
        background: transparent;
        border: 1px solid transparent;
        color: inherit;
        font: inherit;
        font-variant-numeric: tabular-nums;
        text-align: right;
        width: 58px;
        padding: 2px 4px;
        border-radius: 3px;
        transition: border-color 0.12s, background 0.12s;
      }
      .proj-edit:hover { border-color: var(--border); background: rgba(245, 197, 24, 0.04); }
      .proj-edit:focus { outline: none; border-color: var(--primary); background: var(--bg); }
      .proj-edit.overridden { color: var(--primary) !important; font-weight: 700; }
      .proj-edit::-webkit-outer-spin-button, .proj-edit::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
      .proj-edit { -moz-appearance: textfield; }
      /* Icon-only tabs — compact square buttons with hover tooltip (native title attr handles the label).
         CRITICAL: active/inactive states MUST have identical box dimensions.
         We achieve this by (a) pinning width/padding/margin on all states and
         (b) using inset box-shadow (not border) for the active highlight,
         so the highlight is purely decorative and never affects layout width. */
      /* Icon-only tabs.
         Layout (width/height/padding/border-width) goes on the BASE .tab.tab-icon
         selector only — specificity (0,2,0) — so the mobile media query can
         cleanly override it. State-specific visuals (:hover, .active) only change
         colors/shadow, never dimensions — so they never fight mobile layout. */
      .tab.tab-icon {
        width: 56px !important;
        min-width: 56px !important;
        max-width: 56px !important;
        height: 40px !important;
        padding: 0 !important;
        margin: 0 !important;
        box-sizing: border-box !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        border: 1px solid rgba(245, 197, 24, 0.22) !important;
        border-radius: 6px !important;
        outline: none !important;
        background: transparent !important;
        transition: border-color 140ms ease, box-shadow 140ms ease, background-color 140ms ease;
      }
      .tab.tab-icon:hover {
        border-color: rgba(245, 197, 24, 0.5) !important;
        background: rgba(245, 197, 24, 0.04) !important;
      }
      .tab.tab-icon.active {
        border-color: #F5C518 !important;
        background: rgba(245, 197, 24, 0.12) !important;
        box-shadow: 0 0 8px rgba(245, 197, 24, 0.38) !important;
      }
      .tab.tab-icon svg {
        width: 22px;
        height: 22px;
        display: block;
      }

      /* Slate picker dropdown — force native dark theme on the options list.
         color-scheme: dark tells the browser to render the popup options,
         scrollbar, and selection highlight in dark mode (Chrome/Edge/Safari).
         Explicit option bg/color handles older browsers that ignore color-scheme. */
      .slate-picker {
        color-scheme: dark !important;
        accent-color: #F5C518 !important;
      }
      .slate-picker option {
        background-color: #0A1628 !important;
        color: #E5E7EB !important;
        padding: 6px 10px !important;
      }
      .slate-picker option:checked,
      .slate-picker option:hover {
        background: linear-gradient(rgba(245, 197, 24, 0.25), rgba(245, 197, 24, 0.25)) !important;
        background-color: rgba(245, 197, 24, 0.25) !important;
        color: #F5C518 !important;
        box-shadow: inset 0 0 0 100vw rgba(245, 197, 24, 0.25) !important;
      }

      /* Row-highlight classes — OPAQUE versions of the old rgba tints.
         color-mix() renders exactly the same visual as "card + 6% green/red"
         but as a solid color, so sticky cells stay opaque and no scroll-through
         bleed-through is possible. Applies to ALL tables universally. */
      .row-hl-green { background: color-mix(in srgb, #22C55E 6%, var(--card)) !important; }
      .row-hl-red   { background: color-mix(in srgb, #EF4444 6%, var(--card)) !important; }

      /* ═══════════════════════════════════════════════════════════════════
         SECTION HERO HEADER — editorial display treatment
         Icon badge + stroked-gradient title.
         Used on PrizePicks, Lineup Builder, Live Leverage (tennis + MMA).
         ═══════════════════════════════════════════════════════════════════ */
      .section-hero {
        display: flex;
        align-items: center;
        gap: 16px;
        padding: 4px 4px 14px;
        margin-bottom: 14px;
      }
      .section-hero-icon-wrap {
        width: 54px;
        height: 54px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: radial-gradient(circle at 30% 30%, rgba(245,197,24,0.28), rgba(245,197,24,0.04));
        border: 1px solid rgba(245,197,24,0.35);
        border-radius: 14px;
        flex-shrink: 0;
        box-shadow: 0 0 0 1px rgba(245,197,24,0.08) inset, 0 8px 22px -10px rgba(245,197,24,0.3);
      }
      .section-hero-icon {
        width: 26px;
        height: 26px;
        stroke-width: 1.75;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .section-hero-text { flex: 1; min-width: 0; }
      .section-hero-title {
        font-size: 28px;
        font-weight: 800;
        letter-spacing: -0.025em;
        line-height: 1.05;
        margin: 0 0 5px;
        background: linear-gradient(175deg, #FFFFFF 0%, #F5C518 100%);
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
        -webkit-text-stroke: 0.5px rgba(245,197,24,0.35);
        filter: drop-shadow(0 2px 14px rgba(245,197,24,0.15));
      }
      .section-hero-sub {
        font-size: 12px;
        color: var(--text-muted);
        font-weight: 500;
        letter-spacing: 0.02em;
      }
      @media (max-width: 768px) {
        .section-hero { gap: 12px; padding: 2px 4px 10px; margin-bottom: 10px; }
        .section-hero-icon-wrap { width: 44px; height: 44px; border-radius: 11px; }
        .section-hero-icon { width: 22px; height: 22px; }
        .section-hero-title { font-size: 22px; letter-spacing: -0.02em; }
        .section-hero-sub { font-size: 11px; }
      }

      /* Softer text colors — for inline (non-boxed) colored text.
         Full-saturation --green/--red/--amber are harsh against dark bg in
         body-copy contexts; these variants keep semantic meaning without
         the glare. Boxed values (cell-ev-pos, etc.) keep the saturated
         colors since the box provides contrast separation. */
      :root {
        --green-text: #4ADE80;
        --red-text:   #F87171;
        --amber-text: #FBBF24;
      }

      /* ═══════════════════════════════════════════════════════════════════
         MOBILE RESPONSIVE — phones and small tablets
         Touch targets ≥44px (iOS HIG), readable 12-13px body text,
         tables get horizontal scroll, controls stack vertically.
         ═══════════════════════════════════════════════════════════════════ */
      @media (max-width: 768px) {
        /* Content padding — tighter on mobile */
        .content { padding: 14px 10px !important; }

        /* Topbar — ONE row: brand + toggle + X button. Hide the "Updated" time info on mobile. */
        .topbar {
          flex-wrap: nowrap !important;
          gap: 8px !important;
          padding: 10px 12px !important;
          align-items: center !important;
        }
        .topbar-brand {
          font-size: 16px !important;
          flex-shrink: 1;
          min-width: 0;
          gap: 6px !important;
        }
        .topbar-brand svg { width: 24px !important; height: 24px !important; flex-shrink: 0; }
        .topbar-brand span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .topbar-right {
          flex-shrink: 0;
          gap: 6px !important;
          flex-wrap: nowrap !important;
          align-items: center;
        }
        /* Hide full date line on mobile — removes the awkward "Updated..." third row */
        .topbar-date { display: none !important; }
        /* Slate picker — compact on mobile */
        .slate-picker { font-size: 11px !important; padding: 5px 22px 5px 8px !important; max-width: 130px; }
        .mountain-watermark { display: none; }

        /* Tab bar — stretch to full width, 4 icons fill evenly, bigger touch targets */
        .tab-bar {
          display: flex !important;
          width: 100%;
          padding: 4px !important;
          gap: 4px !important;
          justify-content: space-between !important;
          margin: 0 0 12px 0 !important;
        }
        .tab.tab-icon {
          flex: 1 1 0 !important;
          width: auto !important;
          min-width: 0 !important;
          max-width: none !important;
          height: 48px !important;
        }
        .tab.tab-icon svg {
          width: 24px !important;
          height: 24px !important;
        }

        /* Tables — horizontal scroll with touch-inertia, tighter cells, smaller text */
        .table-wrap {
          overflow-x: auto !important;
          -webkit-overflow-scrolling: touch;
          margin-left: -10px;
          margin-right: -10px;
          padding: 0 10px;
        }
        .table-wrap table { font-size: 12px !important; }
        .table-wrap th, .table-wrap td { padding: 7px 8px !important; }
        /* Ensure every row has a solid default bg so sticky cells can inherit seamlessly;
           inline row highlights (green/red tint) override this and the sticky cell
           inherits the highlight too — consistent coloring across all columns. */
        .table-wrap tbody tr { background: var(--card); }
        .table-wrap td.name, .table-wrap th:first-child { position: sticky; left: 0; background: inherit; z-index: 1; }

        /* Projection edit input — bigger for thumb entry */
        .proj-edit {
          width: 56px !important;
          padding: 6px 4px !important;
          font-size: 14px !important;
        }

        /* Section headers — slightly smaller */
        .section-head { font-size: 15px !important; }
        .section-sub { font-size: 12px !important; }

        /* Builder controls — stack rows vertically, full-width inputs */
        .builder-controls { flex-direction: column !important; align-items: stretch !important; gap: 12px !important; }
        .ctrl-row { flex-wrap: wrap !important; gap: 8px !important; }
        .ctrl-row > * { flex: 1 1 auto; }
        .ctrl-name { min-width: 0 !important; flex: 2 1 120px !important; }
        .ctrl-proj { flex: 0 0 80px !important; }

        /* Buttons — ≥40px tap targets for action buttons only (NOT toggles/icon buttons) */
        .btn { min-height: 40px; }
        .btn.btn-primary, .btn.btn-outline { font-size: 13px; padding: 10px 14px; }

        /* Lineup cards — single column on phones, stacked layout */
        .lineup-grid { grid-template-columns: 1fr !important; gap: 10px !important; }
        .lu-card { padding: 12px !important; }
        .lu-row { gap: 8px !important; font-size: 12px !important; }
        .lu-name { font-size: 13px !important; }

        /* Metrics grid — 2 cols on tablet, single col on small phones handled below */
        .metrics { grid-template-columns: repeat(2, 1fr) !important; gap: 8px !important; }
        .metric { padding: 10px !important; }
        .metric-value { font-size: 18px !important; }
        .metric-label { font-size: 10px !important; }

        /* Compliance warning banner — full width, comfortable padding */
        .compliance-warning { padding: 12px !important; font-size: 12px !important; }

        /* Cursor glow — already disabled by hover:none media query above, just belt-and-suspenders */
        .cursor-glow { display: none !important; }
      }

      /* Narrow phones (iPhone SE, etc.) — even more compression */
      @media (max-width: 420px) {
        .content { padding: 10px 6px !important; }
        .topbar { padding: 8px 10px !important; }
        .topbar-brand { font-size: 16px !important; gap: 6px !important; }
        .topbar-brand svg { width: 22px !important; height: 22px !important; }
        .tab.tab-icon { height: 44px !important; }
        .tab.tab-icon svg { width: 22px !important; height: 22px !important; }
        .table-wrap table { font-size: 11px !important; }
        .table-wrap th, .table-wrap td { padding: 6px 6px !important; }
        .metrics { grid-template-columns: 1fr 1fr !important; }
        .proj-edit { width: 52px !important; font-size: 13px !important; }
        .section-head { font-size: 14px !important; }
      }
    `}</style>
    <div className="cursor-glow" aria-hidden="true" />
    <Topbar sport={sport} onSportChange={setSport} data={data} slateDate={slateDate} onSlateDateChange={setSlateDate} manifestSlates={manifestSlates} />
    <div className="tab-bar">{tabs.map(t => (
      <button key={t.id} className={`tab tab-icon ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)} title={t.l} aria-label={t.l}>
        {t.icon}
      </button>
    ))}</div>
    <div className="content">
      {buildError && <div className="empty" style={{ padding: '40px 20px' }}>
        <h2 style={{ color: '#EF4444', display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="warning" size={18} color="#EF4444"/> Projection build failed</h2>
        <p style={{ marginTop: 12, fontFamily: 'monospace', fontSize: 13, color: 'var(--red)' }}>{buildError}</p>
        <p style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }}>Check that slate-{sport === 'mma' ? 'mma' : ''}.json has valid odds fields for all {sport === 'mma' ? 'fights' : 'matches'}.</p>
      </div>}
      {!buildError && <ErrorBoundary>
      {sport === 'tennis' && (<>
        {tab === 'dk' && <DKTab players={dkPlayers} mc={data.matches?.length || 0} own={ownership} onOverride={onOverrideProj} overrides={projOverrides} />}
        {tab === 'pp' && <PPTab rows={ppRows} />}
        {tab === 'build' && <BuilderTab players={dkPlayers} ownership={ownership} />}
        {tab === 'leverage' && <LeverageTab players={dkPlayers} />}
        {tab === 'record' && <TrackRecordTab sport={sport} />}
      </>)}
      {sport === 'mma' && (<>
        {tab === 'dk' && <MMADKTab fighters={dkPlayers} fc={data.fights?.length || 0} own={ownership} onOverride={onOverrideProj} overrides={projOverrides} />}
        {tab === 'pp' && <MMAPPTab rows={ppRows} />}
        {tab === 'build' && <MMABuilderTab fighters={dkPlayers} ownership={ownership} />}
        {tab === 'leverage' && <LeverageTab players={dkPlayers} />}
        {tab === 'record' && <TrackRecordTab sport={sport} />}
      </>)}
      {sport === 'nba' && (<>
        {tab === 'dk' && <NBADKTab players={dkPlayers} gameInfo={data.game} own={ownership} cptOwn={cptOwnership} onOverride={onOverrideProj} overrides={projOverrides} />}
        {tab === 'pp' && <NBAPPTab rows={ppRows} />}
        {tab === 'build' && <NBABuilderTab players={dkPlayers} ownership={ownership} cptOwnership={cptOwnership} slateType={data.slate_type || 'showdown'} gameInfo={data.game} />}
        {tab === 'leverage' && <LeverageTab players={dkPlayers} />}
        {tab === 'record' && <TrackRecordTab sport={sport} />}
      </>)}
      </ErrorBoundary>}
    </div>
  </div>);
}

function Topbar({ sport, onSportChange, data, slateDate = 'live', onSlateDateChange, manifestSlates = [] }) {
  const hasArchive = manifestSlates && manifestSlates.length > 0;
  return (<div className="topbar">
    <div className="topbar-brand">
      <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" width="32" height="32" aria-label="OverOwned">
        <circle cx="50" cy="50" r="38" fill="none" stroke="#F5C518" strokeWidth="14"/>
        <path d="M 30 64 L 45 40 L 54 52 L 63 40 L 70 64 Z" fill="#F5C518"/>
        <circle cx="45" cy="40" r="1.8" fill="#FFFFFF"/>
      </svg>
      <span>Over<span className="brand-o">O</span>wned</span>
    </div>
    <div className="topbar-right">
      <div style={{ display: 'flex', background: 'var(--bg)', border: '1px solid var(--border-light)', borderRadius: 6, overflow: 'hidden' }}>
        <button onClick={() => onSportChange('tennis')} title="Tennis" aria-label="Tennis" style={{
          background: sport === 'tennis' ? 'var(--primary)' : 'transparent',
          color: sport === 'tennis' ? '#0A1628' : 'var(--text-muted)',
          border: 'none', padding: '7px 12px', cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {/* Tennis ball — circle with two inward-bowing vertical seams (classic tennis ball silhouette) */}
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9"/>
            <path d="M5 6c3 3 3 9 0 12"/>
            <path d="M19 6c-3 3-3 9 0 12"/>
          </svg>
        </button>
        <button onClick={() => onSportChange('mma')} title="MMA" aria-label="MMA" style={{
          background: sport === 'mma' ? 'var(--primary)' : 'transparent',
          color: sport === 'mma' ? '#0A1628' : 'var(--text-muted)',
          border: 'none', padding: '7px 12px', cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {/* MMA glove — padded knuckles at top, thumb protrusion left, wrist cuff bottom */}
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 4h5a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3z"/>
            <path d="M5 10a1.5 1.5 0 0 0 0 3"/>
            <path d="M8 17v3h6v-3"/>
          </svg>
        </button>
        <button onClick={() => onSportChange('nba')} title="NBA" aria-label="NBA" style={{
          background: sport === 'nba' ? 'var(--primary)' : 'transparent',
          color: sport === 'nba' ? '#0A1628' : 'var(--text-muted)',
          border: 'none', padding: '7px 12px', cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {/* Basketball — circle with horizontal equator and two curved seams */}
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9"/>
            <path d="M3 12h18"/>
            <path d="M12 3a9 9 0 0 1 0 18"/>
            <path d="M5.5 5.5c3 2 3 11 0 13"/>
            <path d="M18.5 5.5c-3 2-3 11 0 13"/>
          </svg>
        </button>
      </div>
      {hasArchive && onSlateDateChange && (() => {
        // UI shows most recent 6; backend (manifest.json) keeps the full list.
        // Older slates are still accessible by direct URL or by extending the manifest
        // if a "See all" option is added later.
        const recentSlates = manifestSlates.slice(0, 6);
        const isOlderSelected = slateDate !== 'live' && !recentSlates.some(s => s.date === slateDate);
        return (
          <select
            value={slateDate}
            onChange={e => onSlateDateChange(e.target.value)}
            title="Select slate date"
            className="slate-picker"
            style={{
              background: slateDate !== 'live' ? 'rgba(245,197,24,0.12)' : 'var(--bg)',
              border: `1px solid ${slateDate !== 'live' ? 'rgba(245,197,24,0.4)' : 'var(--border-light)'}`,
              borderRadius: 6,
              color: slateDate !== 'live' ? 'var(--primary)' : 'var(--text-muted)',
              padding: '5px 22px 5px 9px',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              appearance: 'none',
              height: 30,
              lineHeight: '18px',
              maxWidth: 140,
              backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23F5C518' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>")`,
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'right 7px center',
            }}>
            <option value="live">Live slate</option>
            {recentSlates.map(s => (
              <option key={s.date} value={s.date}>{s.label || s.date}</option>
            ))}
            {isOlderSelected && <option value={slateDate}>{slateDate}</option>}
          </select>
        );
      })()}
      {data && <div className="topbar-date">
        <span className="topbar-date-main">{data.date} · {
          sport === 'nba' ? `${data.game ? `${data.game.away}@${data.game.home}` : ''} · ${(data.dk_players || []).length} players`
          : sport === 'mma' ? `${data.fights?.length || 0} fights`
          : `${data.matches?.length || 0} matches`
        }</span>
        {data.last_updated && <span className="topbar-date-updated"> · <span style={{color:'var(--green)',fontSize:12}}>Updated {data.last_updated}</span></span>}
      </div>}
      <a href="https://x.com/OverOwnedDFS" target="_blank" rel="noopener noreferrer" className="twitter-btn" title="@OverOwnedDFS">
        <svg viewBox="0 0 24 24" width="14" height="14"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
      </a>
    </div>
    <svg className="mountain-watermark" viewBox="0 0 340 68" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMaxYMid slice" aria-hidden="true">
      <path d="M0,68 L40,30 L90,50 L150,20 L210,42 L260,28 L310,38 L340,32 L340,68 Z" fill="#F5C518" opacity="0.55"/>
      <path d="M0,68 L30,50 L85,58 L140,40 L200,52 L250,46 L305,54 L340,50 L340,68 Z" fill="#F5C518" opacity="0.35"/>
      <path d="M146,22 L150,20 L154,24 L150,25 Z" fill="#FFFFFF" opacity="0.9"/>
      <path d="M206,44 L210,42 L214,46 L210,47 Z" fill="#FFFFFF" opacity="0.75"/>
    </svg>
  </div>);
}

// ═══════════════════════════════════════════════════════════════════════
// TENNIS COMPONENTS — UNCHANGED from v5 except BuilderTab gets contrarian
// ═══════════════════════════════════════════════════════════════════════
function DKTab({ players, mc, own, onOverride, overrides }) {
  const pw = useMemo(() => players.filter(p => p.salary > 0).map(p => ({ ...p, simOwn: own[p.name] || 0 })), [players, own]);
  const { sorted, sortKey, sortDir, toggleSort } = useSort(pw, 'val', 'desc');
  const t3v = useMemo(() => [...players].sort((a, b) => b.val - a.val).slice(0, 3).map(p => p.name), [players]);
  const t3s = useMemo(() => [...players].sort((a, b) => b.pStraight - a.pStraight).slice(0, 3).map(p => p.name), [players]);
  const trap = useMemo(() => {
    const hasOwn = pw.some(p => p.simOwn > 0);
    const s = hasOwn ? [...pw].sort((a, b) => b.simOwn - a.simOwn) : [...pw].sort((a, b) => b.proj - a.proj);
    return s[0]?.name || '';
  }, [pw]);
  // Hidden Gem — two-path logic:
  //   (1) If trap's opponent is +199 or better (wp >= 33.4%), they ARE the gem.
  //       In tennis, close matchups mean the dog often flips the result — and they
  //       come with the exact salary swap benefit.
  //   (2) If trap's opponent is +200 or worse (wp < 33.4%), the dog is too big.
  //       Fall back to a good-value high-ceiling player within -$1000/+$300 of trap.
  const gem = useMemo(() => {
    const trapPlayer = pw.find(p => p.name === trap);
    if (!trapPlayer) return '';
    const opponent = pw.find(p => p.name === trapPlayer.opponent);
    if (opponent && (opponent.wp || 0) >= 0.334) return opponent.name;
    // Salary-band fallback: -$1000 to +$300 of trap
    const trapSal = trapPlayer.salary;
    const candidates = pw.filter(p => {
      if (p.name === trap) return false;
      const diff = p.salary - trapSal;
      return diff >= -1000 && diff <= 300;
    });
    if (candidates.length === 0) return '';
    const scored = candidates.map(p => {
      const val = p.proj / (p.salary / 1000);
      return { name: p.name, s: val * p.proj };
    }).sort((a, b) => b.s - a.s);
    return scored[0]?.name || '';
  }, [pw, trap]);
  const S = p => <SH {...p} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />;
  return (<>
    <div className="metrics">
      <div className="metric"><div className="metric-label"><Icon name="trophy" size={13}/> Top Value</div><div className="metric-value">{t3v.map((n, i) => { const p = players.find(x => x.name === n); return <div key={i} style={{ fontSize: i === 0 ? '16px' : '13px', color: i === 0 ? undefined : 'var(--text-muted)' }}>{i + 1}. {n} <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{fmt(p?.val, 2)}</span></div>; })}</div></div>
      <div className="metric"><div className="metric-label"><Icon name="target" size={13}/> Top Straight Sets</div><div className="metric-value">{t3s.map((n, i) => { const p = players.find(x => x.name === n); return <div key={i} style={{ fontSize: i === 0 ? '16px' : '13px', color: i === 0 ? undefined : 'var(--text-muted)' }}>{n} <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{fmtPct(p?.pStraight)}</span></div>; })}</div></div>
      <div className="metric"><div className="metric-label"><Icon name="gem" size={13}/> Hidden Gem</div><div className="metric-value" style={{ color: 'var(--green-text)' }}>{gem || '-'}</div><div className="metric-sub">Low ownership, high upside</div></div>
      <div className="metric"><div className="metric-label"><Icon name="bomb" size={13}/> Biggest Trap</div><div className="metric-value" style={{ color: 'var(--red-text)' }}>{trap || '-'}</div><div className="metric-sub">High ownership, bust risk</div></div>
    </div>
    <div className="table-wrap"><table><thead><tr>
      <th>#</th><th></th><S label="Player" colKey="name" /><th>Opp</th><S label="Sal" colKey="salary" /><S label="Sim Own" colKey="simOwn" /><S label="Win%" colKey="wp" /><S label="Proj" colKey="proj" /><S label="Val" colKey="val" /><S label="P(2-0)" colKey="pStraight" /><S label="GW" colKey="gw" /><S label="GL" colKey="gl" /><S label="SW" colKey="sw" /><S label="Aces" colKey="aces" /><S label="DFs" colKey="dfs" /><S label="Breaks" colKey="breaks" /><th>Time</th>
    </tr></thead>
    <tbody>{sorted.map((p, i) => {
      const iv = t3v.includes(p.name), is = t3s.includes(p.name), ig = p.name === gem, it = p.name === trap;
      const badges = [];
      if (iv) badges.push({ icon: 'trophy', label: 'Top 3 Value' });
      if (is) badges.push({ icon: 'target',  label: 'Top 3 Straight Sets' });
      if (ig) badges.push({ icon: 'gem',     label: 'Hidden Gem' });
      if (it) badges.push({ icon: 'bomb',    label: 'Trap' });
      const isOver = overrides && overrides[p.name] != null;
      return <tr key={p.name} className={ig ? 'row-hl-green' : it ? 'row-hl-red' : ''}>
        <td className="muted">{i + 1}</td>
        <td><span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>{badges.map((bd, j) => <Tip key={j} icon={bd.icon} label={bd.label} size={14} />)}</span></td>
        <td className="name">{p.name}</td><td className="muted">{p.opponent}</td>
        <td className="num">{fmtSal(p.salary)}</td>
        <td className="num" style={{ color: p.simOwn > 30 ? 'var(--amber)' : 'var(--text-muted)' }}>{fmt(p.simOwn, 1)}%</td>
        <td className="num">{fmtPct(p.wp)}</td>
        <td className="num">
          <span className={iv ? 'cell-top3' : 'cell-proj'}>
            <input type="number" step="0.01" className={`proj-edit ${isOver ? 'overridden' : ''}`}
              value={fmt(p.proj, 2)}
              onChange={e => onOverride && onOverride(p.name, e.target.value)}
              onDoubleClick={() => onOverride && onOverride(p.name, null)}
              title={isOver ? 'Overridden — double-click to reset' : 'Click to edit projection'} />
          </span>
        </td>
        <td className="num"><span className={iv ? 'cell-top3' : ''}>{fmt(p.val, 2)}</span></td>
        <td className="num"><span className={is ? 'cell-top3' : ''}>{fmtPct(p.pStraight)}</span></td>
        <td className="num">{fmt(p.gw)}</td><td className="num muted">{fmt(p.gl)}</td><td className="num">{fmt(p.sw)}</td>
        <td className="num">{fmt(p.aces)}</td><td className="num muted">{fmt(p.dfs)}</td><td className="num">{fmt(p.breaks)}</td>
        <td className="muted">{fmtTime(p.startTime)}</td>
      </tr>; })}</tbody></table></div>
  </>);
}

function PPTab({ rows }) {
  const { sorted, sortKey, sortDir, toggleSort } = useSort(rows, 'ev', 'desc');
  const S = p => <SH {...p} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />;
  const best = useMemo(() => [...rows].sort((a, b) => b.ev - a.ev).slice(0, 3), [rows]);
  const worst = useMemo(() => [...rows].sort((a, b) => a.ev - b.ev).slice(0, 3), [rows]);
  return (<>
    <div className="section-hero">
      <div className="section-hero-icon-wrap">
        <svg className="section-hero-icon" viewBox="0 0 24 24" fill="none" stroke="#F5C518">
          <circle cx="12" cy="12" r="9"/>
          <circle cx="12" cy="12" r="5"/>
          <circle cx="12" cy="12" r="1.5" fill="#F5C518" stroke="none"/>
        </svg>
      </div>
      <div className="section-hero-text">
        <h2 className="section-hero-title">PrizePicks Projections</h2>
        <div className="section-hero-sub">All plays sorted by edge · Edge = Projected − PP Line</div>
      </div>
    </div>
    <div style={{ background: 'rgba(245,197,24,0.06)', border: '1px solid rgba(245,197,24,0.25)', borderRadius: 8, padding: '10px 14px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
      <Icon name="trending-down" size={18} color="#F5C518"/>
      <span style={{ color: 'var(--text-muted)' }}><strong style={{ color: 'var(--primary)', fontWeight: 700 }}>Hint:</strong> PrizePicks bad value will typically reverse</span>
    </div>
    <div className="metrics">
      <div className="metric"><div className="metric-label"><Icon name="flame" size={13}/> Best Edge</div><div className="metric-value">{best.map((r, i) => <div key={i} style={{ fontSize: i === 0 ? '16px' : '13px', color: i === 0 ? 'var(--green-text)' : 'var(--text-muted)', fontWeight: i === 0 ? 700 : 500 }}>{r.player} · {r.stat} <span style={{fontSize:11, color: i === 0 ? undefined : 'var(--text-dim)'}}>{r.ev > 0 ? '+' : ''}{fmt(r.ev, 2)}</span>{r.mult && <span style={{fontSize:10,color: i === 0 ? 'var(--amber-text)' : 'var(--text-dim)',marginLeft:4}}>{r.mult}</span>}</div>)}</div></div>
      <div className="metric"><div className="metric-label"><Icon name="trending-down" size={13}/> Biggest "Fades"</div><div className="metric-value">{worst.map((r, i) => <div key={i} style={{ fontSize: i === 0 ? '16px' : '13px', color: i === 0 ? 'var(--red-text)' : 'var(--text-muted)', fontWeight: i === 0 ? 700 : 500 }}>{r.player} · {r.stat} <span style={{fontSize:11, color: i === 0 ? undefined : 'var(--text-dim)'}}>{fmt(r.ev, 2)}</span></div>)}</div></div>
    </div>
    <div className="table-wrap"><table><thead><tr>
      <th>#</th><th></th><S label="Player" colKey="player" /><S label="Stat" colKey="stat" />
      <S label="PP Line" colKey="line" /><S label="Projected" colKey="projected" />
      <S label="Edge" colKey="ev" /><S label="Play" colKey="direction" />
      <th>Mult</th><S label="Win%" colKey="wp" /><S label="Opp" colKey="opponent" />
    </tr></thead>
    <tbody>{sorted.map((r, i) => {
      const isBest = best.some(t => t.player === r.player && t.stat === r.stat);
      const isWorst = worst.some(t => t.player === r.player && t.stat === r.stat);
      const playDir = r.direction;
      return <tr key={r.player + r.stat} className={isBest ? 'row-hl-green' : isWorst ? 'row-hl-red' : ''}>
        <td className="muted">{i+1}</td>
        <td>{isBest ? <Tip icon="flame" label="Best edge" /> : isWorst ? <Tip icon="trending-down" label="Fade" /> : ''}</td>
        <td className="name">{r.player}</td>
        <td style={{fontSize:11,color:'var(--text-muted)'}}>{r.stat}</td>
        <td className="num">{fmt(r.line, 1)}</td>
        <td className="num"><span className="cell-proj">{fmt(r.projected, 2)}</span></td>
        <td className="num"><span className={isBest ? 'cell-ev-top' : isWorst ? 'cell-ev-worst' : r.ev > 0 ? 'cell-ev-pos' : 'cell-ev-neg'}>{r.ev > 0 ? '+' : ''}{fmt(r.ev, 2)}</span></td>
        <td><span style={{color: playDir === 'MORE' ? 'var(--green-text)' : playDir === 'LESS' ? 'var(--red-text)' : 'var(--text-dim)', fontWeight:600}}>{playDir}</span></td>
        <td style={{color:'var(--amber-text)',fontSize:11}}>{r.mult || ''}</td>
        <td className="num muted">{fmtPct(r.wp)}</td>
        <td className="muted">{r.opponent}</td>
      </tr>;
    })}</tbody></table></div>
  </>);
}

// ═══════════════════════════════════════════════════════════════════════
// TENNIS BUILDER — surgical additive change for contrarian mode
// ═══════════════════════════════════════════════════════════════════════
function BuilderTab({ players: rp, ownership }) {
  const [exp, setExp] = useState({}); const [res, setRes] = useState(null);
  const [nL, setNL] = useState(45);
  const [variance, setVariance] = useState(2);                // ±% jitter on projections per build — differentiates outputs between users
  const [globalMax, setGlobalMax] = useState(100); const [globalMin, setGlobalMin] = useState(0);
  // NEW: contrarian state — OFF by default (behavior preserved when off)
  const [contrarianOn, setContrarianOn] = useState(false);
  const [contrarianStrength, setContrarianStrength] = useState(0.6);
  // NEW: value-aware contrarian — identical ref to rp when contrarian off (zero recompute)
  const avgVal = useMemo(() => {
    const vals = rp.filter(p => p.salary > 0).map(p => p.val || 0);
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 7;
  }, [rp]);
  // CONTRARIAN MODE
  //  (1) TRAP — highest-owned MID/LOW-TIER play (stars excluded, they aren't traps)
  //  (2a) ⭐ STUD BOOST — highest-owned top-projection play (leverage the good chalk)
  //  (2b) GEM BOOST — below-avg-val underowned (DK-priced-down, field avoiding)
  //  (3) UNIVERSAL LEVERAGE CAP — no player above field+20pp (user rule: never smart in DK)
  //  (4) GLOBAL FLOOR — everyone has min exposure, prevents DK-salary tunneling
  const contrarianCaps = useMemo(() => {
    if (!contrarianOn) return {};
    const withSal = rp.filter(p => p.salary > 0);
    if (withSal.length === 0) return {};
    const caps = {};

    // Stars (top 30% by projection) — used for stud selection, NOT for trap exclusion
    const byProj = [...withSal].sort((a, b) => b.proj - a.proj);
    const topProjN = Math.max(3, Math.ceil(withSal.length * 0.3));
    const topProjSet = new Set(byProj.slice(0, topProjN).map(p => p.name));

    // Leverage bounds — capped at 20pp per user rule
    const boostFloor = Math.round(10 + contrarianStrength * 10);   // 13-20pp by strength
    const LEV_CAP = 30;

    // (1) TRAP — highest-owned player (matches DK tab's "Biggest Trap" definition).
    //     DK tab defines trap as simply highest ownership. Contrarian respects that —
    //     if the field has converged on a player, fade them regardless of star status.
    //     Cap: field_own - (strength × 40) so at max strength the trap gets -40pp fade.
    const hasOwn = withSal.some(p => (ownership[p.name] || 0) > 0);
    const trap = hasOwn
      ? [...withSal].sort((a, b) => (ownership[b.name] || 0) - (ownership[a.name] || 0))[0]
      : byProj[0];
    if (trap) {
      const trapFieldOwn = ownership[trap.name] || 0;
      const maxCap = Math.max(5, Math.round(trapFieldOwn - contrarianStrength * 50));
      caps[trap.name] = { max: maxCap, _isTrap: true };
    }

    // (2a) STUD — overowned star (field > fair_own + 5pp) with WORST value
    //      This picks the chalkiest star that DK underpriced least — same "bad value"
    //      principle applied to stars. If two stars are equally overowned but one has
    //      worse pts/dollar, that's the one DK overpriced and the field is still piling into.
    const overownedStars = withSal.filter(p => {
      if (p.name === trap?.name) return false;
      if (!topProjSet.has(p.name)) return false;
      const fieldOwn = ownership[p.name] || 0;
      const fairOwn = computeFairOwn(p.val || 0, avgVal);
      return fieldOwn > fairOwn + 5 && fieldOwn >= 25;
    });
    const stud = overownedStars.sort((a, b) => (a.val || 0) - (b.val || 0))[0];
    if (stud) {
      const fieldOwn = Math.round(ownership[stud.name] || 0);
      caps[stud.name] = {
        min: Math.min(85, fieldOwn + boostFloor),
        max: Math.min(95, fieldOwn + LEV_CAP),
        _isBoost: true, _leverage: boostFloor, _type: 'stud'
      };
    }

    // (2b) GEM — salary substitute for trap (-$1000 to +$300 band). Cascade:
    //        (1) bad-val + underowned in band       [DK-priced-down + field missing = pure gem]
    //        (2) good-val + underowned in band      [field ignoring an overlooked elite]
    //        (3) any bad-val in band                [field-avoided at that price, even if chalky]
    //        (4) lowest-owned in band               [anyone unappreciated at that price]
    //        (5) widen band to -$1500/+$500 and retry lowest-owned
    // Order rationale: true underownership (underowned relative to fair) beats pure bad-val
    // signal. If the only bad-val play is itself overowned (like Moises at 38%), it's not
    // really a "field-missed" play — boost a genuinely underowned alternative instead.
    const trapSal = trap?.salary ?? 0;
    const inBand = (p, lo, hi) => (p.salary - trapSal) >= lo && (p.salary - trapSal) <= hi;
    const salaryEligible = trap ? withSal.filter(p => {
      if (p.name === trap.name || p.name === stud?.name) return false;
      return inBand(p, -1000, 300);
    }) : [];
    const sameBandBadVal = salaryEligible.filter(p => (p.val || 0) < avgVal);
    // (1) Bad-val AND underowned: the ideal gem
    const strictGem = sameBandBadVal
      .filter(p => (ownership[p.name] || 0) < computeFairOwn(p.val || 0, avgVal))
      .sort((a, b) => b.proj - a.proj)[0];
    // (2) Good-val underowned: overlooked elite at same price point as trap
    const goodValUnderowned = salaryEligible
      .filter(p => (p.val || 0) >= avgVal && (ownership[p.name] || 0) < computeFairOwn(p.val || 0, avgVal) - 3)
      .sort((a, b) => b.proj - a.proj)[0];
    // (3) Any bad-val (even chalky) — last resort for DK-priced-down differentiation
    const badValFallback = sameBandBadVal.sort((a, b) => {
      const aGap = computeFairOwn(a.val || 0, avgVal) - (ownership[a.name] || 0);
      const bGap = computeFairOwn(b.val || 0, avgVal) - (ownership[b.name] || 0);
      if (Math.abs(bGap - aGap) > 1) return bGap - aGap;
      return b.proj - a.proj;
    })[0];
    const lowOwnFallback = salaryEligible
      .sort((a, b) => (ownership[a.name] || 0) - (ownership[b.name] || 0))[0];
    const widerPool = (!strictGem && !goodValUnderowned && !badValFallback && !lowOwnFallback && trap)
      ? withSal.filter(p => p.name !== trap.name && p.name !== stud?.name && inBand(p, -1500, 500))
      : [];
    const widerFallback = widerPool.sort((a, b) => (ownership[a.name] || 0) - (ownership[b.name] || 0))[0];
    const gem = strictGem || goodValUnderowned || badValFallback || lowOwnFallback || widerFallback;
    if (gem) {
      const fieldOwn = Math.round(ownership[gem.name] || 0);
      caps[gem.name] = {
        min: Math.min(85, fieldOwn + boostFloor),
        max: Math.min(95, fieldOwn + LEV_CAP),
        _isBoost: true, _leverage: boostFloor, _type: 'gem'
      };
    }

    // (3) + (4) LEVERAGE CAP + GLOBAL FLOOR
    //     The +20pp cap is the user's "never smart in DK" rule, but it only applies to
    //     players at material ownership — underowned floor plays (<20% field) aren't at
    //     risk of being chalky, so capping them at field+20 just makes the problem
    //     infeasible. Apply cap selectively: boosted players keep exact +20pp, floored
    //     players only get the cap if their field ownership is already meaningful (≥15%).
    const globalFloor = Math.round(1 + contrarianStrength * 7);
    withSal.forEach(p => {
      const fieldOwn = Math.round(ownership[p.name] || 0);
      if (caps[p.name]) {
        // Trap/stud/gem already set — leave their max alone (stud/gem already exactly at +LEV_CAP)
        return;
      }
      // Floored players: apply +20pp cap only if field is ≥15%, else just floor them
      const maxCap = fieldOwn >= 15 ? Math.min(95, fieldOwn + LEV_CAP) : 100;
      caps[p.name] = { min: globalFloor, max: maxCap, _isFloor: true };
    });

    return caps;
  }, [rp, ownership, contrarianOn, contrarianStrength, avgVal]);

  // Projections untouched when contrarian is on (caps do the work now)
  const adjRp = rp;

  const sp = useMemo(() => [...adjRp].filter(p => p.salary > 0).sort((a, b) => b.val - a.val), [adjRp]);
  const sE = (n, f, v) => setExp(p => ({ ...p, [n]: { ...p[n], [f]: v } }));
  const applyGlobal = () => { const ne = {}; sp.forEach(p => { ne[p.name] = { min: globalMin, max: globalMax, ...exp[p.name] }; }); setExp(ne); };
  const isShowdown = useMemo(() => sp.some(p => p.cpt_salary != null), [sp]);
  const run = () => {
    if (!canBuild) return;                      // DK compliance gate — user must edit ≥2 projections
    // Variance jitter: each build applies a fresh ±variance% random multiplier to every player's projection.
    // Math.random() is unseeded, so two users clicking Build on the same slate get different rankings → different CSVs.
    const jitter = () => 1 + (Math.random() * 2 - 1) * variance / 100;
    // DK anti-abuse rule: submitted lineup CSVs can't be identical across entries. Even at variance=0
    // (deterministic builds), guarantee at least 2 players' projections differ from baseline by ≥0.01 —
    // enough to break ties in the optimizer without meaningfully altering rankings.
    const enforceMinNudge = (pd, basePd) => {
      const changed = pd.filter((p, i) => Math.abs(p.projection - basePd[i].proj) >= 0.01).length;
      if (changed >= 2) return;
      const idxs = [...Array(pd.length).keys()].sort(() => Math.random() - 0.5).slice(0, 2);
      idxs.forEach(i => {
        const sign = Math.random() < 0.5 ? -1 : 1;
        pd[i].projection = Math.round((pd[i].projection + sign * 0.01) * 1000) / 1000;
      });
    };
    if (isShowdown) {
      const pd = sp.map(p => {
        const cap = contrarianCaps[p.name] || {};
        const userSet = exp[p.name] || {};
        const userMin = userSet.min !== undefined ? userSet.min : globalMin;
        const userMax = userSet.max !== undefined ? userSet.max : globalMax;
        const effMin = Math.max(userMin, cap.min || 0);
        const effMax = Math.min(userMax, cap.max !== undefined ? cap.max : 100);
        return {
          name: p.name, projection: p.proj * jitter(), opponent: p.opponent,
          // Salary field kept for exposure table value calc (uses FLEX baseline)
          salary: p.flex_salary ?? p.salary, id: p.flex_id ?? p.id,
          cpt_salary: p.cpt_salary, acpt_salary: p.acpt_salary, flex_salary: p.flex_salary,
          cpt_id: p.cpt_id, acpt_id: p.acpt_id, flex_id: p.flex_id,
          maxExp: effMax, minExp: effMin,
        };
      });
      enforceMinNudge(pd, sp);
      const r = optimizeShowdown(pd, nL, 50000, 48000);
      setRes({ ...r, pData: pd, isShowdown: true });
      return;
    }
    const pd = sp.map(p => {
      const cap = contrarianCaps[p.name] || {};
      const userSet = exp[p.name] || {};
      // Contrarian is MORE-RESTRICTIVE than user: cap.min lifts user.min, cap.max lowers user.max.
      // This way Apply Globals (which sets min:0/max:100 for all) can't silently override boosts/fades.
      const userMin = userSet.min !== undefined ? userSet.min : globalMin;
      const userMax = userSet.max !== undefined ? userSet.max : globalMax;
      const effMin = Math.max(userMin, cap.min || 0);
      const effMax = Math.min(userMax, cap.max !== undefined ? cap.max : 100);
      return { name: p.name, salary: p.salary, id: p.id, projection: p.proj * jitter(), opponent: p.opponent, maxExp: effMax, minExp: effMin };
    });
    enforceMinNudge(pd, sp);
    const r = optimize(pd, nL, 50000, 6, 48000);
    setRes({ ...r, pData: pd, isShowdown: false });
  };
  const dl = (c, f) => { const b = new Blob([c], { type: 'text/csv' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = f; a.click(); URL.revokeObjectURL(a.href); };
  const exportDK = () => {
    if (!res) return;
    if (res.isShowdown) {
      let c = 'CPT,A-CPT,P\n';
      res.lineups.forEach(lu => {
        const cptP = res.pData[lu.cpt], acptP = res.pData[lu.acpt], flexP = res.pData[lu.flex];
        c += `${cptP.cpt_id},${acptP.acpt_id},${flexP.flex_id}\n`;
      });
      dl(c, 'dk_upload_showdown.csv');
      return;
    }
    let c = 'P,P,P,P,P,P\n';
    res.lineups.forEach(lu => { const ps = lu.players.map(i => res.pData[i]).sort((a, b) => b.salary - a.salary); c += ps.map(p => p.id).join(',') + '\n'; });
    dl(c, 'dk_upload.csv');
  };
  const exportReadable = () => {
    if (!res) return;
    if (res.isShowdown) {
      let c = 'Rank,Proj,Salary,CPT,A-CPT,FLEX\n';
      res.lineups.forEach((lu, i) => {
        const cptP = res.pData[lu.cpt], acptP = res.pData[lu.acpt], flexP = res.pData[lu.flex];
        c += `${i + 1},${lu.proj},${lu.sal},${cptP.name},${acptP.name},${flexP.name}\n`;
      });
      dl(c, 'lineups_showdown.csv');
      return;
    }
    let c = 'Rank,Proj,Salary,P1,P2,P3,P4,P5,P6\n';
    res.lineups.forEach((lu, i) => { const ps = lu.players.map(j => res.pData[j]).sort((a, b) => b.salary - a.salary); c += `${i + 1},${lu.proj},${lu.sal},${ps.map(p => p.name).join(',')}\n`; });
    dl(c, 'lineups.csv');
  };
  const exportProjections = () => { let c = 'Player,Salary,Win%,Proj,Value,GW,GL,SW,Aces,DFs,Breaks,P(2-0),Opp\n'; sp.forEach(p => { c += `${p.name},${p.salary},${(p.wp * 100).toFixed(0)}%,${p.proj},${p.val},${fmt(p.gw)},${fmt(p.gl)},${fmt(p.sw)},${fmt(p.aces)},${fmt(p.dfs)},${fmt(p.breaks)},${fmtPct(p.pStraight)},${p.opponent}\n`; }); dl(c, 'projections.csv'); };
  const overrideCount = useMemo(() => rp.filter(p => p._overridden).length, [rp]);
  const canBuild = overrideCount >= 2;
  return (<>
    <div className="section-hero">
      <div className="section-hero-icon-wrap">
        <svg className="section-hero-icon" viewBox="0 0 24 24" fill="#F5C518" stroke="none">
          <path d="M13 2L4 14h7l-1 8 10-12h-7l1-8z"/>
        </svg>
      </div>
      <div className="section-hero-text">
        <h2 className="section-hero-title">Lineup Builder</h2>
        <div className="section-hero-sub">Set exposure %, build optimized lineups, export to DK</div>
      </div>
    </div>
    {!canBuild && (
      <div style={{ padding: '14px 18px', marginBottom: 16, background: 'rgba(245,197,24,0.08)', border: '1px solid rgba(245,197,24,0.35)', borderRadius: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--primary)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="warning" size={15} color="#F5C518"/> DraftKings Compliance Warning</div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          DraftKings policies require you to make some changes to our default projections before you can build lineups.
          Head to the <strong style={{ color: 'var(--text)' }}>DK Projections</strong> tab and edit at least <strong style={{ color: 'var(--primary)' }}>2 projections</strong> by any amount — this proves the lineups are your own work, not a shared export.
          <span style={{ color: 'var(--text-dim)' }}> Currently changed: <strong style={{ color: overrideCount >= 2 ? 'var(--green)' : 'var(--red)' }}>{overrideCount}</strong>/2</span>
        </div>
      </div>
    )}
    <ContrarianPanel enabled={contrarianOn} onToggle={setContrarianOn} strength={contrarianStrength} onStrengthChange={setContrarianStrength} />
    {contrarianOn && Object.keys(contrarianCaps).length > 0 && (() => {
      const trapEntry = Object.entries(contrarianCaps).find(([, c]) => c._isTrap);
      const boostEntries = Object.entries(contrarianCaps).filter(([, c]) => c._isBoost).sort((a, b) => (a[1]._rank || 0) - (b[1]._rank || 0));
      const floorEntry = Object.entries(contrarianCaps).find(([, c]) => c._isFloor);
      const floorCount = Object.values(contrarianCaps).filter(c => c._isFloor).length;
      return (
        <div style={{ marginTop: -12, marginBottom: 16, padding: '10px 14px', background: 'rgba(245,197,24,0.06)', border: '1px solid rgba(245,197,24,0.2)', borderRadius: 8, fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          {trapEntry && <span><Icon name="bomb" size={12} color="var(--red)"/> Fading <span style={{ color: 'var(--red)', fontWeight: 600 }}>{trapEntry[0]}</span> · field {(ownership[trapEntry[0]] || 0).toFixed(1)}% → max <span style={{ color: 'var(--primary)', fontWeight: 600 }}>{trapEntry[1].max}%</span></span>}
          {boostEntries.map(([name, c]) => (
            <span key={name}>{c._type === 'stud' ? <><Icon name="trophy" size={12}/> Stud</> : <><Icon name="gem" size={12}/> Gem</>} <span style={{ color: 'var(--green)', fontWeight: 600 }}>{name}</span> · field {(ownership[name] || 0).toFixed(1)}% +<span style={{ color: 'var(--primary)', fontWeight: 600 }}>{c._leverage}pp</span> → <span style={{ color: 'var(--primary)', fontWeight: 600 }}>{c.min}-{c.max}%</span></span>
          ))}
          {floorEntry && <span><Icon name="link" size={12} color="var(--text-muted)"/> {floorCount} other{floorCount === 1 ? '' : 's'} · floor <span style={{ color: 'var(--primary)', fontWeight: 600 }}>{floorEntry[1].min}%</span> · chalk capped <span style={{ color: 'var(--primary)', fontWeight: 600 }}>+30pp</span></span>}
        </div>
      );
    })()}
    <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
      <label style={{ fontSize: 13, color: 'var(--text-muted)' }}>Lineups: <input style={{ width: 60, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', padding: '4px 8px', marginLeft: 4 }} type="number" value={nL} onChange={e => setNL(+e.target.value)} /></label>
      <label style={{ fontSize: 13, color: 'var(--text-muted)' }}>Global Min %: <input style={{ width: 50, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', padding: '4px 8px', marginLeft: 4 }} type="number" value={globalMin} onChange={e => setGlobalMin(+e.target.value)} /></label>
      <label style={{ fontSize: 13, color: 'var(--text-muted)' }}>Global Max %: <input style={{ width: 50, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', padding: '4px 8px', marginLeft: 4 }} type="number" value={globalMax} onChange={e => setGlobalMax(+e.target.value)} /></label>
      <label style={{ fontSize: 13, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }} title="Random ± shift applied to each player's projection per build. Ensures you and other users don't submit identical lineups on the same slate.">
        Variance
        <input type="range" min="0" max="25" step="1" value={variance} onChange={e => setVariance(+e.target.value)} style={{ width: 80, accentColor: 'var(--primary)' }} />
        <span style={{ fontWeight: 700, color: variance > 0 ? 'var(--primary)' : 'var(--text-dim)', minWidth: 28, textAlign: 'right' }}>{variance}%</span>
      </label>
      <button onClick={applyGlobal} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-muted)', padding: '4px 12px', fontSize: 12, cursor: 'pointer' }}>Apply Global</button>
      <button onClick={exportProjections} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-muted)', padding: '4px 12px', fontSize: 12, cursor: 'pointer', marginLeft: 'auto' }}><Icon name="download" size={12}/> Projections CSV</button>
    </div>
    <div className="builder-controls">{sp.map(p => <div className="ctrl-row" key={p.name}><span className="ctrl-name" style={{ flex: '1 1 0', minWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span><span style={{ color: 'var(--text-dim)', fontSize: 11, width: 48, flexShrink: 0 }}>{fmtSal(p.salary)}</span><span className="ctrl-proj" style={{ flexShrink: 0, width: 38, textAlign: 'right' }}>{fmt(p.proj, 1)}</span><input type="number" value={exp[p.name]?.min ?? globalMin} onChange={e => sE(p.name, 'min', +e.target.value)} title="Min %" style={{ width: 32, flexShrink: 0 }} /><input type="number" value={exp[p.name]?.max ?? globalMax} onChange={e => sE(p.name, 'max', +e.target.value)} title="Max %" style={{ width: 32, flexShrink: 0 }} /></div>)}</div>
    <button className="btn btn-primary" onClick={run} disabled={!canBuild}
      title={canBuild ? '' : `Edit at least 2 projections on the DK Projections tab first (${overrideCount}/2 changed)`}
      style={!canBuild ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}>
      <Icon name="bolt" size={14}/> Build {nL} {isShowdown ? 'Showdown' : ''} Lineups{contrarianOn ? ' (Contrarian)' : ''}
    </button>
    {res && <ExposureResults res={res} ownership={ownership} onRebuild={run} onExportDK={exportDK} onExportReadable={exportReadable} nL={nL} canBuild={canBuild} overrideCount={overrideCount} />}
  </>);
}

function ExposureResults({ res, ownership, onRebuild, onExportDK, onExportReadable, nL, canBuild = true, overrideCount = 2 }) {
  const expData = useMemo(() => res.pData.map((p, i) => {
    const cnt = res.counts[i]; const pct = cnt / res.lineups.length * 100;
    const simOwn = ownership[p.name] || 0; const lev = Math.round((pct - simOwn) * 10) / 10;
    const val = p.projection / (p.salary / 1000);
    return { name: p.name, salary: p.salary, projection: p.projection, val, cnt, pct, simOwn, lev };
  }), [res, ownership]);
  const avgSal = Math.round(res.lineups.reduce((s, lu) => s + lu.sal, 0) / res.lineups.length);
  const projMax = res.lineups.length ? Math.max(...res.lineups.map(lu => lu.proj)) : 0;
  const projMin = res.lineups.length ? Math.min(...res.lineups.map(lu => lu.proj)) : 0;
  const { sorted, sortKey, sortDir, toggleSort } = useSort(expData, 'pct', 'desc');
  const S = p => <SH {...p} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />;
  return (<>
    <div style={{ marginTop: 20, padding: '10px 14px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13, color: 'var(--text-muted)' }}><Icon name="check" size={14} color="#22C55E"/> Built <span style={{ color: 'var(--primary-glow)', fontWeight: 700 }}>{res.lineups.length}</span> lineups from {res.total.toLocaleString()} valid · Range: <span style={{ color: 'var(--green)' }}>{projMax}</span> → <span style={{ color: 'var(--text-dim)' }}>{projMin}</span> · Avg Salary: <span style={{ color: 'var(--primary-glow)', fontWeight: 600 }}>${avgSal.toLocaleString()}</span></div>
    <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
      {onRebuild && <button className="btn btn-primary" onClick={onRebuild} disabled={!canBuild}
        title={canBuild ? '' : `Edit at least 2 projections first (${overrideCount}/2 changed)`}
        style={{ flex: '1 1 auto', width: 'auto', ...(canBuild ? {} : { opacity: 0.4, cursor: 'not-allowed' }) }}><Icon name="bolt" size={14}/> Rebuild {nL}</button>}
      {onExportDK && <button className="btn btn-primary" onClick={onExportDK} style={{ flex: '1 1 auto', width: 'auto', background: 'linear-gradient(135deg, #15803D, #22C55E)' }}><Icon name="download" size={14}/> Download DK Upload CSV</button>}
      {onExportReadable && <button className="btn btn-outline" onClick={onExportReadable} style={{ flex: '1 1 auto', width: 'auto', marginTop: 0 }}><Icon name="download" size={14}/> Readable CSV</button>}
    </div>
    <div className="section-head" style={{ marginTop: 20 }}><Icon name="chart" size={16} color="#F5C518"/> Exposure</div>
    <div className="table-wrap" style={{ marginBottom: 20 }}><table><thead><tr>
      <S label="Player" colKey="name" /><S label="Salary" colKey="salary" /><S label="Proj" colKey="projection" /><S label="Value" colKey="val" /><S label="Count" colKey="cnt" /><S label="Exposure" colKey="pct" /><S label="Sim Own" colKey="simOwn" /><S label="Leverage" colKey="lev" />
    </tr></thead>
    <tbody>{sorted.map(p => <tr key={p.name}><td className="name">{p.name}</td><td className="num">${p.salary.toLocaleString()}</td><td className="num">{fmt(p.projection, 1)}</td><td className="num">{fmt(p.val, 2)}</td><td className="num">{p.cnt}</td><td><span className="exp-bar-bg"><span className="exp-bar" style={{ width: Math.min(p.pct, 100) + '%' }} /></span>{fmt(p.pct, 1)}%</td><td className="num muted">{fmt(p.simOwn, 1)}%</td><td className="num"><span style={{ color: p.lev > 0 ? 'var(--green)' : p.lev < 0 ? 'var(--red)' : 'var(--text-dim)', fontWeight: Math.abs(p.lev) > 10 ? 700 : 400 }}>{p.lev > 0 ? '+' : ''}{fmt(p.lev, 1)}%</span></td></tr>)}</tbody></table></div>
    <div className="section-head"><Icon name="target" size={16} color="#F5C518"/> Lineups</div>
    <div className="lineup-grid">{res.lineups.slice(0, 30).map((lu, idx) => {
      if (res.isShowdown) {
        // Showdown: render in CPT → A-CPT → FLEX order with role badge + tier salary + multiplied projection
        const slots = [
          { role: 'CPT',   p: res.pData[lu.cpt],  sal: res.pData[lu.cpt].cpt_salary,   mult: 1.5,  color: '#F5C518' },
          { role: 'A-CPT', p: res.pData[lu.acpt], sal: res.pData[lu.acpt].acpt_salary, mult: 1.25, color: '#C084FC' },
          { role: 'FLEX',  p: res.pData[lu.flex], sal: res.pData[lu.flex].flex_salary, mult: 1.0,  color: 'var(--text-muted)' },
        ];
        return <div className="lu-card" key={idx}>
          <div className="lu-header"><span>#{idx + 1}</span><span className="lu-proj">{lu.proj} pts</span></div>
          {slots.map(s => <div className="lu-row" key={s.role}>
            <span style={{ fontSize: 10, fontWeight: 700, color: s.color, width: 44, flexShrink: 0, letterSpacing: 0.5 }}>{s.role}</span>
            <span className="lu-name">{s.p.name}</span>
            <span className="lu-opp">vs {s.p.opponent}</span>
            <span className="lu-sal">${s.sal.toLocaleString()}</span>
            <span className="lu-pts">{fmt(s.p.projection * s.mult, 1)}</span>
          </div>)}
          <div className="lu-footer"><span>${lu.sal.toLocaleString()}</span><span>{lu.proj}</span></div>
        </div>;
      }
      // Classic: unchanged
      const ps = lu.players.map(i => res.pData[i]).sort((a, b) => b.salary - a.salary);
      return <div className="lu-card" key={idx}><div className="lu-header"><span>#{idx + 1}</span><span className="lu-proj">{lu.proj} pts</span></div>{ps.map(p => <div className="lu-row" key={p.name}><span className="lu-name">{p.name}</span><span className="lu-opp">vs {p.opponent}</span><span className="lu-sal">${p.salary.toLocaleString()}</span><span className="lu-pts">{fmt(p.projection, 1)}</span></div>)}<div className="lu-footer"><span>${lu.sal.toLocaleString()}</span><span>{lu.proj}</span></div></div>;
    })}</div>
    {res.lineups.length > 30 && <div style={{ textAlign: 'center', color: 'var(--text-dim)', fontSize: 13, marginTop: 8 }}>+ {res.lineups.length - 30} more</div>}
  </>);
}

function TrackRecordTab({ sport }) {
  const [data, setData] = useState(null);
  const [loadState, setLoadState] = useState('loading');
  useEffect(() => {
    setLoadState('loading');
    fetch(`/results/${sport}/aggregated.json`)
      .then(r => { if (!r.ok) throw new Error('no file'); return r.json(); })
      .then(j => { setData(j); setLoadState((j && j.slates_tracked > 0) ? 'loaded' : 'empty'); })
      .catch(() => setLoadState('empty'));
  }, [sport]);

  const hero = (
    <div className="section-hero">
      <div className="section-hero-icon-wrap">
        <svg className="section-hero-icon" viewBox="0 0 24 24" fill="none" stroke="#F5C518">
          <path d="M3 3v18h18"/>
          <path d="M7 15l4-5 4 3 6-8"/>
        </svg>
      </div>
      <div className="section-hero-text">
        <h2 className="section-hero-title">Track Record</h2>
        <div className="section-hero-sub">{loadState === 'loaded' ? `${data.slates_tracked} ${sport === 'tennis' ? 'tennis' : 'UFC'} slate${data.slates_tracked === 1 ? '' : 's'} tracked · sorted by profitability` : 'How each tag has performed across completed slates'}</div>
      </div>
    </div>
  );

  if (loadState === 'loading') {
    return <>{hero}<div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-dim)', fontSize: 13 }}>Loading track record...</div></>;
  }

  if (loadState === 'empty') {
    return (<>
      {hero}
      <div style={{ padding: '48px 24px', textAlign: 'center', background: 'var(--card)', border: '1px dashed var(--border)', borderRadius: 10 }}>
        <div style={{ display: 'inline-flex', marginBottom: 14, padding: 14, background: 'rgba(245,197,24,0.06)', border: '1px solid rgba(245,197,24,0.2)', borderRadius: '50%' }}>
          <Icon name="chart-line" size={28} color="#F5C518"/>
        </div>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>No completed slates yet</div>
        <div style={{ fontSize: 13, maxWidth: 520, margin: '0 auto', lineHeight: 1.65, color: 'var(--text-muted)' }}>
          Track Record populates as you upload DK contest CSVs from completed slates. Every <strong style={{color:'var(--primary)'}}>Top Value</strong>, <strong style={{color:'var(--primary)'}}>Hidden Gem</strong>, <strong style={{color:'var(--primary)'}}>Biggest Trap</strong>, and <strong style={{color:'var(--primary)'}}>PP Edge/Fade</strong> call gets graded — hit rates compound into actionable patterns over time.
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 18, fontFamily: 'monospace' }}>Expected path: <span style={{color:'var(--text-muted)'}}>public/results/{sport}/aggregated.json</span></div>
      </div>
    </>);
  }

  // LOADED — render categories table + insight
  const rateFor = c => c.type === 'bust_rate' ? c.bust_rate : (c.type === 'reversal' ? Math.max(c.hit_rate || 0, c.reverse_rate || 0) : c.hit_rate);
  const sorted = [...(data.categories || [])].sort((a, b) => rateFor(b) - rateFor(a));
  const sigColor = s => s === 'follow' ? 'var(--green-text)' : s === 'fade' ? 'var(--red-text)' : s === 'counter' ? 'var(--amber-text)' : 'var(--text-muted)';
  const sigBg = s => s === 'follow' ? 'rgba(74,222,128,0.12)' : s === 'fade' ? 'rgba(248,113,113,0.12)' : s === 'counter' ? 'rgba(251,191,36,0.12)' : 'rgba(156,163,175,0.1)';
  const sigLabel = s => s === 'follow' ? 'FOLLOW' : s === 'fade' ? 'FADE' : s === 'counter' ? 'COUNTER' : 'NEUTRAL';

  return (<>
    {hero}
    {data.data_status === 'preview' && (
      <div style={{ padding: '10px 14px', background: 'rgba(245,197,24,0.08)', border: '1px solid rgba(245,197,24,0.3)', borderRadius: 8, marginBottom: 16, fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <Icon name="warning" size={14} color="#F5C518"/>
        <span><strong style={{ color: 'var(--primary)' }}>Preview data</strong> — this is illustrative. Real tracking begins when you ship <code style={{ background: 'var(--bg)', padding: '2px 6px', borderRadius: 3, fontSize: 11 }}>public/results/{sport}/aggregated.json</code> with actual results.</span>
      </div>
    )}
    {data.featured_insight && (
      <div style={{ padding: '16px 18px', background: 'linear-gradient(135deg, rgba(245,197,24,0.1), rgba(245,197,24,0.02))', border: '1px solid rgba(245,197,24,0.35)', borderRadius: 10, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <Icon name="flame" size={18} color="#F5C518"/>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#F5C518' }}>Pattern of Note</span>
        </div>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#F8FAFC', marginBottom: 6, letterSpacing: '-0.01em', lineHeight: 1.3 }}>{data.featured_insight.headline}</div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.55 }}>{data.featured_insight.detail}</div>
      </div>
    )}
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th style={{ width: 28 }}></th>
            <th>Tag</th>
            <th>N</th>
            <th>Rate</th>
            <th>Edge</th>
            <th>Signal</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(cat => {
            const primary = rateFor(cat);
            const rateLbl = cat.type === 'bust_rate' ? 'bust' : 'hit';
            const edge = cat.counter_edge != null ? cat.counter_edge : cat.avg_edge;
            const edgeLbl = cat.counter_edge != null ? `${cat.edge_units} (counter-play)` : cat.edge_units;
            return (
              <tr key={cat.key}>
                <td><Icon name={cat.icon} size={16} color="#F5C518"/></td>
                <td className="name">
                  <div>{cat.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', fontWeight: 400, marginTop: 2 }}>{cat.description}</div>
                </td>
                <td className="num muted">{cat.n}</td>
                <td className="num">
                  <div style={{ fontWeight: 700, color: primary >= 0.55 ? 'var(--green-text)' : primary <= 0.45 ? 'var(--red-text)' : 'var(--text)' }}>
                    {(primary * 100).toFixed(1)}% <span style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 400 }}>{rateLbl}</span>
                  </div>
                  {cat.type === 'reversal' && (
                    <div style={{ fontSize: 10, color: 'var(--amber-text)', marginTop: 2, fontWeight: 600 }}>
                      reverses {(cat.reverse_rate * 100).toFixed(0)}%
                    </div>
                  )}
                </td>
                <td className="num">
                  <span style={{ fontWeight: 600, color: edge > 0 ? 'var(--green-text)' : edge < 0 ? 'var(--red-text)' : 'var(--text-muted)' }}>
                    {edge > 0 ? '+' : ''}{edge.toFixed(Math.abs(edge) < 1 ? 2 : 1)}
                  </span>
                  <div style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 400, marginTop: 2 }}>{edgeLbl}</div>
                </td>
                <td>
                  <span style={{ display: 'inline-block', padding: '3px 10px', borderRadius: 4, fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', color: sigColor(cat.signal), background: sigBg(cat.signal), border: `1px solid ${sigColor(cat.signal)}` }}>
                    {sigLabel(cat.signal)}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  </>);
}

function LeverageTab({ players: rp }) {
  const [cd, setCd] = useState(null); const [ul, setUl] = useState(null); const [err, setErr] = useState('');
  const handleContest = e => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = evt => { try { const lines = evt.target.result.split('\n'); const own = {}; let ec = 0; for (const line of lines) { if (line.includes(',') && rp.some(p => line.includes(p.name))) { ec++; for (const p of rp) { if (line.includes(p.name)) own[p.name] = (own[p.name] || 0) + 1; } } } if (ec > 0) { const op = {}; for (const [n, c] of Object.entries(own)) op[n] = Math.round(c / ec * 1000) / 10; setCd(op); setErr(''); } else setErr('No player data found in CSV'); } catch (e) { setErr(e.message); } }; r.readAsText(f); };
  const handleUser = e => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = evt => { try { const lines = evt.target.result.split('\n'); const cnt = {}; let lc = 0; for (const line of lines) { if (!line.trim() || line.startsWith('P,') || line.startsWith('Rank')) continue; const hasP = rp.some(p => line.includes(p.name) || line.includes(String(p.id))); if (hasP) { lc++; for (const p of rp) { if (line.includes(p.name) || line.includes(String(p.id))) cnt[p.name] = (cnt[p.name] || 0) + 1; } } } if (lc > 0) { const ep = {}; for (const [n, c] of Object.entries(cnt)) ep[n] = Math.round(c / lc * 1000) / 10; setUl({ counts: ep, total: lc }); } } catch (e) { setErr(e.message); } }; r.readAsText(f); };
  const ld = useMemo(() => { if (!cd || !ul) return []; return rp.filter(p => p.salary > 0).map(p => ({ name: p.name, salary: p.salary, proj: p.proj, val: p.val, userExp: ul.counts[p.name] || 0, fieldOwn: cd[p.name] || 0, leverage: Math.round(((ul.counts[p.name] || 0) - (cd[p.name] || 0)) * 10) / 10, opponent: p.opponent })).sort((a, b) => b.leverage - a.leverage); }, [cd, ul, rp]);
  return (<>
    <div className="section-hero">
      <div className="section-hero-icon-wrap">
        <svg className="section-hero-icon" viewBox="0 0 24 24" fill="none" stroke="#F5C518">
          <path d="M3 12a9 9 0 0 1 15-6.7L21 8"/>
          <path d="M21 3v5h-5"/>
          <path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>
          <path d="M3 21v-5h5"/>
        </svg>
      </div>
      <div className="section-hero-text">
        <h2 className="section-hero-title">Live Leverage</h2>
        <div className="section-hero-sub">Upload contest CSV + your lineups to compare vs the field</div>
      </div>
    </div>
    <div style={{ display: 'flex', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
      <div className="metric" style={{ flex: 1, minWidth: 250 }}><div className="metric-label">Step 1: Contest CSV</div><div className="metric-sub" style={{ marginTop: 4 }}>DK contest file after lock</div><input type="file" accept=".csv" onChange={handleContest} style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }} />{cd && <div style={{ color: 'var(--green)', fontSize: 12, marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}><Icon name="check" size={12} color="var(--green)"/> {Object.keys(cd).length} players</div>}</div>
      <div className="metric" style={{ flex: 1, minWidth: 250 }}><div className="metric-label">Step 2: Your Lineups</div><div className="metric-sub" style={{ marginTop: 4 }}>Your DK upload or readable CSV</div><input type="file" accept=".csv" onChange={handleUser} style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }} />{ul && <div style={{ color: 'var(--green)', fontSize: 12, marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}><Icon name="check" size={12} color="var(--green)"/> {ul.total} lineups</div>}</div>
    </div>
    {err && <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="warning" size={14} color="var(--red)"/> {err}</div>}
    {ld.length > 0 && <>
      <div className="metrics">
        <div className="metric"><div className="metric-label"><Icon name="gem" size={13}/> Top Leverage</div><div className="metric-value" style={{ color: 'var(--green-text)' }}>{ld[0]?.name}</div><div className="metric-sub">You: {ld[0]?.userExp}% · Field: {ld[0]?.fieldOwn}% · +{ld[0]?.leverage}%</div></div>
        <div className="metric"><div className="metric-label"><Icon name="bomb" size={13}/> Most Underweight</div><div className="metric-value" style={{ color: 'var(--red-text)' }}>{ld[ld.length - 1]?.name}</div><div className="metric-sub">You: {ld[ld.length - 1]?.userExp}% · Field: {ld[ld.length - 1]?.fieldOwn}% · {ld[ld.length - 1]?.leverage}%</div></div>
      </div>
      <div className="table-wrap"><table><thead><tr><th>#</th><th></th><th>Player</th><th>Opp</th><th>Proj</th><th>Your Exp</th><th>Field Own</th><th>Leverage</th></tr></thead>
      <tbody>{ld.map((p, i) => <tr key={p.name} className={p.leverage > 10 ? 'row-hl-green' : p.leverage < -10 ? 'row-hl-red' : ''}><td className="muted">{i + 1}</td><td>{p.leverage > 10 ? <Tip icon="gem" label="Strong overweight" /> : p.leverage < -10 ? <Tip icon="bomb" label="Underweight" /> : ''}</td><td className="name">{p.name}</td><td className="muted">{p.opponent}</td><td className="num">{fmt(p.proj, 1)}</td><td className="num" style={{ color: 'var(--primary-glow)' }}>{fmt(p.userExp, 1)}%</td><td className="num muted">{fmt(p.fieldOwn, 1)}%</td><td className="num"><span style={{ color: p.leverage > 0 ? 'var(--green)' : p.leverage < 0 ? 'var(--red)' : 'var(--text-dim)', fontWeight: Math.abs(p.leverage) > 10 ? 700 : 500, background: Math.abs(p.leverage) > 15 ? (p.leverage > 0 ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.12)') : 'transparent', padding: '2px 8px', borderRadius: 4 }}>{p.leverage > 0 ? '+' : ''}{fmt(p.leverage, 1)}%</span></td></tr>)}</tbody></table></div>
    </>}
    {!cd && !ul && <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-dim)' }}><div style={{ marginBottom: 8, color: 'var(--text-muted)' }}><Icon name="refresh" size={32}/></div><div style={{ fontSize: 14 }}>Upload both CSVs to see leverage vs field</div></div>}
  </>);
}

// ═══════════════════════════════════════════════════════════════════════
// MMA COMPONENTS — NEW
// ═══════════════════════════════════════════════════════════════════════
function MMADKTab({ fighters, fc, own, onOverride, overrides }) {
  const pw = useMemo(() => fighters.filter(p => p.salary > 0).map(p => ({ ...p, simOwn: own[p.name] || 0 })), [fighters, own]);
  const { sorted, sortKey, sortDir, toggleSort } = useSort(pw, 'proj', 'desc');
  const t3v = useMemo(() => [...fighters].sort((a, b) => b.val - a.val).slice(0, 3).map(p => p.name), [fighters]);
  const t3f = useMemo(() => [...fighters].sort((a, b) => b.finishUpside - a.finishUpside).slice(0, 3).map(p => p.name), [fighters]);
  const trap = useMemo(() => {
    const hasOwn = pw.some(p => p.simOwn > 0);
    const s = hasOwn ? [...pw].sort((a, b) => b.simOwn - a.simOwn) : [...pw].sort((a, b) => b.proj - a.proj);
    return s[0]?.name || '';
  }, [pw]);
  // Hidden Gem — two-path logic:
  //   (1) If trap's opponent is +199 or better (wp >= 33.4%), they ARE the gem.
  //       In UFC, a fighter with realistic win path can flip result with a single
  //       finish — they come with the exact salary swap benefit too.
  //   (2) If trap's opponent is +200 or worse (wp < 33.4%), fall back to good-value
  //       high-ceiling player within -$1000/+$300 of trap's salary.
  const gem = useMemo(() => {
    const trapPlayer = pw.find(p => p.name === trap);
    if (!trapPlayer) return '';
    const opponent = pw.find(p => p.name === trapPlayer.opponent);
    if (opponent && (opponent.wp || 0) >= 0.334) return opponent.name;
    const trapSal = trapPlayer.salary;
    const candidates = pw.filter(p => {
      if (p.name === trap) return false;
      const diff = p.salary - trapSal;
      return diff >= -1000 && diff <= 300;
    });
    if (candidates.length === 0) return '';
    const scored = candidates.map(p => {
      const ceil = p.ceil || p.proj;
      const val = ceil / (p.salary / 1000);
      return { name: p.name, s: val * ceil };
    }).sort((a, b) => b.s - a.s);
    return scored[0]?.name || '';
  }, [pw, trap]);
  const S = p => <SH {...p} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />;
  return (<>
    <div className="metrics">
      <div className="metric"><div className="metric-label"><Icon name="trophy" size={13}/> Top Value</div><div className="metric-value">{t3v.map((n, i) => { const p = fighters.find(x => x.name === n); return <div key={i} style={{ fontSize: i === 0 ? '16px' : '13px', color: i === 0 ? undefined : 'var(--text-muted)' }}>{i + 1}. {n} <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{fmt(p?.val, 2)}</span></div>; })}</div></div>
      <div className="metric"><div className="metric-label"><Icon name="fist" size={13}/> Top Finish Path</div><div className="metric-value">{t3f.map((n, i) => { const p = fighters.find(x => x.name === n); return <div key={i} style={{ fontSize: i === 0 ? '16px' : '13px', color: i === 0 ? undefined : 'var(--text-muted)' }}>{n} <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{fmtPct(p?.finishProb)}</span></div>; })}</div></div>
      <div className="metric"><div className="metric-label"><Icon name="gem" size={13}/> Hidden Gem</div><div className="metric-value" style={{ color: 'var(--green-text)' }}>{gem || '-'}</div><div className="metric-sub">Low ownership, high ceiling</div></div>
      <div className="metric"><div className="metric-label"><Icon name="bomb" size={13}/> Biggest Trap</div><div className="metric-value" style={{ color: 'var(--red-text)' }}>{trap || '-'}</div><div className="metric-sub">High ownership, low ceiling</div></div>
    </div>
    <div className="table-wrap"><table><thead><tr>
      <th>#</th><th></th><S label="Fighter" colKey="name" /><th>Opp</th>
      <S label="Sal" colKey="salary" /><S label="Sim Own" colKey="simOwn" /><S label="Win%" colKey="wp" />
      <S label="Proj" colKey="proj" /><S label="Ceiling" colKey="ceil" /><S label="Finish%" colKey="finishProb" />
      <S label="Val" colKey="val" /><S label="CVal" colKey="cval" />
      <S label="SS" colKey="sigStr" /><S label="TD" colKey="takedowns" /><S label="CT" colKey="ctMin" />
      <th>Time</th>
    </tr></thead>
    <tbody>{sorted.map((p, i) => {
      const iv = t3v.includes(p.name), isf = t3f.includes(p.name), ig = p.name === gem, it = p.name === trap;
      const badges = [];
      if (iv)  badges.push({ icon: 'trophy', label: 'Top 3 Value' });
      if (isf) badges.push({ icon: 'fist',   label: 'Top 3 Finish Path' });
      if (ig)  badges.push({ icon: 'gem',    label: 'Hidden Gem' });
      if (it)  badges.push({ icon: 'bomb',   label: 'Trap' });
      const isOver = overrides && overrides[p.name] != null;
      return <tr key={p.name} className={ig ? 'row-hl-green' : it ? 'row-hl-red' : ''}>
        <td className="muted">{i + 1}</td>
        <td><span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>{badges.map((bd, j) => <Tip key={j} icon={bd.icon} label={bd.label} size={14} />)}</span></td>
        <td className="name">{p.name}</td><td className="muted">{p.opponent}</td>
        <td className="num">{fmtSal(p.salary)}</td>
        <td className="num" style={{ color: p.simOwn > 30 ? 'var(--amber)' : 'var(--text-muted)' }}>{fmt(p.simOwn, 1)}%</td>
        <td className="num">{fmtPct(p.wp)}</td>
        <td className="num">
          <span className={iv ? 'cell-top3' : 'cell-proj'}>
            <input type="number" step="0.1" className={`proj-edit ${isOver ? 'overridden' : ''}`}
              value={fmt(p.proj, 1)}
              onChange={e => onOverride && onOverride(p.name, e.target.value)}
              onDoubleClick={() => onOverride && onOverride(p.name, null)}
              title={isOver ? 'Overridden — double-click to reset. Ceiling scales proportionally.' : 'Click to edit projection'} />
          </span>
        </td>
        <td className="num"><span style={{ background: 'rgba(74,222,128,0.1)', color: 'var(--green)', padding: '4px 10px', borderRadius: 4, fontWeight: 600, minWidth: 50, display: 'inline-block', textAlign: 'center' }}>{fmt(p.ceil, 1)}</span></td>
        <td className="num" style={{ color: p.finishProb > 0.35 ? 'var(--primary)' : 'var(--text-muted)', fontWeight: p.finishProb > 0.35 ? 700 : 400 }}>{fmtPct(p.finishProb)}</td>
        <td className="num"><span className={iv ? 'cell-top3' : ''}>{fmt(p.val, 2)}</span></td>
        <td className="num" style={{ color: p.cval > 16 ? 'var(--green)' : undefined, fontWeight: p.cval > 16 ? 700 : 400 }}>{fmt(p.cval, 2)}</td>
        <td className="num">{fmt(p.sigStr)}</td><td className="num muted">{fmt(p.takedowns)}</td><td className="num">{fmt(p.ctMin)}</td>
        <td className="muted">{fmtTime(p.startTime)}</td>
      </tr>; })}</tbody></table></div>
  </>);
}

function MMAPPTab({ rows }) {
  const { sorted, sortKey, sortDir, toggleSort } = useSort(rows, 'ev', 'desc');
  const S = p => <SH {...p} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />;
  const best = useMemo(() => [...rows].sort((a, b) => b.ev - a.ev).slice(0, 3), [rows]);
  const worst = useMemo(() => [...rows].sort((a, b) => a.ev - b.ev).slice(0, 3), [rows]);
  return (<>
    <div className="section-hero">
      <div className="section-hero-icon-wrap">
        <svg className="section-hero-icon" viewBox="0 0 24 24" fill="none" stroke="#F5C518">
          <circle cx="12" cy="12" r="9"/>
          <circle cx="12" cy="12" r="5"/>
          <circle cx="12" cy="12" r="1.5" fill="#F5C518" stroke="none"/>
        </svg>
      </div>
      <div className="section-hero-text">
        <h2 className="section-hero-title">PrizePicks Projections</h2>
        <div className="section-hero-sub">All plays sorted by edge · Edge = Projected − PP Line</div>
      </div>
    </div>
    <div style={{ background: 'rgba(245,197,24,0.06)', border: '1px solid rgba(245,197,24,0.25)', borderRadius: 8, padding: '10px 14px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
      <Icon name="trending-down" size={18} color="#F5C518"/>
      <span style={{ color: 'var(--text-muted)' }}><strong style={{ color: 'var(--primary)', fontWeight: 700 }}>Hint:</strong> PrizePicks bad value will typically reverse</span>
    </div>
    <div className="metrics">
      <div className="metric"><div className="metric-label"><Icon name="flame" size={13}/> Best Edge</div><div className="metric-value">{best.map((r, i) => <div key={i} style={{ fontSize: i === 0 ? '16px' : '13px', color: i === 0 ? 'var(--green-text)' : 'var(--text-muted)', fontWeight: i === 0 ? 700 : 500 }}>{r.player} · {r.stat} <span style={{fontSize:11, color: i === 0 ? undefined : 'var(--text-dim)'}}>{r.ev > 0 ? '+' : ''}{fmt(r.ev, 2)}</span>{r.mult && <span style={{fontSize:10,color: i === 0 ? 'var(--amber-text)' : 'var(--text-dim)',marginLeft:4}}>{r.mult}</span>}</div>)}</div></div>
      <div className="metric"><div className="metric-label"><Icon name="trending-down" size={13}/> Biggest "Fades"</div><div className="metric-value">{worst.map((r, i) => <div key={i} style={{ fontSize: i === 0 ? '16px' : '13px', color: i === 0 ? 'var(--red-text)' : 'var(--text-muted)', fontWeight: i === 0 ? 700 : 500 }}>{r.player} · {r.stat} <span style={{fontSize:11, color: i === 0 ? undefined : 'var(--text-dim)'}}>{fmt(r.ev, 2)}</span></div>)}</div></div>
    </div>
    <div className="table-wrap"><table><thead><tr>
      <th>#</th><th></th><S label="Fighter" colKey="player" /><S label="Stat" colKey="stat" />
      <S label="PP Line" colKey="line" /><S label="Projected" colKey="projected" />
      <S label="Edge" colKey="ev" /><S label="Play" colKey="direction" />
      <th>Mult</th><S label="Win%" colKey="wp" /><S label="Opp" colKey="opponent" />
    </tr></thead>
    <tbody>{sorted.map((r, i) => {
      const isBest = best.some(t => t.player === r.player && t.stat === r.stat);
      const isWorst = worst.some(t => t.player === r.player && t.stat === r.stat);
      const playDir = r.direction;
      const isFT = r.stat === 'Fight Time';
      return <tr key={r.player + r.stat} className={isBest ? 'row-hl-green' : isWorst ? 'row-hl-red' : ''}>
        <td className="muted">{i+1}</td>
        <td>{isBest ? <Tip icon="flame" label="Best edge" /> : isWorst ? <Tip icon="trending-down" label="Fade" /> : ''}</td>
        <td className="name">{r.player}</td>
        <td style={{fontSize:11,color:'var(--text-muted)'}}>{r.stat}</td>
        <td className="num">{fmt(r.line, 2)}{isFT && <span style={{ fontSize: 10, color: 'var(--text-dim)', marginLeft: 2 }}>m</span>}</td>
        <td className="num"><span className="cell-proj">{fmt(r.projected, 2)}{isFT && <span style={{ fontSize: 10, color: 'var(--text-dim)', marginLeft: 2 }}>m</span>}</span></td>
        <td className="num"><span className={isBest ? 'cell-ev-top' : isWorst ? 'cell-ev-worst' : r.ev > 0 ? 'cell-ev-pos' : 'cell-ev-neg'}>{r.ev > 0 ? '+' : ''}{fmt(r.ev, 2)}</span></td>
        <td><span style={{color: playDir === 'MORE' ? 'var(--green-text)' : playDir === 'LESS' ? 'var(--red-text)' : 'var(--text-dim)', fontWeight:600}}>{playDir}</span></td>
        <td style={{color:'var(--amber-text)',fontSize:11}}>{r.mult || ''}</td>
        <td className="num muted">{fmtPct(r.wp)}</td>
        <td className="muted">{r.opponent}</td>
      </tr>;
    })}</tbody></table></div>
  </>);
}

function MMABuilderTab({ fighters: rp, ownership }) {
  const [exp, setExp] = useState({}); const [res, setRes] = useState(null);
  const [nL, setNL] = useState(150);
  const [variance, setVariance] = useState(2);                // ±% jitter on projections per build
  const [globalMax, setGlobalMax] = useState(100); const [globalMin, setGlobalMin] = useState(0);
  const [mode, setMode] = useState('ceiling');  // ceiling=GPP, proj=cash
  const [contrarianOn, setContrarianOn] = useState(false);
  const [contrarianStrength, setContrarianStrength] = useState(0.6);

  const avgVal = useMemo(() => {
    const vals = rp.filter(p => p.salary > 0).map(p => (mode === 'ceiling' ? p.cval : p.val) || 0);
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 7;
  }, [rp, mode]);
  // CONTRARIAN MODE (MMA) — same design as tennis
  const contrarianCaps = useMemo(() => {
    if (!contrarianOn) return {};
    const withSal = rp.filter(p => p.salary > 0);
    if (withSal.length === 0) return {};
    const caps = {};
    const valKey = mode === 'ceiling' ? 'cval' : 'val';
    const projKey = mode === 'ceiling' ? 'ceil' : 'proj';

    const byProj = [...withSal].sort((a, b) => (b[projKey] || 0) - (a[projKey] || 0));
    const topProjN = Math.max(3, Math.ceil(withSal.length * 0.3));
    const topProjSet = new Set(byProj.slice(0, topProjN).map(p => p.name));

    const boostFloor = Math.round(10 + contrarianStrength * 10);
    const LEV_CAP = 30;

    // TRAP — highest-owned player (matches DK tab). Stars can be trap too.
    const hasOwn = withSal.some(p => (ownership[p.name] || 0) > 0);
    const trap = hasOwn
      ? [...withSal].sort((a, b) => (ownership[b.name] || 0) - (ownership[a.name] || 0))[0]
      : byProj[0];
    if (trap) {
      const trapFieldOwn = ownership[trap.name] || 0;
      const maxCap = Math.max(5, Math.round(trapFieldOwn - contrarianStrength * 50));
      caps[trap.name] = { max: maxCap, _isTrap: true };
    }

    // STUD — overowned star with worst value (most "DK-overpriced chalky star")
    const overownedStars = withSal.filter(p => {
      if (p.name === trap?.name) return false;
      if (!topProjSet.has(p.name)) return false;
      const fieldOwn = ownership[p.name] || 0;
      const fairOwn = computeFairOwn(p[valKey] || 0, avgVal);
      return fieldOwn > fairOwn + 5 && fieldOwn >= 25;
    });
    const stud = overownedStars.sort((a, b) => (a[valKey] || 0) - (b[valKey] || 0))[0];
    if (stud) {
      const fieldOwn = Math.round(ownership[stud.name] || 0);
      caps[stud.name] = {
        min: Math.min(85, fieldOwn + boostFloor),
        max: Math.min(95, fieldOwn + LEV_CAP),
        _isBoost: true, _leverage: boostFloor, _type: 'stud'
      };
    }

    // GEM — salary substitute for trap (-$1000 to +$300 band)
    const trapSal = trap?.salary ?? 0;
    const inBand = (p, lo, hi) => (p.salary - trapSal) >= lo && (p.salary - trapSal) <= hi;
    const salaryEligible = trap ? withSal.filter(p => {
      if (p.name === trap.name || p.name === stud?.name) return false;
      return inBand(p, -1000, 300);
    }) : [];
    const sameBandBadVal = salaryEligible.filter(p => (p[valKey] || 0) < avgVal);
    const strictGem = sameBandBadVal
      .filter(p => (ownership[p.name] || 0) < computeFairOwn(p[valKey] || 0, avgVal))
      .sort((a, b) => (b[projKey] || 0) - (a[projKey] || 0))[0];
    const goodValUnderowned = salaryEligible
      .filter(p => (p[valKey] || 0) >= avgVal && (ownership[p.name] || 0) < computeFairOwn(p[valKey] || 0, avgVal) - 3)
      .sort((a, b) => (b[projKey] || 0) - (a[projKey] || 0))[0];
    const badValFallback = sameBandBadVal.sort((a, b) => {
      const aGap = computeFairOwn(a[valKey] || 0, avgVal) - (ownership[a.name] || 0);
      const bGap = computeFairOwn(b[valKey] || 0, avgVal) - (ownership[b.name] || 0);
      if (Math.abs(bGap - aGap) > 1) return bGap - aGap;
      return (b[projKey] || 0) - (a[projKey] || 0);
    })[0];
    const lowOwnFallback = salaryEligible
      .sort((a, b) => (ownership[a.name] || 0) - (ownership[b.name] || 0))[0];
    const widerPool = (!strictGem && !goodValUnderowned && !badValFallback && !lowOwnFallback && trap)
      ? withSal.filter(p => p.name !== trap.name && p.name !== stud?.name && inBand(p, -1500, 500))
      : [];
    const widerFallback = widerPool.sort((a, b) => (ownership[a.name] || 0) - (ownership[b.name] || 0))[0];
    const gem = strictGem || goodValUnderowned || badValFallback || lowOwnFallback || widerFallback;
    if (gem) {
      const fieldOwn = Math.round(ownership[gem.name] || 0);
      caps[gem.name] = {
        min: Math.min(85, fieldOwn + boostFloor),
        max: Math.min(95, fieldOwn + LEV_CAP),
        _isBoost: true, _leverage: boostFloor, _type: 'gem'
      };
    }

    // LEVERAGE CAP + GLOBAL FLOOR (selective — only cap meaningfully-owned players)
    const globalFloor = Math.round(1 + contrarianStrength * 7);
    withSal.forEach(p => {
      const fieldOwn = Math.round(ownership[p.name] || 0);
      if (caps[p.name]) return;
      const maxCap = fieldOwn >= 15 ? Math.min(95, fieldOwn + LEV_CAP) : 100;
      caps[p.name] = { min: globalFloor, max: maxCap, _isFloor: true };
    });

    return caps;
  }, [rp, ownership, contrarianOn, contrarianStrength, mode, avgVal]);

  const adjRp = rp;

  const sortField = mode === 'ceiling' ? 'cval' : 'val';
  const sp = useMemo(() => [...adjRp].filter(p => p.salary > 0).sort((a, b) => b[sortField] - a[sortField]), [adjRp, sortField]);
  const sE = (n, f, v) => setExp(p => ({ ...p, [n]: { ...p[n], [f]: v } }));
  const applyGlobal = () => { const ne = {}; sp.forEach(p => { ne[p.name] = { min: globalMin, max: globalMax, ...exp[p.name] }; }); setExp(ne); };
  const run = () => {
    if (!canBuild) return;                      // DK compliance gate
    // Variance jitter: each build applies a fresh ±variance% random multiplier. Same mult to proj AND ceiling
    // per fighter so their ratio stays consistent (matters because cash mode uses proj, GPP uses ceiling).
    const jitter = () => 1 + (Math.random() * 2 - 1) * variance / 100;
    // DK anti-abuse: guarantee ≥2 projections differ from baseline by ≥0.01 even at variance=0.
    const enforceMinNudge = (pd, basePd, key) => {
      const changed = pd.filter((p, i) => Math.abs(p[key] - basePd[i][key === 'projection' ? 'proj' : 'ceil']) >= 0.01).length;
      if (changed >= 2) return;
      const idxs = [...Array(pd.length).keys()].sort(() => Math.random() - 0.5).slice(0, 2);
      idxs.forEach(i => {
        const sign = Math.random() < 0.5 ? -1 : 1;
        pd[i][key] = Math.round((pd[i][key] + sign * 0.01) * 1000) / 1000;
      });
    };
    const pd = sp.map(p => {
      const cap = contrarianCaps[p.name] || {};
      const userSet = exp[p.name] || {};
      // Contrarian is MORE-RESTRICTIVE than user: lifts user.min, lowers user.max
      const userMin = userSet.min !== undefined ? userSet.min : globalMin;
      const userMax = userSet.max !== undefined ? userSet.max : globalMax;
      const effMin = Math.max(userMin, cap.min || 0);
      const effMax = Math.min(userMax, cap.max !== undefined ? cap.max : 100);
      const m = jitter();      // same multiplier for proj + ceiling per fighter
      return {
        name: p.name, salary: p.salary, id: p.id,
        projection: p.proj * m, ceiling: p.ceil * m,
        opponent: p.opponent,
        maxExp: effMax, minExp: effMin
      };
    });
    // Nudge whichever key the optimizer actually ranks on for this mode
    enforceMinNudge(pd, sp, mode === 'ceiling' ? 'ceiling' : 'projection');
    const r = optimizeMMA(pd, nL, 50000, 6, mode, 48000);
    setRes({ ...r, pData: pd, mode });
  };
  const overrideCount = useMemo(() => rp.filter(p => p._overridden).length, [rp]);
  const canBuild = overrideCount >= 2;
  const dl = (c, f) => { const b = new Blob([c], { type: 'text/csv' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = f; a.click(); URL.revokeObjectURL(a.href); };
  const exportDK = () => { if (!res) return; let c = 'F,F,F,F,F,F\n'; res.lineups.forEach(lu => { const ps = lu.players.map(i => res.pData[i]).sort((a, b) => b.salary - a.salary); c += ps.map(p => p.id).join(',') + '\n'; }); dl(c, 'dk_upload_ufc.csv'); };
  const exportReadable = () => { if (!res) return; let c = 'Rank,Score,Salary,F1,F2,F3,F4,F5,F6\n'; res.lineups.forEach((lu, i) => { const ps = lu.players.map(j => res.pData[j]).sort((a, b) => b.salary - a.salary); c += `${i + 1},${lu.proj},${lu.sal},${ps.map(p => p.name).join(',')}\n`; }); dl(c, 'lineups_ufc.csv'); };
  const exportProjections = () => { let c = 'Fighter,Salary,Win%,Median,Ceiling,Val,CVal,Finish%,SigStr,TDs,CT,Opp\n'; sp.forEach(p => { c += `${p.name},${p.salary},${(p.wp * 100).toFixed(0)}%,${p.proj},${p.ceil},${p.val},${p.cval},${(p.finishProb*100).toFixed(0)}%,${fmt(p.sigStr)},${fmt(p.takedowns)},${fmt(p.ctMin)},${p.opponent}\n`; }); dl(c, 'projections_ufc.csv'); };

  return (<>
    <div className="section-hero">
      <div className="section-hero-icon-wrap">
        <svg className="section-hero-icon" viewBox="0 0 24 24" fill="#F5C518" stroke="none">
          <path d="M13 2L4 14h7l-1 8 10-12h-7l1-8z"/>
        </svg>
      </div>
      <div className="section-hero-text">
        <h2 className="section-hero-title">Lineup Builder</h2>
        <div className="section-hero-sub">Set exposure %, build optimized lineups, export to DK</div>
      </div>
    </div>
    <div className="section-sub">UFC: 6 fighters, $50K cap · No opponent-vs-opponent enforced · Export to DK</div>
    {!canBuild && (
      <div style={{ padding: '14px 18px', marginBottom: 16, background: 'rgba(245,197,24,0.08)', border: '1px solid rgba(245,197,24,0.35)', borderRadius: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--primary)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="warning" size={15} color="#F5C518"/> DraftKings Compliance Warning</div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          DraftKings policies require you to make some changes to our default projections before you can build lineups.
          Head to the <strong style={{ color: 'var(--text)' }}>DK Projections</strong> tab and edit at least <strong style={{ color: 'var(--primary)' }}>2 projections</strong> by any amount — this proves the lineups are your own work, not a shared export.
          <span style={{ color: 'var(--text-dim)' }}> Currently changed: <strong style={{ color: overrideCount >= 2 ? 'var(--green)' : 'var(--red)' }}>{overrideCount}</strong>/2</span>
        </div>
      </div>
    )}
    <ContrarianPanel enabled={contrarianOn} onToggle={setContrarianOn} strength={contrarianStrength} onStrengthChange={setContrarianStrength} />
    {contrarianOn && Object.keys(contrarianCaps).length > 0 && (() => {
      const trapEntry = Object.entries(contrarianCaps).find(([, c]) => c._isTrap);
      const boostEntries = Object.entries(contrarianCaps).filter(([, c]) => c._isBoost).sort((a, b) => (a[1]._rank || 0) - (b[1]._rank || 0));
      const floorEntry = Object.entries(contrarianCaps).find(([, c]) => c._isFloor);
      const floorCount = Object.values(contrarianCaps).filter(c => c._isFloor).length;
      return (
        <div style={{ marginTop: -12, marginBottom: 16, padding: '10px 14px', background: 'rgba(245,197,24,0.06)', border: '1px solid rgba(245,197,24,0.2)', borderRadius: 8, fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          {trapEntry && <span><Icon name="bomb" size={12} color="var(--red)"/> Fading <span style={{ color: 'var(--red)', fontWeight: 600 }}>{trapEntry[0]}</span> · field {(ownership[trapEntry[0]] || 0).toFixed(1)}% → max <span style={{ color: 'var(--primary)', fontWeight: 600 }}>{trapEntry[1].max}%</span></span>}
          {boostEntries.map(([name, c]) => (
            <span key={name}>{c._type === 'stud' ? <><Icon name="trophy" size={12}/> Stud</> : <><Icon name="gem" size={12}/> Gem</>} <span style={{ color: 'var(--green)', fontWeight: 600 }}>{name}</span> · field {(ownership[name] || 0).toFixed(1)}% +<span style={{ color: 'var(--primary)', fontWeight: 600 }}>{c._leverage}pp</span> → <span style={{ color: 'var(--primary)', fontWeight: 600 }}>{c.min}-{c.max}%</span></span>
          ))}
          {floorEntry && <span><Icon name="link" size={12} color="var(--text-muted)"/> {floorCount} other{floorCount === 1 ? '' : 's'} · floor <span style={{ color: 'var(--primary)', fontWeight: 600 }}>{floorEntry[1].min}%</span> · chalk capped <span style={{ color: 'var(--primary)', fontWeight: 600 }}>+30pp</span></span>}
        </div>
      );
    })()}
    <div style={{ display: 'flex', gap: 12, marginBottom: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      <div style={{ display: 'flex', background: 'var(--bg)', border: '1px solid var(--border-light)', borderRadius: 6, overflow: 'hidden' }}>
        <button onClick={() => setMode('proj')} style={{ background: mode === 'proj' ? 'var(--primary)' : 'transparent', color: mode === 'proj' ? '#0A1628' : 'var(--text-muted)', border: 'none', padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="dollar" size={13}/> Cash (median)</button>
        <button onClick={() => setMode('ceiling')} style={{ background: mode === 'ceiling' ? 'var(--primary)' : 'transparent', color: mode === 'ceiling' ? '#0A1628' : 'var(--text-muted)', border: 'none', padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="rocket" size={13}/> GPP (ceiling)</button>
      </div>
      <label style={{ fontSize: 13, color: 'var(--text-muted)' }}>Lineups: <input style={{ width: 60, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', padding: '4px 8px', marginLeft: 4 }} type="number" value={nL} onChange={e => setNL(+e.target.value)} /></label>
      <label style={{ fontSize: 13, color: 'var(--text-muted)' }}>Min %: <input style={{ width: 50, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', padding: '4px 8px', marginLeft: 4 }} type="number" value={globalMin} onChange={e => setGlobalMin(+e.target.value)} /></label>
      <label style={{ fontSize: 13, color: 'var(--text-muted)' }}>Max %: <input style={{ width: 50, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', padding: '4px 8px', marginLeft: 4 }} type="number" value={globalMax} onChange={e => setGlobalMax(+e.target.value)} /></label>
      <label style={{ fontSize: 13, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }} title="Random ± shift applied to each fighter's projection & ceiling per build. Guarantees two users on the same slate don't submit identical lineups.">
        Variance
        <input type="range" min="0" max="25" step="1" value={variance} onChange={e => setVariance(+e.target.value)} style={{ width: 80, accentColor: 'var(--primary)' }} />
        <span style={{ fontWeight: 700, color: variance > 0 ? 'var(--primary)' : 'var(--text-dim)', minWidth: 28, textAlign: 'right' }}>{variance}%</span>
      </label>
      <button onClick={applyGlobal} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-muted)', padding: '4px 12px', fontSize: 12, cursor: 'pointer' }}>Apply Global</button>
      <button onClick={exportProjections} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-muted)', padding: '4px 12px', fontSize: 12, cursor: 'pointer', marginLeft: 'auto' }}><Icon name="download" size={12}/> Projections CSV</button>
    </div>
    <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 14, marginLeft: 2 }}>
      {mode === 'ceiling'
        ? <><Icon name="rocket" size={14} color="var(--primary)"/> <strong style={{ color: 'var(--primary)' }}>GPP:</strong> Builds for ceiling — best for big tournaments with many entries (your 39.6K-entry contest is GPP)</>
        : <><Icon name="dollar" size={14} color="var(--primary)"/> <strong style={{ color: 'var(--primary)' }}>Cash:</strong> Builds for consistent median — best for 50/50s and head-to-heads</>
      }
    </div>
    <div className="builder-controls">{sp.map(p => <div className="ctrl-row" key={p.name}>
      <span className="ctrl-name" style={{ flex: '1 1 0', minWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
      <span style={{ color: 'var(--text-dim)', fontSize: 11, width: 48, flexShrink: 0 }}>{fmtSal(p.salary)}</span>
      <span className="ctrl-proj" style={{ flexShrink: 0, width: 38, textAlign: 'right' }}>{mode === 'ceiling' ? fmt(p.ceil, 1) : fmt(p.proj, 1)}</span>
      <span style={{ color: (ownership[p.name] || 0) > 35 ? 'var(--amber)' : 'var(--text-dim)', fontSize: 11, width: 30, textAlign: 'right', flexShrink: 0 }}>{fmt(ownership[p.name] || 0, 0)}%</span>
      <input type="number" value={exp[p.name]?.min ?? globalMin} onChange={e => sE(p.name, 'min', +e.target.value)} title="Min %" style={{ width: 32, flexShrink: 0 }} />
      <input type="number" value={exp[p.name]?.max ?? globalMax} onChange={e => sE(p.name, 'max', +e.target.value)} title="Max %" style={{ width: 32, flexShrink: 0 }} />
    </div>)}</div>
    <button className="btn btn-primary" onClick={run} disabled={!canBuild}
      title={canBuild ? '' : `Edit at least 2 projections on the DK Projections tab first (${overrideCount}/2 changed)`}
      style={!canBuild ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}>
      <Icon name="bolt" size={14}/> Build {nL} {mode === 'ceiling' ? 'GPP' : 'Cash'} Lineups{contrarianOn ? ' (Contrarian)' : ''}
    </button>
    {res && <MMAExposureResults res={res} ownership={ownership} onRebuild={run} onExportDK={exportDK} onExportReadable={exportReadable} nL={nL} mode={res.mode} canBuild={canBuild} overrideCount={overrideCount} />}
  </>);
}

function MMAExposureResults({ res, ownership, onRebuild, onExportDK, onExportReadable, nL, mode, canBuild = true, overrideCount = 2 }) {
  const expData = useMemo(() => res.pData.map((p, i) => {
    const cnt = res.counts[i]; const pct = cnt / res.lineups.length * 100;
    const simOwn = ownership[p.name] || 0; const lev = Math.round((pct - simOwn) * 10) / 10;
    const score = mode === 'ceiling' ? p.ceiling : p.projection;
    const val = score / (p.salary / 1000);
    return { name: p.name, salary: p.salary, score, val, cnt, pct, simOwn, lev };
  }), [res, ownership, mode]);
  const avgSal = Math.round(res.lineups.reduce((s, lu) => s + lu.sal, 0) / res.lineups.length);
  const projMax = res.lineups.length ? Math.max(...res.lineups.map(lu => lu.proj)) : 0;
  const projMin = res.lineups.length ? Math.min(...res.lineups.map(lu => lu.proj)) : 0;
  const avgOwn = Math.round(res.lineups.reduce((s, lu) => {
    const lineupOwn = lu.players.reduce((ss, pi) => ss + (ownership[res.pData[pi].name] || 0), 0) / lu.players.length;
    return s + lineupOwn;
  }, 0) / res.lineups.length);
  const { sorted, sortKey, sortDir, toggleSort } = useSort(expData, 'pct', 'desc');
  const S = p => <SH {...p} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />;
  return (<>
    <div style={{ marginTop: 20, padding: '10px 14px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13, color: 'var(--text-muted)' }}>
      <Icon name="check" size={14} color="#22C55E"/> Built <span style={{ color: 'var(--primary-glow)', fontWeight: 700 }}>{res.lineups.length}</span> lineups ({mode === 'ceiling' ? 'GPP/ceiling' : 'cash/median'}) from {res.total.toLocaleString()} valid · Range: <span style={{ color: 'var(--green)' }}>{projMax}</span> → <span style={{ color: 'var(--text-dim)' }}>{projMin}</span> · Avg Sal: <span style={{ color: 'var(--primary-glow)', fontWeight: 600 }}>${avgSal.toLocaleString()}</span> · Avg Own: <span style={{ color: avgOwn > 30 ? 'var(--amber)' : 'var(--green)', fontWeight: 600 }}>{avgOwn}%</span>
    </div>
    <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
      {onRebuild && <button className="btn btn-primary" onClick={onRebuild} disabled={!canBuild}
        title={canBuild ? '' : `Edit at least 2 projections first (${overrideCount}/2 changed)`}
        style={{ flex: '1 1 auto', width: 'auto', ...(canBuild ? {} : { opacity: 0.4, cursor: 'not-allowed' }) }}><Icon name="bolt" size={14}/> Rebuild {nL}</button>}
      {onExportDK && <button className="btn btn-primary" onClick={onExportDK} style={{ flex: '1 1 auto', width: 'auto', background: 'linear-gradient(135deg, #15803D, #22C55E)' }}><Icon name="download" size={14}/> Download DK Upload CSV</button>}
      {onExportReadable && <button className="btn btn-outline" onClick={onExportReadable} style={{ flex: '1 1 auto', width: 'auto', marginTop: 0 }}><Icon name="download" size={14}/> Readable CSV</button>}
    </div>
    <div className="section-head" style={{ marginTop: 20 }}><Icon name="chart" size={16} color="#F5C518"/> Exposure</div>
    <div className="table-wrap" style={{ marginBottom: 20 }}><table><thead><tr>
      <S label="Fighter" colKey="name" /><S label="Salary" colKey="salary" /><S label={mode === 'ceiling' ? 'Ceiling' : 'Proj'} colKey="score" /><S label="Val" colKey="val" /><S label="Count" colKey="cnt" /><S label="Exposure" colKey="pct" /><S label="Sim Own" colKey="simOwn" /><S label="Leverage" colKey="lev" />
    </tr></thead>
    <tbody>{sorted.map(p => <tr key={p.name}><td className="name">{p.name}</td><td className="num">${p.salary.toLocaleString()}</td><td className="num">{fmt(p.score, 1)}</td><td className="num">{fmt(p.val, 2)}</td><td className="num">{p.cnt}</td><td><span className="exp-bar-bg"><span className="exp-bar" style={{ width: Math.min(p.pct, 100) + '%' }} /></span>{fmt(p.pct, 1)}%</td><td className="num muted">{fmt(p.simOwn, 1)}%</td><td className="num"><span style={{ color: p.lev > 0 ? 'var(--green)' : p.lev < 0 ? 'var(--red)' : 'var(--text-dim)', fontWeight: Math.abs(p.lev) > 10 ? 700 : 400 }}>{p.lev > 0 ? '+' : ''}{fmt(p.lev, 1)}%</span></td></tr>)}</tbody></table></div>
    <div className="section-head"><Icon name="target" size={16} color="#F5C518"/> Lineups</div>
    <div className="lineup-grid">{res.lineups.slice(0, 30).map((lu, idx) => {
      const ps = lu.players.map(i => res.pData[i]).sort((a, b) => b.salary - a.salary);
      const lineupAvgOwn = Math.round(ps.reduce((s, p) => s + (ownership[p.name] || 0), 0) / ps.length);
      return <div className="lu-card" key={idx}><div className="lu-header"><span>#{idx + 1}</span><span className="lu-proj">{lu.proj} pts</span></div>{ps.map(p => {
        const ownPct = ownership[p.name] || 0;
        const scoreShown = mode === 'ceiling' ? p.ceiling : p.projection;
        return <div className="lu-row" key={p.name}><span className="lu-name">{p.name}</span><span className="lu-opp">vs {p.opponent}</span><span className="lu-sal">${p.salary.toLocaleString()}</span><span className="lu-pts">{fmt(scoreShown, 1)}</span><span style={{ width: 36, textAlign: 'right', color: ownPct > 35 ? 'var(--amber)' : 'var(--text-dim)', fontSize: 11 }}>{fmt(ownPct, 0)}%</span></div>;
      })}<div className="lu-footer"><span>${lu.sal.toLocaleString()}</span><span style={{ color: lineupAvgOwn > 30 ? 'var(--amber)' : 'var(--green)' }}>Avg: {lineupAvgOwn}%</span></div></div>;
    })}</div>
    {res.lineups.length > 30 && <div style={{ textAlign: 'center', color: 'var(--text-dim)', fontSize: 13, marginTop: 8 }}>+ {res.lineups.length - 30} more</div>}
  </>);
}

// ═══════════════════════════════════════════════════════════════════════
// NBA COMPONENTS
// ═══════════════════════════════════════════════════════════════════════

// Team color badge
function TeamBadge({ team }) {
  const colors = {
    OKC: { bg: 'rgba(245,140,10,0.18)', fg: '#FFB648', br: 'rgba(245,140,10,0.5)' },
    PHX: { bg: 'rgba(159,73,172,0.18)', fg: '#C99AD4', br: 'rgba(159,73,172,0.5)' },
  };
  const c = colors[team] || { bg: 'rgba(120,120,120,0.15)', fg: 'var(--text-muted)', br: 'var(--border)' };
  return (
    <span style={{
      display: 'inline-block', padding: '1px 7px', borderRadius: 4,
      fontSize: 10, fontWeight: 700, letterSpacing: '0.04em',
      color: c.fg, background: c.bg, border: `1px solid ${c.br}`,
    }}>{team}</span>
  );
}

// Status chip — click cycles ACTIVE → GTD → Q → OUT → ACTIVE
const NBA_STATUS_CYCLE = ['ACTIVE', 'GTD', 'Q', 'OUT'];
function StatusChip({ status, onCycle }) {
  const s = (status || 'ACTIVE').toUpperCase();
  const style = {
    ACTIVE: { bg: 'rgba(74,222,128,0.12)', fg: 'var(--green-text)', br: 'rgba(74,222,128,0.4)' },
    GTD:    { bg: 'rgba(251,191,36,0.12)', fg: 'var(--amber-text)', br: 'rgba(251,191,36,0.5)' },
    Q:      { bg: 'rgba(251,146,60,0.15)', fg: '#FB923C',            br: 'rgba(251,146,60,0.5)' },
    OUT:    { bg: 'rgba(239,68,68,0.18)',  fg: 'var(--red-text)',    br: 'rgba(239,68,68,0.6)' },
  }[s] || { bg: 'var(--card)', fg: 'var(--text-muted)', br: 'var(--border)' };
  return (
    <button onClick={onCycle} title="Click to cycle status" style={{
      padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700, letterSpacing: '0.04em',
      color: style.fg, background: style.bg, border: `1px solid ${style.br}`, cursor: 'pointer',
    }}>{s}</button>
  );
}

// NBA DK Tab — projections, value, ownership, status, mins/usg, cascade
function NBADKTab({ players, gameInfo, own, cptOwn = {}, onOverride, overrides }) {
  const [statusMap, setStatusMap] = useState({});
  const cycleStatus = (name) => {
    setStatusMap(prev => {
      const cur = prev[name] ?? (players.find(p => p.name === name)?.status || 'ACTIVE');
      const idx = NBA_STATUS_CYCLE.indexOf(cur);
      return { ...prev, [name]: NBA_STATUS_CYCLE[(idx + 1) % NBA_STATUS_CYCLE.length] };
    });
  };
  const effStatus = (p) => statusMap[p.name] ?? (p.status || 'ACTIVE');

  const pw = useMemo(() => players.filter(p => p.salary > 0).map(p => {
    const s = effStatus(p);
    return {
      ...p,
      simOwn: own[p.name] || 0,
      cptOwnPct: cptOwn[p.name] || 0,
      flexOwnPct: Math.max(0, (own[p.name] || 0) - (cptOwn[p.name] || 0)),
      effStatus: s,
      isOut: s === 'OUT',
    };
  }), [players, own, cptOwn, statusMap]);

  const { sorted, sortKey, sortDir, toggleSort } = useSort(pw, 'proj', 'desc');

  const t3v = useMemo(() => [...pw].filter(p => !p.isOut && p.projectable).sort((a, b) => b.val - a.val).slice(0, 3).map(p => p.name), [pw]);
  const t3c = useMemo(() => [...pw].filter(p => !p.isOut && p.projectable).sort((a, b) => b.ceil - a.ceil).slice(0, 3).map(p => p.name), [pw]);
  // TRAP = highest field-simulated ownership, period.
  // Per GPP leverage theory, the chalky play is what we fade — even if they
  // have "good value". Good-value chalk is exactly where the field converges,
  // which is precisely what we're trying to differentiate from.
  const trap = useMemo(() => {
    const active = pw.filter(p => !p.isOut && p.projectable);
    if (active.length === 0) return '';
    const hasOwn = active.some(p => p.simOwn > 0);
    const sorted = hasOwn
      ? [...active].sort((a, b) => b.simOwn - a.simOwn)
      : [...active].sort((a, b) => b.proj - a.proj);
    return sorted[0]?.name || '';
  }, [pw]);
  const gem = useMemo(() => {
    const trapP = pw.find(p => p.name === trap);
    if (!trapP) return '';
    const band = pw.filter(p => !p.isOut && p.projectable && p.name !== trap &&
                                p.salary >= trapP.salary - 2000 && p.salary <= trapP.salary + 500);
    if (band.length === 0) return '';
    // Best value in band, weighted by ceiling
    const scored = band.map(p => ({ name: p.name, s: p.val * p.ceil })).sort((a, b) => b.s - a.s);
    return scored[0]?.name || '';
  }, [pw, trap]);

  const S = p => <SH {...p} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />;

  // Cascade removed — projections come from static DK prop lines only.
  // Status cycler still exists so the user can flag players OUT to exclude
  // them from the builder / ownership sim.
  const unprojectablePlayers = pw.filter(p => !p.projectable && !p.isOut);

  return (<>
    <div className="metrics">
      <div className="metric"><div className="metric-label"><Icon name="trophy" size={13}/> Top Value</div><div className="metric-value">{t3v.map((n, i) => { const p = players.find(x => x.name === n); return <div key={i} style={{ fontSize: i === 0 ? '16px' : '13px', color: i === 0 ? undefined : 'var(--text-muted)' }}>{i + 1}. {n} <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{fmt(p?.val, 2)}</span></div>; })}</div></div>
      <div className="metric"><div className="metric-label"><Icon name="rocket" size={13}/> Top Ceiling</div><div className="metric-value">{t3c.map((n, i) => { const p = players.find(x => x.name === n); return <div key={i} style={{ fontSize: i === 0 ? '16px' : '13px', color: i === 0 ? undefined : 'var(--text-muted)' }}>{n} <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{fmt(p?.ceil, 1)}</span></div>; })}</div></div>
      <div className="metric"><div className="metric-label"><Icon name="gem" size={13}/> Hidden Gem</div><div className="metric-value" style={{ color: 'var(--green-text)' }}>{gem || '-'}</div><div className="metric-sub">Best value in trap's salary band</div></div>
      <div className="metric"><div className="metric-label"><Icon name="bomb" size={13}/> Biggest Trap</div><div className="metric-value" style={{ color: 'var(--red-text)' }}>{trap || '-'}</div><div className="metric-sub">Field-converged chalk</div></div>
    </div>
    {unprojectablePlayers.length > 0 && (
      <div style={{ padding: '10px 14px', marginBottom: 12, background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.35)', borderRadius: 8, fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <Icon name="warning" size={14} color="#FBBF24"/>
        <strong style={{ color: 'var(--amber-text)' }}>{unprojectablePlayers.length} players have no DraftKings prop line</strong>
        <span style={{ color: 'var(--text-dim)' }}>— excluded from projections and builder. They remain visible below marked <span style={{ color: 'var(--text-muted)' }}>No Line</span>.</span>
      </div>
    )}
    {gameInfo && (
      <div style={{ padding: '8px 12px', marginBottom: 12, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <span>{gameInfo.away} @ {gameInfo.home}</span>
        <span style={{ color: 'var(--text-dim)' }}>·</span>
        <span>Spread: <strong style={{ color: 'var(--text)' }}>{gameInfo.home} {gameInfo.spread_okc > 0 ? '+' : ''}{gameInfo.spread_okc}</strong></span>
        <span style={{ color: 'var(--text-dim)' }}>·</span>
        <span>Total: <strong style={{ color: 'var(--text)' }}>{gameInfo.total}</strong></span>
        <span style={{ color: 'var(--text-dim)' }}>·</span>
        <span>Pace: <strong style={{ color: 'var(--text)' }}>{((gameInfo.pace_okc + gameInfo.pace_phx) / 2).toFixed(1)}</strong></span>
        <span style={{ color: 'var(--text-dim)' }}>·</span>
        <span title="Probability the game becomes a blowout — affects starter minutes">Blowout risk: <strong style={{ color: gameInfo.blowout_risk_okc > 0.6 ? 'var(--amber)' : 'var(--text)' }}>{Math.round(gameInfo.blowout_risk_okc * 100)}%</strong></span>
      </div>
    )}
    <div className="table-wrap"><table><thead><tr>
      <th>#</th><th></th><S label="Player" colKey="name" /><th>Team</th><th>Pos</th>
      <S label="Sal" colKey="salary" />
      <S label="Sim Own" colKey="simOwn" />
      <S label="CPT %" colKey="cptOwnPct" />
      <S label="Proj" colKey="proj" /><S label="Ceil" colKey="ceil" />
      <S label="Val" colKey="val" /><S label="CVal" colKey="cval" />
      <S label="Min" colKey="projMins" />
      <th title="Source of projection">Src</th>
      <th>Status</th>
    </tr></thead>
    <tbody>{sorted.map((p, i) => {
      const iv = t3v.includes(p.name), ic = t3c.includes(p.name), ig = p.name === gem, it = p.name === trap;
      const badges = [];
      if (iv) badges.push({ icon: 'trophy', label: 'Top 3 Value' });
      if (ic) badges.push({ icon: 'rocket', label: 'Top 3 Ceiling' });
      if (ig) badges.push({ icon: 'gem',    label: 'Hidden Gem' });
      if (it) badges.push({ icon: 'bomb',   label: 'Trap' });
      const isOver = overrides && overrides[p.name] != null;
      const dimStyle = p.isOut || !p.projectable ? { opacity: p.isOut ? 0.4 : 0.6 } : {};
      const noLine = !p.projectable;
      return <tr key={p.name} className={ig ? 'row-hl-green' : it ? 'row-hl-red' : ''} style={dimStyle}>
        <td className="muted">{i + 1}</td>
        <td><span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>{badges.map((bd, j) => <Tip key={j} icon={bd.icon} label={bd.label} size={14} />)}</span></td>
        <td className="name">
          {p.name}
          {noLine && <span style={{ marginLeft: 6, padding: '1px 6px', borderRadius: 3, fontSize: 9, fontWeight: 700, background: 'rgba(251,191,36,0.15)', color: 'var(--amber-text)', border: '1px solid rgba(251,191,36,0.4)' }}>NO LINE</span>}
          {p.statCoverage > 0 && p.statCoverage < 5 && !noLine && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--text-dim)' }} title="Partial DK data">{p.statCoverage}/5 stats</span>}
        </td>
        <td><TeamBadge team={p.team} /></td>
        <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>{p.positions_str}</td>
        <td className="num">{fmtSal(p.salary)}</td>
        <td className="num" style={{ color: p.simOwn > 40 ? 'var(--red-text)' : p.simOwn > 25 ? 'var(--amber)' : 'var(--text-muted)' }}>{noLine ? '—' : fmt(p.simOwn, 1) + '%'}</td>
        <td className="num" title="Captain-specific ownership in top 1500 lineups" style={{ color: p.cptOwnPct > 30 ? 'var(--red-text)' : p.cptOwnPct > 15 ? 'var(--amber)' : 'var(--text-dim)', fontWeight: p.cptOwnPct > 20 ? 600 : 400 }}>{noLine ? '—' : fmt(p.cptOwnPct, 1) + '%'}</td>
        <td className="num">
          {noLine ? <span style={{ color: 'var(--text-dim)' }}>—</span> : (
            <span className={iv ? 'cell-top3' : 'cell-proj'}>
              <input type="number" step="0.1" className={`proj-edit ${isOver ? 'overridden' : ''}`}
                value={fmt(p.proj, 1)}
                onChange={e => onOverride && onOverride(p.name, e.target.value)}
                onDoubleClick={() => onOverride && onOverride(p.name, null)}
                title={isOver ? 'Overridden — double-click to reset' : 'Click to edit'} />
            </span>
          )}
        </td>
        <td className="num">{noLine ? <span style={{ color: 'var(--text-dim)' }}>—</span> : <span style={{ background: 'rgba(74,222,128,0.1)', color: 'var(--green)', padding: '3px 8px', borderRadius: 4, fontWeight: 600, fontSize: 12 }}>{fmt(p.ceil, 1)}</span>}</td>
        <td className="num">{noLine ? '—' : <span className={iv ? 'cell-top3' : ''}>{fmt(p.val, 2)}</span>}</td>
        <td className="num" style={{ color: p.cval > 5 ? 'var(--green)' : undefined, fontWeight: p.cval > 5 ? 700 : 400 }}>{noLine ? '—' : fmt(p.cval, 2)}</td>
        <td className="num">{fmt(p.projMins, 1)}</td>
        <td className="num muted" title="Informational — minutes are not used in projections (DK lines already price them in)">{noLine ? '—' : 'DK'}</td>
        <td><StatusChip status={p.effStatus} onCycle={() => cycleStatus(p.name)} /></td>
      </tr>; })}</tbody></table></div>
  </>);
}

// NBA PP Tab — stat-by-stat EV vs PP lines
function NBAPPTab({ rows }) {
  const { sorted, sortKey, sortDir, toggleSort } = useSort(rows, 'ev', 'desc');
  const S = p => <SH {...p} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />;
  const best = useMemo(() => [...rows].sort((a, b) => b.ev - a.ev).slice(0, 3), [rows]);
  const worst = useMemo(() => [...rows].sort((a, b) => a.ev - b.ev).slice(0, 3), [rows]);
  return (<>
    <div className="section-hero">
      <div className="section-hero-icon-wrap">
        <svg className="section-hero-icon" viewBox="0 0 24 24" fill="none" stroke="#F5C518">
          <circle cx="12" cy="12" r="9"/>
          <circle cx="12" cy="12" r="5"/>
          <circle cx="12" cy="12" r="1.5" fill="#F5C518" stroke="none"/>
        </svg>
      </div>
      <div className="section-hero-text">
        <h2 className="section-hero-title">PrizePicks Fantasy Score</h2>
        <div className="section-hero-sub">DK-devigged projection vs PP Fantasy Score line · Edge = Projected − PP Line</div>
      </div>
    </div>
    <div className="metrics">
      <div className="metric"><div className="metric-label"><Icon name="flame" size={13}/> Best Edge</div><div className="metric-value">{best.map((r, i) => <div key={i} style={{ fontSize: i === 0 ? '16px' : '13px', color: i === 0 ? 'var(--green-text)' : 'var(--text-muted)', fontWeight: i === 0 ? 700 : 500 }}>{r.player} <span style={{fontSize:11, color: i === 0 ? undefined : 'var(--text-dim)'}}>{r.ev > 0 ? '+' : ''}{fmt(r.ev, 2)}</span></div>)}</div></div>
      <div className="metric"><div className="metric-label"><Icon name="trending-down" size={13}/> Biggest Fades</div><div className="metric-value">{worst.map((r, i) => <div key={i} style={{ fontSize: i === 0 ? '16px' : '13px', color: i === 0 ? 'var(--red-text)' : 'var(--text-muted)', fontWeight: i === 0 ? 700 : 500 }}>{r.player} <span style={{fontSize:11, color: i === 0 ? undefined : 'var(--text-dim)'}}>{fmt(r.ev, 2)}</span></div>)}</div></div>
    </div>
    <div className="table-wrap"><table><thead><tr>
      <th>#</th><th></th><S label="Player" colKey="player" /><th>Team</th>
      <S label="PP Line" colKey="line" />
      <S label="Our Proj" colKey="projected" /><S label="Edge" colKey="ev" />
      <S label="Play" colKey="direction" />
    </tr></thead>
    <tbody>{sorted.map((r, i) => {
      const isBest = best.some(t => t.player === r.player && t.stat === r.stat);
      const isWorst = worst.some(t => t.player === r.player && t.stat === r.stat);
      // Push-zone: |ev| < 1 → amber instead of hard green/red
      const pushZone = Math.abs(r.ev) < 1;
      return <tr key={r.player + r.stat} className={isBest ? 'row-hl-green' : isWorst ? 'row-hl-red' : ''}>
        <td className="muted">{i + 1}</td>
        <td>{isBest ? <Tip icon="flame" label="Best edge" /> : isWorst ? <Tip icon="trending-down" label="Fade" /> : ''}</td>
        <td className="name">{r.player}</td>
        <td>{r.team ? <TeamBadge team={r.team} /> : ''}</td>
        <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>{r.stat}</td>
        <td className="num">{fmt(r.line, 1)}</td>
        <td className="num"><span className="cell-proj">{fmt(r.projected, 2)}</span></td>
        <td className="num"><span className={isBest ? 'cell-ev-top' : isWorst ? 'cell-ev-worst' : pushZone ? 'cell-ev-push' : r.ev > 0 ? 'cell-ev-pos' : 'cell-ev-neg'} style={pushZone ? { color: 'var(--amber-text)' } : undefined}>{r.ev > 0 ? '+' : ''}{fmt(r.ev, 2)}</span></td>
        <td><span style={{ color: r.direction === 'MORE' ? 'var(--green-text)' : r.direction === 'LESS' ? 'var(--red-text)' : 'var(--text-dim)', fontWeight: 600 }}>{r.direction}</span></td>
      </tr>;
    })}</tbody></table></div>
  </>);
}

// NBA Builder Tab — contrarian lineup building for showdown or classic
function NBABuilderTab({ players: rp, ownership, cptOwnership = {}, slateType, gameInfo }) {
  const [exp, setExp] = useState({});
  const [res, setRes] = useState(null);
  const [nL, setNL] = useState(20);
  const [variance, setVariance] = useState(2);
  const [globalMax, setGlobalMax] = useState(100);
  const [globalMin, setGlobalMin] = useState(0);
  const [contrarianOn, setContrarianOn] = useState(false);
  const [contrarianStrength, setContrarianStrength] = useState(0.6);
  // 'all' | 'cpt' | 'flex' — which slot type the min/max inputs currently target
  const [expScope, setExpScope] = useState('all');
  const isShowdown = (slateType || 'showdown') === 'showdown';

  // Per-scope field names in the `exp` state object
  const scopeField = (kind /* 'min' | 'max' */) => {
    if (expScope === 'cpt')  return kind === 'min' ? 'cptMin'  : 'cptMax';
    if (expScope === 'flex') return kind === 'min' ? 'flexMin' : 'flexMax';
    return kind; // 'all' uses base 'min' / 'max'
  };
  const getCap = (name, kind) => {
    const e = exp[name] || {};
    const f = scopeField(kind);
    return e[f];
  };
  const setCap = (name, kind, val) =>
    setExp(p => ({ ...p, [name]: { ...p[name], [scopeField(kind)]: val } }));

  const avgVal = useMemo(() => {
    const vals = rp.filter(p => p.salary > 0 && (p.status || 'ACTIVE').toUpperCase() !== 'OUT').map(p => p.val || 0);
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 4;
  }, [rp]);

  // CONTRARIAN MODE (NBA) — mirrors tennis/MMA with NBA-specific gem band
  const contrarianCaps = useMemo(() => {
    if (!contrarianOn) return {};
    const withSal = rp.filter(p => p.salary > 0 && p.projectable && (p.status || 'ACTIVE').toUpperCase() !== 'OUT');
    if (withSal.length === 0) return {};
    const caps = {};

    const byProj = [...withSal].sort((a, b) => (b.ceil || b.proj || 0) - (a.ceil || a.proj || 0));
    const topProjN = Math.max(3, Math.ceil(withSal.length * 0.3));
    const topProjSet = new Set(byProj.slice(0, topProjN).map(p => p.name));

    const boostFloor = Math.round(10 + contrarianStrength * 10);
    const LEV_CAP = 30;

    // TRAP = highest field ownership (pure chalk fade for GPP leverage).
    const hasOwn = withSal.some(p => (ownership[p.name] || 0) > 0);
    const trap = hasOwn
      ? [...withSal].sort((a, b) => (ownership[b.name] || 0) - (ownership[a.name] || 0))[0]
      : byProj[0];
    if (trap) {
      const trapFieldOwn = ownership[trap.name] || 0;
      const maxCap = Math.max(5, Math.round(trapFieldOwn - contrarianStrength * 50));
      caps[trap.name] = { max: maxCap, _isTrap: true };
    }

    // STUD — overowned star with worst value
    const overownedStars = withSal.filter(p => {
      if (p.name === trap?.name) return false;
      if (!topProjSet.has(p.name)) return false;
      const fieldOwn = ownership[p.name] || 0;
      const fairOwn = computeFairOwn(p.val || 0, avgVal);
      return fieldOwn > fairOwn + 5 && fieldOwn >= 25;
    });
    const stud = overownedStars.sort((a, b) => (a.val || 0) - (b.val || 0))[0];
    if (stud) {
      const fieldOwn = Math.round(ownership[stud.name] || 0);
      caps[stud.name] = {
        min: Math.min(85, fieldOwn + boostFloor),
        max: Math.min(95, fieldOwn + LEV_CAP),
        _isBoost: true, _leverage: boostFloor, _type: 'stud'
      };
    }

    // GEM — salary band below trap (NBA-wide: -$2000 to +$500)
    const trapSal = trap?.salary ?? 0;
    const inBand = (p, lo, hi) => (p.salary - trapSal) >= lo && (p.salary - trapSal) <= hi;
    const salaryEligible = trap ? withSal.filter(p => {
      if (p.name === trap.name || p.name === stud?.name) return false;
      return inBand(p, -2000, 500);
    }) : [];
    // Best value with ceiling weighting, biased toward underowned
    const scored = salaryEligible.map(p => {
      const fieldOwn = ownership[p.name] || 0;
      const fairOwn = computeFairOwn(p.val || 0, avgVal);
      const underownedBonus = Math.max(0, fairOwn - fieldOwn) * 0.5;
      return { p, score: (p.val || 0) * (p.ceil || p.proj || 0) + underownedBonus };
    }).sort((a, b) => b.score - a.score);
    const gem = scored[0]?.p;
    if (gem) {
      const fieldOwn = Math.round(ownership[gem.name] || 0);
      caps[gem.name] = {
        min: Math.min(85, fieldOwn + boostFloor),
        max: Math.min(95, fieldOwn + LEV_CAP),
        _isBoost: true, _leverage: boostFloor, _type: 'gem'
      };
    }

    // GLOBAL FLOOR — small min exposure for rest, +30pp cap for ≥15% field plays
    const globalFloor = Math.round(1 + contrarianStrength * 7);
    withSal.forEach(p => {
      if (caps[p.name]) return;
      const fieldOwn = Math.round(ownership[p.name] || 0);
      const maxCap = fieldOwn >= 15 ? Math.min(95, fieldOwn + LEV_CAP) : 100;
      caps[p.name] = { min: globalFloor, max: maxCap, _isFloor: true };
    });

    return caps;
  }, [rp, ownership, contrarianOn, contrarianStrength, avgVal]);

  const sp = useMemo(() =>
    [...rp].filter(p => p.salary > 0 && p.projectable && (p.status || 'ACTIVE').toUpperCase() !== 'OUT')
           .sort((a, b) => b.val - a.val),
    [rp]);

  const sE = (n, f, v) => setExp(p => ({ ...p, [n]: { ...p[n], [f]: v } }));
  const applyGlobal = () => { const ne = {}; sp.forEach(p => { ne[p.name] = { min: globalMin, max: globalMax, ...exp[p.name] }; }); setExp(ne); };

  const run = () => {
    if (!canBuild) return;
    const jitter = () => 1 + (Math.random() * 2 - 1) * variance / 100;
    const enforceMinNudge = (pd, baseProjs) => {
      const changed = pd.filter((p, i) => Math.abs(p.projection - baseProjs[i]) >= 0.01).length;
      if (changed >= 2) return;
      const idxs = [...Array(pd.length).keys()].sort(() => Math.random() - 0.5).slice(0, 2);
      idxs.forEach(i => {
        const sign = Math.random() < 0.5 ? -1 : 1;
        pd[i].projection = Math.round((pd[i].projection + sign * 0.01) * 1000) / 1000;
      });
    };
    if (isShowdown) {
      const baseProjs = sp.map(p => p.proj);
      const pd = sp.map(p => {
        const cap = contrarianCaps[p.name] || {};
        const userSet = exp[p.name] || {};
        const userMin = userSet.min !== undefined ? userSet.min : globalMin;
        const userMax = userSet.max !== undefined ? userSet.max : globalMax;
        const effMin = Math.max(userMin, cap.min || 0);
        const effMax = Math.min(userMax, cap.max !== undefined ? cap.max : 100);
        return {
          name: p.name, team: p.team, projection: p.proj * jitter(),
          util_salary: p.util_salary || p.salary, cpt_salary: p.cpt_salary,
          util_id: p.util_id || p.id, cpt_id: p.cpt_id,
          salary: p.util_salary || p.salary, id: p.util_id || p.id,
          positions: p.positions || [], status: p.status,
          maxExp: effMax, minExp: effMin,
          // Per-slot caps — only applied when user has set them via the
          // CPT / FLEX tabs in the builder; otherwise full range (0–100).
          cptMinExp:  userSet.cptMin  !== undefined ? userSet.cptMin  : 0,
          cptMaxExp:  userSet.cptMax  !== undefined ? userSet.cptMax  : 100,
          flexMinExp: userSet.flexMin !== undefined ? userSet.flexMin : 0,
          flexMaxExp: userSet.flexMax !== undefined ? userSet.flexMax : 100,
        };
      });
      enforceMinNudge(pd, baseProjs);
      const r = nbaOptimizeShowdown(pd, nL, 50000, 48000);
      setRes({ ...r, pData: pd, isShowdown: true });
      return;
    }
    // Classic
    const baseProjs = sp.map(p => p.proj);
    const pd = sp.map(p => {
      const cap = contrarianCaps[p.name] || {};
      const userSet = exp[p.name] || {};
      const userMin = userSet.min !== undefined ? userSet.min : globalMin;
      const userMax = userSet.max !== undefined ? userSet.max : globalMax;
      const effMin = Math.max(userMin, cap.min || 0);
      const effMax = Math.min(userMax, cap.max !== undefined ? cap.max : 100);
      return {
        name: p.name, team: p.team, projection: p.proj * jitter(),
        salary: p.salary, id: p.id, positions: p.positions || [],
        status: p.status, maxExp: effMax, minExp: effMin,
      };
    });
    enforceMinNudge(pd, baseProjs);
    const r = nbaOptimizeClassic(pd, nL, 50000, 48000);
    setRes({ ...r, pData: pd, isShowdown: false });
  };

  const dl = (c, f) => { const b = new Blob([c], { type: 'text/csv' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = f; a.click(); URL.revokeObjectURL(a.href); };

  const exportDK = () => {
    if (!res) return;
    if (res.isShowdown) {
      let c = 'CPT,UTIL,UTIL,UTIL,UTIL,UTIL\n';
      res.lineups.forEach(lu => {
        const cptP = res.pData[lu.cpt];
        const utilPs = lu.utils.map(i => res.pData[i]);
        c += `${cptP.cpt_id},${utilPs.map(p => p.util_id).join(',')}\n`;
      });
      dl(c, 'dk_upload_nba_showdown.csv');
      return;
    }
    let c = 'PG,SG,SF,PF,C,G,F,UTIL\n';
    res.lineups.forEach(lu => {
      const ps = lu.players.map(i => res.pData[i]);
      c += ps.map(p => p.id).join(',') + '\n';
    });
    dl(c, 'dk_upload_nba_classic.csv');
  };

  const exportReadable = () => {
    if (!res) return;
    if (res.isShowdown) {
      let c = 'Rank,Proj,Salary,CPT,U1,U2,U3,U4,U5\n';
      res.lineups.forEach((lu, i) => {
        const cptP = res.pData[lu.cpt];
        const utilPs = lu.utils.map(j => res.pData[j]);
        c += `${i + 1},${lu.proj},${lu.sal},${cptP.name},${utilPs.map(p => p.name).join(',')}\n`;
      });
      dl(c, 'nba_lineups_showdown.csv');
      return;
    }
    let c = 'Rank,Proj,Salary,P1,P2,P3,P4,P5,P6,P7,P8\n';
    res.lineups.forEach((lu, i) => {
      const ps = lu.players.map(j => res.pData[j]);
      c += `${i + 1},${lu.proj},${lu.sal},${ps.map(p => p.name).join(',')}\n`;
    });
    dl(c, 'nba_lineups_classic.csv');
  };

  const exportProjections = () => {
    let c = 'Player,Team,Sal,Proj,Ceil,Val,Mins,Usg,Status\n';
    sp.forEach(p => { c += `${p.name},${p.team},${p.salary},${p.proj},${p.ceil},${p.val},${fmt(p.projMins, 1)},${fmt(p.usg, 1)},${p.status}\n`; });
    dl(c, 'nba_projections.csv');
  };

  const overrideCount = useMemo(() => rp.filter(p => p._overridden).length, [rp]);
  const canBuild = overrideCount >= 2;

  return (<>
    <div className="section-hero">
      <div className="section-hero-icon-wrap">
        <svg className="section-hero-icon" viewBox="0 0 24 24" fill="#F5C518" stroke="none">
          <path d="M13 2L4 14h7l-1 8 10-12h-7l1-8z"/>
        </svg>
      </div>
      <div className="section-hero-text">
        <h2 className="section-hero-title">Lineup Builder</h2>
        <div className="section-hero-sub">{isShowdown ? 'NBA Showdown · 1 CPT + 5 UTIL · $50K cap' : 'NBA Classic · PG/SG/SF/PF/C/G/F/UTIL · $50K cap'}</div>
      </div>
    </div>
    {!canBuild && (
      <div style={{ padding: '14px 18px', marginBottom: 16, background: 'rgba(245,197,24,0.08)', border: '1px solid rgba(245,197,24,0.35)', borderRadius: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--primary)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="warning" size={15} color="#F5C518"/> DraftKings Compliance Warning</div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          DraftKings requires you to edit our default projections before building. Head to the <strong style={{ color: 'var(--text)' }}>DK Projections</strong> tab and change at least <strong style={{ color: 'var(--primary)' }}>2 projections</strong>.
          <span style={{ color: 'var(--text-dim)' }}> Currently changed: <strong style={{ color: overrideCount >= 2 ? 'var(--green)' : 'var(--red)' }}>{overrideCount}</strong>/2</span>
        </div>
      </div>
    )}
    <ContrarianPanel enabled={contrarianOn} onToggle={setContrarianOn} strength={contrarianStrength} onStrengthChange={setContrarianStrength} />
    {contrarianOn && Object.keys(contrarianCaps).length > 0 && (() => {
      const trapEntry = Object.entries(contrarianCaps).find(([, c]) => c._isTrap);
      const boostEntries = Object.entries(contrarianCaps).filter(([, c]) => c._isBoost);
      const floorCount = Object.values(contrarianCaps).filter(c => c._isFloor).length;
      return (
        <div style={{ marginTop: -12, marginBottom: 16, padding: '10px 14px', background: 'rgba(245,197,24,0.06)', border: '1px solid rgba(245,197,24,0.2)', borderRadius: 8, fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          {trapEntry && <span><Icon name="bomb" size={12} color="var(--red)"/> Fading <span style={{ color: 'var(--red)', fontWeight: 600 }}>{trapEntry[0]}</span> · field {(ownership[trapEntry[0]] || 0).toFixed(1)}% → max <span style={{ color: 'var(--primary)', fontWeight: 600 }}>{trapEntry[1].max}%</span></span>}
          {boostEntries.map(([name, c]) => (
            <span key={name}>{c._type === 'stud' ? <><Icon name="trophy" size={12}/> Stud</> : <><Icon name="gem" size={12}/> Gem</>} <span style={{ color: 'var(--green)', fontWeight: 600 }}>{name}</span> · field {(ownership[name] || 0).toFixed(1)}% +<span style={{ color: 'var(--primary)', fontWeight: 600 }}>{c._leverage}pp</span> → <span style={{ color: 'var(--primary)', fontWeight: 600 }}>{c.min}-{c.max}%</span></span>
          ))}
          {floorCount > 0 && <span><Icon name="link" size={12} color="var(--text-muted)"/> {floorCount} others · floor <span style={{ color: 'var(--primary)', fontWeight: 600 }}>{Math.round(1 + contrarianStrength * 7)}%</span> · chalk capped <span style={{ color: 'var(--primary)', fontWeight: 600 }}>+30pp</span></span>}
        </div>
      );
    })()}
    <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
      <label style={{ fontSize: 13, color: 'var(--text-muted)' }}>Lineups: <input style={{ width: 60, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', padding: '4px 8px', marginLeft: 4 }} type="number" value={nL} onChange={e => setNL(+e.target.value)} /></label>
      <label style={{ fontSize: 13, color: 'var(--text-muted)' }}>Min %: <input style={{ width: 50, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', padding: '4px 8px', marginLeft: 4 }} type="number" value={globalMin} onChange={e => setGlobalMin(+e.target.value)} /></label>
      <label style={{ fontSize: 13, color: 'var(--text-muted)' }}>Max %: <input style={{ width: 50, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', padding: '4px 8px', marginLeft: 4 }} type="number" value={globalMax} onChange={e => setGlobalMax(+e.target.value)} /></label>
      <label style={{ fontSize: 13, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }} title="Random ± shift applied to each player's projection per build.">
        Variance
        <input type="range" min="0" max="25" step="1" value={variance} onChange={e => setVariance(+e.target.value)} style={{ width: 80, accentColor: 'var(--primary)' }} />
        <span style={{ fontWeight: 700, color: variance > 0 ? 'var(--primary)' : 'var(--text-dim)', minWidth: 28, textAlign: 'right' }}>{variance}%</span>
      </label>
      <button onClick={applyGlobal} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-muted)', padding: '4px 12px', fontSize: 12, cursor: 'pointer' }}>Apply Global</button>
      <button onClick={exportProjections} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-muted)', padding: '4px 12px', fontSize: 12, cursor: 'pointer', marginLeft: 'auto' }}><Icon name="download" size={12}/> Projections CSV</button>
    </div>
    <style>{`
      /* Scoped NBA builder pool — 2-row card layout so player names always
         fit. Names + team on row 1; salary / proj / own% / min / max on
         row 2. Fully scoped class names avoid any collision with the
         legacy .builder-controls / .ctrl-row rules in styles.css. */
      .oo-nba-pool {
        display: grid !important;
        grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)) !important;
        gap: 8px !important;
        padding: 0 !important;
        margin: 0 0 12px 0 !important;
        list-style: none !important;
      }
      .oo-nba-card {
        display: flex !important;
        flex-direction: column !important;
        gap: 6px !important;
        background: var(--card) !important;
        border: 1px solid var(--border) !important;
        border-radius: 8px !important;
        padding: 9px 11px !important;
        min-width: 0 !important;
      }
      .oo-nba-card:hover { border-color: var(--border-light) !important; }
      .oo-nba-card > * { min-width: 0 !important; }
      .oo-nba-r1 {
        display: flex !important;
        align-items: center !important;
        gap: 8px !important;
        min-width: 0 !important;
      }
      .oo-nba-name {
        flex: 1 1 auto !important;
        min-width: 0 !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
        font-weight: 600 !important;
        font-size: 13px !important;
        color: var(--text) !important;
        letter-spacing: -0.01em !important;
      }
      .oo-nba-team {
        flex-shrink: 0 !important;
        font-size: 10px !important;
        font-weight: 700 !important;
        letter-spacing: 0.04em !important;
        padding: 2px 6px !important;
        border-radius: 4px !important;
        background: rgba(255, 255, 255, 0.04) !important;
      }
      .oo-nba-r2 {
        display: grid !important;
        grid-template-columns: 1fr 1fr 1fr 46px 46px !important;
        align-items: center !important;
        gap: 6px !important;
        font-size: 11px !important;
        font-variant-numeric: tabular-nums !important;
      }
      .oo-nba-r2 > span { min-width: 0 !important; overflow: hidden !important; }
      .oo-nba-sal { color: var(--text-dim) !important; }
      .oo-nba-proj { color: var(--primary) !important; font-weight: 700 !important; font-size: 12px !important; }
      .oo-nba-own { color: var(--text-muted) !important; }
      .oo-nba-card input[type="number"] {
        width: 100% !important;
        min-width: 0 !important;
        padding: 4px 2px !important;
        background: var(--bg) !important;
        border: 1px solid var(--border) !important;
        border-radius: 4px !important;
        color: var(--text) !important;
        font-size: 11px !important;
        text-align: center !important;
        font-weight: 600 !important;
        box-sizing: border-box !important;
        -moz-appearance: textfield !important;
      }
      .oo-nba-card input[type="number"]::-webkit-outer-spin-button,
      .oo-nba-card input[type="number"]::-webkit-inner-spin-button { -webkit-appearance: none !important; margin: 0 !important; }
      .oo-nba-card input[type="number"]:focus { outline: none !important; border-color: var(--primary) !important; }
      .oo-nba-legend {
        display: flex !important; flex-wrap: wrap !important; gap: 12px !important;
        font-size: 10px !important; color: var(--text-dim) !important;
        padding: 0 6px 6px !important; letter-spacing: 0.03em !important;
        text-transform: uppercase !important; font-weight: 600 !important;
      }
      .oo-nba-legend b { color: var(--primary) !important; font-weight: 700 !important; }
      @media (max-width: 600px) {
        .oo-nba-pool { grid-template-columns: 1fr !important; gap: 6px !important; }
        .oo-nba-card { padding: 10px 12px !important; }
        .oo-nba-r2 { grid-template-columns: 1fr 1fr 1fr 52px 52px !important; gap: 8px !important; }
        .oo-nba-r2 input { font-size: 12px !important; padding: 6px 2px !important; }
      }
    `}</style>
    {isShowdown && (
      <div className="oo-nba-scope">
        <style>{`
          .oo-nba-scope {
            display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
            padding: 8px 10px; margin-bottom: 10px;
            background: var(--card); border: 1px solid var(--border);
            border-radius: 8px;
          }
          .oo-nba-scope-label {
            font-size: 11px; color: var(--text-dim); font-weight: 600;
            text-transform: uppercase; letter-spacing: 0.04em;
            margin-right: 4px;
          }
          .oo-nba-scope-btns { display: flex; gap: 4px; }
          .oo-nba-scope-btn {
            padding: 6px 14px; font-size: 12px; font-weight: 700; border-radius: 6px;
            border: 1px solid var(--border); background: var(--bg);
            color: var(--text-muted); cursor: pointer; transition: all 0.12s;
            letter-spacing: 0.03em; text-transform: uppercase;
          }
          .oo-nba-scope-btn:hover { border-color: var(--border-light); color: var(--text); }
          .oo-nba-scope-btn.active {
            border-color: var(--primary); background: rgba(245,197,24,0.14);
            color: var(--primary);
          }
          .oo-nba-scope-hint {
            font-size: 11px; color: var(--text-dim); margin-left: auto;
            font-style: italic;
          }
          @media (max-width: 600px) {
            .oo-nba-scope { padding: 8px; }
            .oo-nba-scope-btn { padding: 7px 10px; font-size: 11px; flex: 1; }
            .oo-nba-scope-btns { flex: 1 1 100%; }
            .oo-nba-scope-hint { margin-left: 0; flex-basis: 100%; text-align: center; margin-top: 4px; }
          }
        `}</style>
        <span className="oo-nba-scope-label">Exposure scope</span>
        <div className="oo-nba-scope-btns">
          {[
            { k: 'all',  label: 'All' },
            { k: 'cpt',  label: 'Captain' },
            { k: 'flex', label: 'Flex' },
          ].map(({ k, label }) => (
            <button key={k}
              className={`oo-nba-scope-btn ${expScope === k ? 'active' : ''}`}
              onClick={() => setExpScope(k)}>{label}</button>
          ))}
        </div>
        <span className="oo-nba-scope-hint">
          {expScope === 'all'  && 'Min/max below cap total exposure across all slots'}
          {expScope === 'cpt'  && 'Min/max below cap captain-slot exposure only'}
          {expScope === 'flex' && 'Min/max below cap flex-slot exposure only'}
        </span>
      </div>
    )}
    <div className="oo-nba-legend">
      <span>Each card shows:</span>
      <span>Player</span>
      <span>Team</span>
      <span>$Sal</span>
      <span>Proj</span>
      <span>Own%</span>
      <b>{expScope === 'cpt' ? 'CPT Min%' : expScope === 'flex' ? 'FLEX Min%' : 'Min%'}</b>
      <b>{expScope === 'cpt' ? 'CPT Max%' : expScope === 'flex' ? 'FLEX Max%' : 'Max%'}</b>
    </div>
    <ul className="oo-nba-pool">{sp.map(p => {
      const ownPct = ownership[p.name] || 0;
      const teamColor = p.team === 'OKC' ? '#FFB648' : '#C99AD4';
      const minVal = getCap(p.name, 'min');
      const maxVal = getCap(p.name, 'max');
      // In 'all' scope, default to globalMin/Max. In cpt/flex scope, default
      // to the unconstrained range 0/100 so nothing is enforced until the
      // user explicitly sets a per-slot cap.
      const minDefault = expScope === 'all' ? globalMin : 0;
      const maxDefault = expScope === 'all' ? globalMax : 100;
      return <li className="oo-nba-card" key={p.name}>
        <div className="oo-nba-r1">
          <span className="oo-nba-name" title={p.name}>{p.name}</span>
          <span className="oo-nba-team" style={{ color: teamColor }}>{p.team}</span>
        </div>
        <div className="oo-nba-r2">
          <span className="oo-nba-sal" title="Salary">{fmtSal(p.salary)}</span>
          <span className="oo-nba-proj" title="DK Fantasy Projection">{fmt(p.proj, 1)}</span>
          <span className="oo-nba-own" title="Simulated ownership" style={ownPct > 35 ? { color: 'var(--amber)', fontWeight: 600 } : {}}>{fmt(ownPct, 0)}%</span>
          <input type="number" min="0" max="100" value={minVal ?? minDefault}
            onChange={e => setCap(p.name, 'min', +e.target.value)}
            title={`${expScope === 'cpt' ? 'Captain' : expScope === 'flex' ? 'Flex' : 'Total'} min exposure % — ${p.name}`} />
          <input type="number" min="0" max="100" value={maxVal ?? maxDefault}
            onChange={e => setCap(p.name, 'max', +e.target.value)}
            title={`${expScope === 'cpt' ? 'Captain' : expScope === 'flex' ? 'Flex' : 'Total'} max exposure % — ${p.name}`} />
        </div>
      </li>;
    })}</ul>
    <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 14, paddingLeft: 4 }}>
      {sp.length} players in pool
      {sp.length < rp.filter(p => p.salary > 0).length && (
        <span style={{ marginLeft: 10, color: 'var(--amber-text)' }}>
          · {rp.filter(p => p.salary > 0 && !p.projectable).length} excluded (no DK line, no manual projection)
        </span>
      )}
    </div>
    <button className="btn btn-primary" onClick={run} disabled={!canBuild}
      title={canBuild ? '' : `Edit at least 2 projections first (${overrideCount}/2 changed)`}
      style={!canBuild ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}>
      <Icon name="bolt" size={14}/> Build {nL} {isShowdown ? 'Showdown' : 'Classic'} Lineups{contrarianOn ? ' (Contrarian)' : ''}
    </button>
    {res && <NBAExposureResults res={res} ownership={ownership} cptOwnership={cptOwnership} onRebuild={run} onExportDK={exportDK} onExportReadable={exportReadable} nL={nL} canBuild={canBuild} overrideCount={overrideCount} />}
  </>);
}

function NBAExposureResults({ res, ownership, cptOwnership = {}, onRebuild, onExportDK, onExportReadable, nL, canBuild, overrideCount }) {
  const isShowdown = res.isShowdown;
  const [view, setView] = useState('all');   // 'all' | 'cpt' | 'flex'

  // Tally CPT vs FLEX occurrences across the user's built lineups
  const { cptCnt, flexCnt } = useMemo(() => {
    const c = new Array(res.pData.length).fill(0);
    const f = new Array(res.pData.length).fill(0);
    if (isShowdown) {
      res.lineups.forEach(lu => {
        c[lu.cpt]++;
        lu.utils.forEach(i => f[i]++);
      });
    }
    return { cptCnt: c, flexCnt: f };
  }, [res, isShowdown]);

  // Per-player breakdown — each row has both the total / CPT / FLEX numbers
  // and the corresponding sim ownership from the top-1500 pool.
  const expRows = useMemo(() => {
    const N = res.lineups.length || 1;
    return res.pData.map((p, i) => {
      const total = res.counts[i];
      const cpt = cptCnt[i];
      const flex = flexCnt[i];
      const sal = p.util_salary || p.salary;
      const val = sal > 0 ? p.projection / (sal / 1000) : 0;
      const simOverall = ownership[p.name] || 0;
      const simCpt = cptOwnership[p.name] || 0;
      const simFlex = Math.max(0, simOverall - simCpt);
      return {
        name: p.name, team: p.team, salary: sal, projection: p.projection, val,
        totalCnt: total, cptCnt: cpt, flexCnt: flex,
        totalPct: total / N * 100,
        cptPct:   cpt   / N * 100,
        flexPct:  flex  / N * 100,
        simOverall, simCpt, simFlex,
      };
    });
  }, [res, cptCnt, flexCnt, ownership, cptOwnership]);

  // Apply view filter — compute pct/simOwn/cnt/lev relative to the chosen slot
  const displayRows = useMemo(() => {
    return expRows.map(p => {
      let pct, simOwn, cnt;
      if (isShowdown && view === 'cpt')        { pct = p.cptPct;   simOwn = p.simCpt;     cnt = p.cptCnt; }
      else if (isShowdown && view === 'flex')  { pct = p.flexPct;  simOwn = p.simFlex;    cnt = p.flexCnt; }
      else                                     { pct = p.totalPct; simOwn = p.simOverall; cnt = p.totalCnt; }
      const lev = Math.round((pct - simOwn) * 10) / 10;
      return { ...p, pct, simOwn, cnt, lev };
    });
  }, [expRows, view, isShowdown]);

  const { sorted, sortKey, sortDir, toggleSort } = useSort(displayRows, 'pct', 'desc');
  const S = p => <SH {...p} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />;

  const avgSal = res.lineups.length ? Math.round(res.lineups.reduce((s, lu) => s + lu.sal, 0) / res.lineups.length) : 0;
  const projMax = res.lineups.length ? Math.max(...res.lineups.map(lu => lu.proj)) : 0;
  const projMin = res.lineups.length ? Math.min(...res.lineups.map(lu => lu.proj)) : 0;
  const avgOwn = res.lineups.length ? Math.round(res.lineups.reduce((s, lu) => {
    const all = isShowdown ? [lu.cpt, ...lu.utils] : lu.players;
    const lineupOwn = all.reduce((ss, pi) => ss + (ownership[res.pData[pi].name] || 0), 0) / all.length;
    return s + lineupOwn;
  }, 0) / res.lineups.length) : 0;

  const viewLabel = view === 'cpt' ? 'Captain' : view === 'flex' ? 'Flex' : 'All Positions';
  const pctColLabel = view === 'cpt' ? 'CPT Exposure' : view === 'flex' ? 'FLEX Exposure' : 'Exposure';
  const simColLabel = view === 'cpt' ? 'Sim CPT %'    : view === 'flex' ? 'Sim FLEX %'   : 'Sim Own %';

  const viewTabStyle = (active) => ({
    padding: '6px 14px', fontSize: 12, fontWeight: 700, borderRadius: 6,
    border: `1px solid ${active ? 'var(--primary)' : 'var(--border)'}`,
    background: active ? 'rgba(245,197,24,0.14)' : 'var(--card)',
    color: active ? 'var(--primary)' : 'var(--text-muted)',
    cursor: 'pointer', transition: 'all 0.12s',
    letterSpacing: '0.03em', textTransform: 'uppercase',
  });

  return (<>
    <div style={{ marginTop: 20, padding: '10px 14px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13, color: 'var(--text-muted)' }}>
      <Icon name="check" size={14} color="#22C55E"/> Built <span style={{ color: 'var(--primary-glow)', fontWeight: 700 }}>{res.lineups.length}</span> lineups from {res.total.toLocaleString()} valid · Range: <span style={{ color: 'var(--green)' }}>{projMax}</span> → <span style={{ color: 'var(--text-dim)' }}>{projMin}</span> · Avg Sal: <span style={{ color: 'var(--primary-glow)', fontWeight: 600 }}>${avgSal.toLocaleString()}</span> · Avg Own: <span style={{ color: avgOwn > 35 ? 'var(--amber)' : 'var(--green)', fontWeight: 600 }}>{avgOwn}%</span>
    </div>
    <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
      {onRebuild && <button className="btn btn-primary" onClick={onRebuild} disabled={!canBuild} style={{ flex: '1 1 auto', width: 'auto', ...(canBuild ? {} : { opacity: 0.4, cursor: 'not-allowed' }) }}><Icon name="bolt" size={14}/> Rebuild {nL}</button>}
      {onExportDK && <button className="btn btn-primary" onClick={onExportDK} style={{ flex: '1 1 auto', width: 'auto', background: 'linear-gradient(135deg, #15803D, #22C55E)' }}><Icon name="download" size={14}/> Download DK Upload CSV</button>}
      {onExportReadable && <button className="btn btn-outline" onClick={onExportReadable} style={{ flex: '1 1 auto', width: 'auto', marginTop: 0 }}><Icon name="download" size={14}/> Readable CSV</button>}
    </div>

    <div className="section-head" style={{ marginTop: 22, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <span><Icon name="chart" size={16} color="#F5C518"/> Exposure <span style={{ fontSize: 12, color: 'var(--text-dim)', fontWeight: 500, marginLeft: 4 }}>· {viewLabel}</span></span>
      {isShowdown && (
        <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
          <button style={viewTabStyle(view === 'all')}  onClick={() => setView('all')}>All</button>
          <button style={viewTabStyle(view === 'cpt')}  onClick={() => setView('cpt')}>Captain</button>
          <button style={viewTabStyle(view === 'flex')} onClick={() => setView('flex')}>Flex</button>
        </div>
      )}
    </div>
    {isShowdown && (
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 8, paddingLeft: 2 }}>
        {view === 'all'  && 'Total exposure across all roster spots · Leverage compared to overall sim ownership'}
        {view === 'cpt'  && 'How often each player was your captain · Leverage compared to captain-slot sim ownership'}
        {view === 'flex' && 'How often each player was in your flex/utility slots · Leverage compared to flex-slot sim ownership'}
      </div>
    )}

    <div className="table-wrap" style={{ marginBottom: 20 }}><table><thead><tr>
      <S label="Player" colKey="name" /><th>Team</th>
      <S label="Salary" colKey="salary" />
      <S label="Proj" colKey="projection" />
      <S label="Val" colKey="val" />
      <S label="Count" colKey="cnt" />
      <S label={pctColLabel} colKey="pct" />
      <S label={simColLabel} colKey="simOwn" />
      <S label="Leverage" colKey="lev" />
    </tr></thead>
    <tbody>{sorted.map(p => <tr key={p.name}>
      <td className="name">{p.name}</td>
      <td>{p.team ? <TeamBadge team={p.team} /> : ''}</td>
      <td className="num">${p.salary.toLocaleString()}</td>
      <td className="num">{fmt(p.projection, 1)}</td>
      <td className="num">{fmt(p.val, 2)}</td>
      <td className="num">{p.cnt}</td>
      <td><span className="exp-bar-bg"><span className="exp-bar" style={{ width: Math.min(p.pct, 100) + '%' }} /></span>{fmt(p.pct, 1)}%</td>
      <td className="num muted">{fmt(p.simOwn, 1)}%</td>
      <td className="num"><span style={{ color: p.lev > 0 ? 'var(--green)' : p.lev < 0 ? 'var(--red)' : 'var(--text-dim)', fontWeight: Math.abs(p.lev) > 10 ? 700 : 400 }}>{p.lev > 0 ? '+' : ''}{fmt(p.lev, 1)}%</span></td>
    </tr>)}</tbody></table></div>

    <div className="section-head"><Icon name="target" size={16} color="#F5C518"/> Lineups</div>
    <div className="lineup-grid">{res.lineups.slice(0, 30).map((lu, idx) => {
      if (res.isShowdown) {
        const cpt = res.pData[lu.cpt];
        const utils = lu.utils.map(i => res.pData[i]);
        const allOwns = [cpt, ...utils].map(p => ownership[p.name] || 0);
        const avgO = Math.round(allOwns.reduce((a, b) => a + b, 0) / allOwns.length);
        return <div className="lu-card" key={idx}>
          <div className="lu-header"><span>#{idx + 1}</span><span className="lu-proj">{lu.proj} pts</span></div>
          <div className="lu-row">
            <span style={{ fontSize: 10, fontWeight: 700, color: '#F5C518', width: 44, flexShrink: 0, letterSpacing: 0.5 }}>CPT</span>
            <span className="lu-name">{cpt.name}</span>
            <span className="lu-opp"><TeamBadge team={cpt.team} /></span>
            <span className="lu-sal">${(cpt.cpt_salary || 0).toLocaleString()}</span>
            <span className="lu-pts">{fmt(cpt.projection * 1.5, 1)}</span>
          </div>
          {utils.map((p, j) => <div className="lu-row" key={p.name}>
            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', width: 44, flexShrink: 0, letterSpacing: 0.5 }}>UTIL</span>
            <span className="lu-name">{p.name}</span>
            <span className="lu-opp"><TeamBadge team={p.team} /></span>
            <span className="lu-sal">${(p.util_salary || p.salary).toLocaleString()}</span>
            <span className="lu-pts">{fmt(p.projection, 1)}</span>
          </div>)}
          <div className="lu-footer"><span>${lu.sal.toLocaleString()}</span><span style={{ color: avgO > 30 ? 'var(--amber)' : 'var(--green)' }}>Avg: {avgO}%</span></div>
        </div>;
      }
      // Classic
      const ps = lu.players.map(i => res.pData[i]).sort((a, b) => b.salary - a.salary);
      const lineupOwn = Math.round(ps.reduce((s, p) => s + (ownership[p.name] || 0), 0) / ps.length);
      return <div className="lu-card" key={idx}>
        <div className="lu-header"><span>#{idx + 1}</span><span className="lu-proj">{lu.proj} pts</span></div>
        {ps.map(p => <div className="lu-row" key={p.name}>
          <span className="lu-name">{p.name}</span>
          <span className="lu-opp"><TeamBadge team={p.team} /></span>
          <span className="lu-sal">${p.salary.toLocaleString()}</span>
          <span className="lu-pts">{fmt(p.projection, 1)}</span>
        </div>)}
        <div className="lu-footer"><span>${lu.sal.toLocaleString()}</span><span style={{ color: lineupOwn > 30 ? 'var(--amber)' : 'var(--green)' }}>Avg: {lineupOwn}%</span></div>
      </div>;
    })}</div>
    {res.lineups.length > 30 && <div style={{ textAlign: 'center', color: 'var(--text-dim)', fontSize: 13, marginTop: 8 }}>+ {res.lineups.length - 30} more</div>}
  </>);
}
