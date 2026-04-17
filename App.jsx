import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { processMatch, dkProjection, ppProjection, ppEV, optimize } from './engine.js';
const GLOSSARY = [
  { emoji: '🏆', label: 'Top 3 Value', desc: 'Highest pts/$1K salary' },
  { emoji: '🎯', label: 'Top 3 Straight Sets', desc: 'Most likely straight-set win (+6 bonus)' },
  { emoji: '💎', label: 'Hidden Gem', desc: 'Low ownership + high upside' },
  { emoji: '💣', label: 'Trap', desc: 'High ownership + bust risk' },
  { emoji: '🔥', label: 'Top PP EV', desc: 'Best expected value vs PP line' },
  { emoji: '📉', label: 'Worst PP EV', desc: 'Strong LESS play' },
];
function useSlateData() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { fetch('./slate.json').then(r => { if (!r.ok) throw new Error('No slate'); return r.json(); }).then(setData).catch(e => setError(e.message)); }, []);
  return { data, error };
}
function buildProjections(data) {
  if (!data) return { dkPlayers: [], ppRows: [] };
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
        brkOver: side === 'player_a' ? match.odds.brk_a_over : match.odds.brk_b_over,
        brkLine: side === 'player_a' ? match.odds.brk_a_line : match.odds.brk_b_line,
        brkUnder: side === 'player_a' ? -(Math.abs(match.odds.brk_a_over) + 30) : -(Math.abs(match.odds.brk_b_over) + 30),
      });
    });
  });

  const ppRows = [];
  if (data.pp_lines) {
    data.pp_lines.forEach(line => {
      const player = dkPlayers.find(p => p.name === line.player);
      let projected = 0;
      if (!player) { ppRows.push({ player: line.player, stat: line.stat, line: line.line, projected: 0, ev: 0, pOver: 0.5, edge: 0, winPP: 0, opponent: '?', wp: 0, direction: '-', mult: line.mult || '', scenarioData: null, bpData: null }); return; }

      if (line.stat === 'Fantasy Score') projected = player.ppProj;
      else if (line.stat === 'Breaks') projected = player.breaks;
      else if (line.stat === 'Games Won') projected = player.gw;
      else if (line.stat === 'Total Games') projected = player.gw + player.gl;
      else if (line.stat === 'Aces') projected = player.aces;
      else if (line.stat === 'Double Faults') projected = player.dfs;
      else if (line.stat === 'Sets Won') projected = player.sw;

      // Universal edge: projected - line (positive = MORE, negative = LESS)
      const ev = ppEV(projected, line.line);
      const pOver = 0;
      const winPP = projected;
      ppRows.push({ player: line.player, stat: line.stat, line: line.line, projected: Math.round(projected * 100) / 100, ev, opponent: player.opponent, wp: player.wp, direction: ev > 0 ? 'MORE' : ev < 0 ? 'LESS' : '-', mult: line.mult || '' });
    });
  }
  return { dkPlayers, ppRows };
}
function simulateOwnership(players, n = 1300) {
  const pData = players.filter(p => p.salary > 0).map(p => ({ name: p.name, salary: p.salary, id: p.id, projection: p.proj, opponent: p.opponent, maxExp: 100, minExp: 0 }));
  try { const res = optimize(pData, n, 50000, 6); const own = {}; pData.forEach((p, i) => { own[p.name] = res.counts[i] / res.lineups.length * 100; }); return own; } catch { return {}; }
}
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
function Tip({ emoji, label }) { const [s, setS] = useState(false); return <span style={{ position: 'relative', cursor: 'help' }} onMouseEnter={() => setS(true)} onMouseLeave={() => setS(false)}>{emoji}{s && <span style={{ position: 'absolute', bottom: '120%', left: '50%', transform: 'translateX(-50%)', background: '#1E2433', border: '1px solid #2A3040', borderRadius: 6, padding: '6px 10px', fontSize: 11, color: '#E2E8F0', whiteSpace: 'nowrap', zIndex: 999, fontWeight: 500 }}>{label}</span>}</span>; }

export default function App() {
  const { data, error } = useSlateData();
  const [tab, setTab] = useState('dk');
  const { dkPlayers, ppRows } = useMemo(() => buildProjections(data), [data]);
  const ownership = useMemo(() => dkPlayers.length > 0 ? simulateOwnership(dkPlayers) : {}, [dkPlayers]);
  if (error) return <div className="app"><div className="empty"><h2>No Slate Loaded</h2><p>Push slate.json and redeploy.</p></div></div>;
  if (!data) return <div className="app"><div className="empty"><h2>Loading...</h2></div></div>;
  const tabs = [{ id: 'dk', l: 'DK Projections' }, { id: 'pp', l: 'PP Projections' }, { id: 'build', l: 'Lineup Builder' }, { id: 'leverage', l: 'Live Leverage' }, { id: 'export', l: 'Export' }];
  return (<div className="app">
    <div className="topbar"><div className="topbar-brand"><img src="./logo.png" alt="DD" onError={e => { e.target.onerror = null; e.target.src = '/logo.png'; }} /><span>DeuceData</span></div><div className="topbar-date">{data.date} · {data.matches.length} matches{data.last_updated && <> · <span style={{color:'var(--green)',fontSize:12}}>Updated {data.last_updated}</span></>}</div></div>
    <div className="tab-bar">{tabs.map(t => <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>{t.l}</button>)}</div>
    <div className="content">
      {tab === 'dk' && <DKTab players={dkPlayers} mc={data.matches.length} own={ownership} />}
      {tab === 'pp' && <PPTab rows={ppRows} />}
      {tab === 'build' && <BuilderTab players={dkPlayers} ownership={ownership} />}
      {tab === 'leverage' && <LeverageTab players={dkPlayers} />}
      {tab === 'export' && <ExportTab players={dkPlayers} />}
    </div>
  </div>);
}

function DKTab({ players, mc, own }) {
  const pw = useMemo(() => players.filter(p => p.salary > 0).map(p => ({ ...p, simOwn: own[p.name] || 0 })), [players, own]);
  const { sorted, sortKey, sortDir, toggleSort } = useSort(pw, 'val', 'desc');
  const t3v = useMemo(() => [...players].sort((a, b) => b.val - a.val).slice(0, 3).map(p => p.name), [players]);
  const t3s = useMemo(() => [...players].sort((a, b) => b.pStraight - a.pStraight).slice(0, 3).map(p => p.name), [players]);
  const trap = useMemo(() => {
    const hasOwn = pw.some(p => p.simOwn > 0);
    const s = hasOwn ? [...pw].sort((a, b) => b.simOwn - a.simOwn) : [...pw].sort((a, b) => b.proj - a.proj);
    return s[0]?.name || '';
  }, [pw]);
  const gem = useMemo(() => { const t = pw.find(p => p.name === trap); return t?.opponent || ''; }, [pw, trap]);
  const S = p => <SH {...p} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />;
  return (<>
    {/* Legend - always visible */}
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10, padding: 14, marginBottom: 16, display: 'flex', gap: 20, flexWrap: 'wrap' }}>
      {GLOSSARY.filter(g => '🏆🎯💎💣'.includes(g.emoji)).map(g => <div key={g.emoji} style={{ fontSize: 12 }}><span style={{ fontSize: 16, marginRight: 6 }}>{g.emoji}</span><span style={{ color: 'var(--text)', fontWeight: 600 }}>{g.label}</span><span style={{ color: 'var(--text-dim)', marginLeft: 6 }}>— {g.desc}</span></div>)}
    </div>
    <div className="metrics">
      <div className="metric"><div className="metric-label">🏆 Top Value</div><div className="metric-value">{t3v.map((n, i) => { const p = players.find(x => x.name === n); return <div key={i} style={{ fontSize: i === 0 ? '16px' : '13px', color: i === 0 ? undefined : 'var(--text-muted)' }}>{i + 1}. {n} <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{fmt(p?.val, 2)}</span></div>; })}</div></div>
      <div className="metric"><div className="metric-label">🎯 Top Straight Sets</div><div className="metric-value">{t3s.map((n, i) => { const p = players.find(x => x.name === n); return <div key={i} style={{ fontSize: i === 0 ? '16px' : '13px', color: i === 0 ? undefined : 'var(--text-muted)' }}>{n} <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{fmtPct(p?.pStraight)}</span></div>; })}</div></div>
      <div className="metric"><div className="metric-label">💎 Hidden Gem</div><div className="metric-value" style={{ color: 'var(--green)' }}>{gem || '-'}</div><div className="metric-sub">Low ownership, high upside</div></div>
      <div className="metric"><div className="metric-label">💣 Biggest Trap</div><div className="metric-value" style={{ color: 'var(--red)' }}>{trap || '-'}</div><div className="metric-sub">High ownership, bust risk</div></div>
    </div>
    <div className="table-wrap"><table><thead><tr><th>#</th><th></th><S label="Player" colKey="name" /><S label="Opp" colKey="opponent" /><S label="Salary" colKey="salary" /><S label="Own%" colKey="simOwn" /><S label="Win%" colKey="wp" /><S label="Proj" colKey="proj" /><S label="Value" colKey="val" /><S label="P(2-0)" colKey="pStraight" /><S label="GW" colKey="gw" /><S label="GL" colKey="gl" /><S label="SW" colKey="sw" /><S label="Aces" colKey="aces" /><S label="DFs" colKey="dfs" /><S label="Brks" colKey="breaks" /><S label="Time" colKey="startTime" /></tr></thead>
    <tbody>{sorted.map((p, i) => {
      const iv = t3v.includes(p.name), is = t3s.includes(p.name), ig = p.name === gem, it = p.name === trap;
      let b = ''; if (iv) b += '🏆'; if (is) b += '🎯'; if (ig) b += '💎'; if (it) b += '💣';
      return <tr key={p.name} style={ig ? { background: 'rgba(34,197,94,0.06)' } : it ? { background: 'rgba(239,68,68,0.06)' } : undefined}>
        <td className="muted">{i + 1}</td>
        <td style={{ fontSize: 14 }}>{b && [...b].filter((_, j) => j % 2 === 0).map((e, j) => { const em = b.substring(j*2, j*2+2); return <Tip key={j} emoji={em} label={em === '🏆' ? 'Top 3 Value' : em === '🎯' ? 'Top 3 Straight Sets' : em === '💎' ? 'Hidden Gem' : 'Trap'} />; })}</td>
        <td className="name">{p.name}</td><td className="muted">{p.opponent}</td>
        <td className="num">{fmtSal(p.salary)}</td>
        <td className="num" style={{ color: p.simOwn > 30 ? 'var(--amber)' : 'var(--text-muted)' }}>{fmt(p.simOwn, 1)}%</td>
        <td className="num">{fmtPct(p.wp)}</td>
        <td className="num"><span className={iv ? 'cell-top3' : 'cell-proj'}>{fmt(p.proj, 2)}</span></td>
        <td className="num"><span className={iv ? 'cell-top3' : ''}>{fmt(p.val, 2)}</span></td>
        <td className="num"><span className={is ? 'cell-top3' : ''}>{fmtPct(p.pStraight)}</span></td>
        <td className="num">{fmt(p.gw)}</td><td className="num muted">{fmt(p.gl)}</td><td className="num">{fmt(p.sw)}</td>
        <td className="num">{fmt(p.aces)}</td><td className="num muted">{fmt(p.dfs)}</td><td className="num">{fmt(p.breaks)}</td>
        <td className="muted">{fmtTime(p.startTime)}</td>
      </tr>; })}</tbody></table></div>
  </>);
}

function PPTab({ rows }) {
  // Unify all rows with a consistent edge value for sorting
  const { sorted, sortKey, sortDir, toggleSort } = useSort(rows, 'ev', 'desc');
  const S = p => <SH {...p} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />;
  const best = useMemo(() => [...rows].sort((a, b) => b.ev - a.ev).slice(0, 3), [rows]);
  const worst = useMemo(() => [...rows].sort((a, b) => a.ev - b.ev).slice(0, 3), [rows]);

  return (<>
    <div className="section-head">🎾 PrizePicks Projections</div>
    <div className="section-sub">All plays sorted by edge · Edge = Projected - PP Line</div>
    <div className="metrics">
      <div className="metric"><div className="metric-label">🔥 Best Edge</div><div className="metric-value">{best.map((r, i) => <div key={i} style={{ fontSize: i === 0 ? '15px' : '12px', color: 'var(--green)' }}>{r.player} · {r.stat} <span style={{fontSize:11}}>{r.ev > 0 ? '+' : ''}{fmt(r.ev, 2)}</span>{r.mult && <span style={{fontSize:10,color:'var(--amber)',marginLeft:4}}>{r.mult}</span>}</div>)}</div></div>
      <div className="metric"><div className="metric-label">📉 Biggest Fade</div><div className="metric-value">{worst.map((r, i) => <div key={i} style={{ fontSize: i === 0 ? '15px' : '12px', color: 'var(--red)' }}>{r.player} · {r.stat} <span style={{fontSize:11}}>{fmt(r.ev, 2)}</span></div>)}</div></div>
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
            const projLabel = fmt(r.projected, 2);
      const playDir = r.direction;
      return <tr key={r.player + r.stat} style={isBest ? {background:'rgba(34,197,94,0.06)'} : isWorst ? {background:'rgba(239,68,68,0.06)'} : undefined}>
        <td className="muted">{i+1}</td>
        <td>{isBest ? <Tip emoji="🔥" label="Best edge" /> : isWorst ? <Tip emoji="📉" label="Fade" /> : ''}</td>
        <td className="name">{r.player}</td>
        <td style={{fontSize:11,color:'var(--text-muted)'}}>{r.stat}</td>
        <td className="num">{fmt(r.line, 1)}</td>
        <td className="num"><span className="cell-proj">{projLabel}</span></td>
        <td className="num"><span className={isBest ? 'cell-ev-top' : isWorst ? 'cell-ev-worst' : r.ev > 0 ? 'cell-ev-pos' : 'cell-ev-neg'}>{r.ev > 0 ? '+' : ''}{fmt(r.ev, 2)}</span></td>
        <td><span style={{color: playDir === 'MORE' ? 'var(--green)' : playDir === 'LESS' ? 'var(--red)' : 'var(--text-dim)', fontWeight:600}}>{playDir}</span></td>
        <td style={{color:'var(--amber)',fontSize:11}}>{r.mult || ''}</td>
        <td className="num muted">{fmtPct(r.wp)}</td>
        <td className="muted">{r.opponent}</td>
      </tr>;
    })}</tbody></table></div>
  </>);
}

function BuilderTab({ players: rp, ownership }) {
  const [exp, setExp] = useState({}); const [res, setRes] = useState(null);
  const [nL, setNL] = useState(45);
  const [globalMax, setGlobalMax] = useState(100); const [globalMin, setGlobalMin] = useState(0);
  const sp = useMemo(() => [...rp].filter(p => p.salary > 0).sort((a, b) => b.val - a.val), [rp]);
  const sE = (n, f, v) => setExp(p => ({ ...p, [n]: { ...p[n], [f]: v } }));
  const applyGlobal = () => { const ne = {}; sp.forEach(p => { ne[p.name] = { min: globalMin, max: globalMax, ...exp[p.name] }; }); setExp(ne); };
  const run = () => { const pd = sp.map(p => ({ name: p.name, salary: p.salary, id: p.id, projection: p.proj, opponent: p.opponent, maxExp: exp[p.name]?.max ?? globalMax, minExp: exp[p.name]?.min ?? globalMin })); const r = optimize(pd, nL, 50000, 6); setRes({ ...r, pData: pd }); };
  return (<>
    <div className="section-head">⚡ Lineup Builder</div><div className="section-sub">Set exposure %, build optimized lineups</div>
    <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
      <label style={{ fontSize: 13, color: 'var(--text-muted)' }}>Lineups: <input style={{ width: 60, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', padding: '4px 8px', marginLeft: 4 }} type="number" value={nL} onChange={e => setNL(+e.target.value)} /></label>
      <label style={{ fontSize: 13, color: 'var(--text-muted)' }}>Global Min %: <input style={{ width: 50, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', padding: '4px 8px', marginLeft: 4 }} type="number" value={globalMin} onChange={e => setGlobalMin(+e.target.value)} /></label>
      <label style={{ fontSize: 13, color: 'var(--text-muted)' }}>Global Max %: <input style={{ width: 50, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', padding: '4px 8px', marginLeft: 4 }} type="number" value={globalMax} onChange={e => setGlobalMax(+e.target.value)} /></label>
      <button onClick={applyGlobal} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-muted)', padding: '4px 12px', fontSize: 12, cursor: 'pointer' }}>Apply Global</button>
    </div>
    <div className="builder-controls">{sp.map(p => <div className="ctrl-row" key={p.name}><span className="ctrl-name">{p.name}</span><span style={{ color: 'var(--text-dim)', fontSize: 11, width: 55 }}>{fmtSal(p.salary)}</span><span className="ctrl-proj">{fmt(p.proj, 1)}</span><input type="number" value={exp[p.name]?.min ?? globalMin} onChange={e => sE(p.name, 'min', +e.target.value)} title="Min %" /><input type="number" value={exp[p.name]?.max ?? globalMax} onChange={e => sE(p.name, 'max', +e.target.value)} title="Max %" /></div>)}</div>
    <button className="btn btn-primary" onClick={run}>⚡ Build {nL} Lineups</button>
    {res && <ExposureResults res={res} ownership={ownership} />}
  </>);
}

function ExposureResults({ res, ownership }) {
  const expData = useMemo(() => res.pData.map((p, i) => {
    const cnt = res.counts[i]; const pct = cnt / res.lineups.length * 100;
    const simOwn = ownership[p.name] || 0; const lev = Math.round((pct - simOwn) * 10) / 10;
    const val = p.projection / (p.salary / 1000);
    return { name: p.name, salary: p.salary, projection: p.projection, val, cnt, pct, simOwn, lev };
  }), [res, ownership]);
  const avgSal = Math.round(res.lineups.reduce((s, lu) => s + lu.sal, 0) / res.lineups.length);
  const { sorted, sortKey, sortDir, toggleSort } = useSort(expData, 'pct', 'desc');
  const S = p => <SH {...p} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />;
  return (<>
    <div style={{ marginTop: 20, padding: '10px 14px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13, color: 'var(--text-muted)' }}>✅ Built <span style={{ color: 'var(--primary-glow)', fontWeight: 700 }}>{res.lineups.length}</span> lineups from {res.total.toLocaleString()} valid · Range: <span style={{ color: 'var(--green)' }}>{res.lineups[0]?.proj}</span> → <span style={{ color: 'var(--text-dim)' }}>{res.lineups[res.lineups.length - 1]?.proj}</span> · Avg Salary: <span style={{ color: 'var(--primary-glow)', fontWeight: 600 }}>${avgSal.toLocaleString()}</span></div>
    <div className="section-head" style={{ marginTop: 20 }}>📊 Exposure</div>
    <div className="table-wrap" style={{ marginBottom: 20 }}><table><thead><tr>
      <S label="Player" colKey="name" /><S label="Salary" colKey="salary" /><S label="Proj" colKey="projection" /><S label="Value" colKey="val" /><S label="Count" colKey="cnt" /><S label="Exposure" colKey="pct" /><S label="Sim Own" colKey="simOwn" /><S label="Leverage" colKey="lev" />
    </tr></thead>
    <tbody>{sorted.map(p => <tr key={p.name}><td className="name">{p.name}</td><td className="num">${p.salary.toLocaleString()}</td><td className="num">{fmt(p.projection, 1)}</td><td className="num">{fmt(p.val, 2)}</td><td className="num">{p.cnt}</td><td><span className="exp-bar-bg"><span className="exp-bar" style={{ width: Math.min(p.pct, 100) + '%' }} /></span>{fmt(p.pct, 1)}%</td><td className="num muted">{fmt(p.simOwn, 1)}%</td><td className="num"><span style={{ color: p.lev > 0 ? 'var(--green)' : p.lev < 0 ? 'var(--red)' : 'var(--text-dim)', fontWeight: Math.abs(p.lev) > 10 ? 700 : 400 }}>{p.lev > 0 ? '+' : ''}{fmt(p.lev, 1)}%</span></td></tr>)}</tbody></table></div>
    <div className="section-head">🎯 Lineups</div>
    <div className="lineup-grid">{res.lineups.slice(0, 30).map((lu, idx) => { const ps = lu.players.map(i => res.pData[i]).sort((a, b) => b.salary - a.salary); return <div className="lu-card" key={idx}><div className="lu-header"><span>#{idx + 1}</span><span className="lu-proj">{lu.proj} pts</span></div>{ps.map(p => <div className="lu-row" key={p.name}><span className="lu-name">{p.name}</span><span className="lu-opp">vs {p.opponent}</span><span className="lu-sal">${p.salary.toLocaleString()}</span><span className="lu-pts">{fmt(p.projection, 1)}</span></div>)}<div className="lu-footer"><span>${lu.sal.toLocaleString()}</span><span>{lu.proj}</span></div></div>; })}</div>
    {res.lineups.length > 30 && <div style={{ textAlign: 'center', color: 'var(--text-dim)', fontSize: 13, marginTop: 8 }}>+ {res.lineups.length - 30} more</div>}
  </>);
}

function LeverageTab({ players: rp }) {
  const [cd, setCd] = useState(null); const [ul, setUl] = useState(null); const [err, setErr] = useState('');
  const handleContest = e => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = evt => { try { const lines = evt.target.result.split('\n'); const own = {}; let ec = 0; for (const line of lines) { if (line.includes(',') && rp.some(p => line.includes(p.name))) { ec++; for (const p of rp) { if (line.includes(p.name)) own[p.name] = (own[p.name] || 0) + 1; } } } if (ec > 0) { const op = {}; for (const [n, c] of Object.entries(own)) op[n] = Math.round(c / ec * 1000) / 10; setCd(op); setErr(''); } else setErr('No player data found in CSV'); } catch (e) { setErr(e.message); } }; r.readAsText(f); };
  const handleUser = e => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = evt => { try { const lines = evt.target.result.split('\n'); const cnt = {}; let lc = 0; for (const line of lines) { if (!line.trim() || line.startsWith('P,') || line.startsWith('Rank')) continue; const hasP = rp.some(p => line.includes(p.name) || line.includes(String(p.id))); if (hasP) { lc++; for (const p of rp) { if (line.includes(p.name) || line.includes(String(p.id))) cnt[p.name] = (cnt[p.name] || 0) + 1; } } } if (lc > 0) { const ep = {}; for (const [n, c] of Object.entries(cnt)) ep[n] = Math.round(c / lc * 1000) / 10; setUl({ counts: ep, total: lc }); } } catch (e) { setErr(e.message); } }; r.readAsText(f); };
  const ld = useMemo(() => { if (!cd || !ul) return []; return rp.map(p => ({ name: p.name, salary: p.salary, proj: p.proj, val: p.val, userExp: ul.counts[p.name] || 0, fieldOwn: cd[p.name] || 0, leverage: Math.round(((ul.counts[p.name] || 0) - (cd[p.name] || 0)) * 10) / 10, opponent: p.opponent })).sort((a, b) => b.leverage - a.leverage); }, [cd, ul, rp]);
  return (<>
    <div className="section-head">🔄 Live Leverage</div><div className="section-sub">Upload contest CSV + your lineups to compare vs the field</div>
    <div style={{ display: 'flex', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
      <div className="metric" style={{ flex: 1, minWidth: 250 }}><div className="metric-label">Step 1: Contest CSV</div><div className="metric-sub" style={{ marginTop: 4 }}>DK contest file after lock</div><input type="file" accept=".csv" onChange={handleContest} style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }} />{cd && <div style={{ color: 'var(--green)', fontSize: 12, marginTop: 4 }}>✅ {Object.keys(cd).length} players</div>}</div>
      <div className="metric" style={{ flex: 1, minWidth: 250 }}><div className="metric-label">Step 2: Your Lineups</div><div className="metric-sub" style={{ marginTop: 4 }}>Your DK upload or readable CSV</div><input type="file" accept=".csv" onChange={handleUser} style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }} />{ul && <div style={{ color: 'var(--green)', fontSize: 12, marginTop: 4 }}>✅ {ul.total} lineups</div>}</div>
    </div>
    {err && <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 12 }}>⚠️ {err}</div>}
    {ld.length > 0 && <>
      <div className="metrics">
        <div className="metric"><div className="metric-label">💎 Top Leverage</div><div className="metric-value" style={{ color: 'var(--green)' }}>{ld[0]?.name}</div><div className="metric-sub">You: {ld[0]?.userExp}% · Field: {ld[0]?.fieldOwn}% · +{ld[0]?.leverage}%</div></div>
        <div className="metric"><div className="metric-label">💣 Most Underweight</div><div className="metric-value" style={{ color: 'var(--red)' }}>{ld[ld.length - 1]?.name}</div><div className="metric-sub">You: {ld[ld.length - 1]?.userExp}% · Field: {ld[ld.length - 1]?.fieldOwn}% · {ld[ld.length - 1]?.leverage}%</div></div>
      </div>
      <div className="table-wrap"><table><thead><tr><th>#</th><th></th><th>Player</th><th>Opp</th><th>Proj</th><th>Your Exp</th><th>Field Own</th><th>Leverage</th></tr></thead>
      <tbody>{ld.map((p, i) => <tr key={p.name} style={p.leverage > 10 ? { background: 'rgba(34,197,94,0.06)' } : p.leverage < -10 ? { background: 'rgba(239,68,68,0.06)' } : undefined}><td className="muted">{i + 1}</td><td>{p.leverage > 10 ? <Tip emoji="💎" label="Strong overweight" /> : p.leverage < -10 ? <Tip emoji="💣" label="Underweight" /> : ''}</td><td className="name">{p.name}</td><td className="muted">{p.opponent}</td><td className="num">{fmt(p.proj, 1)}</td><td className="num" style={{ color: 'var(--primary-glow)' }}>{fmt(p.userExp, 1)}%</td><td className="num muted">{fmt(p.fieldOwn, 1)}%</td><td className="num"><span style={{ color: p.leverage > 0 ? 'var(--green)' : p.leverage < 0 ? 'var(--red)' : 'var(--text-dim)', fontWeight: Math.abs(p.leverage) > 10 ? 700 : 500, background: Math.abs(p.leverage) > 15 ? (p.leverage > 0 ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.12)') : 'transparent', padding: '2px 8px', borderRadius: 4 }}>{p.leverage > 0 ? '+' : ''}{fmt(p.leverage, 1)}%</span></td></tr>)}</tbody></table></div>
    </>}
    {!cd && !ul && <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-dim)' }}><div style={{ fontSize: 32, marginBottom: 8 }}>🔄</div><div style={{ fontSize: 14 }}>Upload both CSVs to see leverage vs field</div></div>}
  </>);
}

function ExportTab({ players }) {
  const sp = useMemo(() => [...players].filter(p => p.salary > 0).sort((a, b) => b.val - a.val), [players]);
  const dl = (c, f) => { const b = new Blob([c], { type: 'text/csv' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = f; a.click(); URL.revokeObjectURL(a.href); };
  const eDK = () => { const pd = sp.map(p => ({ name: p.name, salary: p.salary, id: p.id, projection: p.proj, opponent: p.opponent, maxExp: 100, minExp: 0 })); const r = optimize(pd, 45, 50000, 6); let c = 'P,P,P,P,P,P\n'; r.lineups.forEach(lu => { const ps = lu.players.map(i => pd[i]).sort((a, b) => b.salary - a.salary); c += ps.map(p => p.id).join(',') + '\n'; }); dl(c, 'dk_upload.csv'); };
  const eR = () => { const pd = sp.map(p => ({ name: p.name, salary: p.salary, id: p.id, projection: p.proj, opponent: p.opponent, maxExp: 100, minExp: 0 })); const r = optimize(pd, 45, 50000, 6); let c = 'Rank,Proj,Salary,P1,P2,P3,P4,P5,P6\n'; r.lineups.forEach((lu, i) => { const ps = lu.players.map(j => pd[j]).sort((a, b) => b.salary - a.salary); c += `${i + 1},${lu.proj},${lu.sal},${ps.map(p => p.name).join(',')}\n`; }); dl(c, 'lineups.csv'); };
  const eP = () => { let c = 'Player,Salary,Win%,Proj,Value,GW,GL,SW,Aces,DFs,Breaks,P(2-0),Opp\n'; sp.forEach(p => { c += `${p.name},${p.salary},${(p.wp * 100).toFixed(0)}%,${p.proj},${p.val},${fmt(p.gw)},${fmt(p.gl)},${fmt(p.sw)},${fmt(p.aces)},${fmt(p.dfs)},${fmt(p.breaks)},${fmtPct(p.pStraight)},${p.opponent}\n`; }); dl(c, 'projections.csv'); };
  return (<><div className="section-head">📥 Export</div><div className="section-sub">Download lineup files</div><div style={{ maxWidth: 400, display: 'flex', flexDirection: 'column', gap: 8 }}><button className="btn btn-primary" onClick={eDK}>📥 DraftKings Upload CSV</button><button className="btn btn-outline" onClick={eR}>📥 Readable Lineups CSV</button><button className="btn btn-outline" onClick={eP}>📥 Projections CSV</button></div></>);
}
