import './style.css';
import {
  BALL, BALL_IDS, DIAMOND, KO, TABLE, WALL_KO, simulate,
  type BallId, type Layout, type Pos, type Shot, type SimResult, type Wall,
} from './physics';
import { calibrate, railPoint, solveSystem, type SystemResult } from './systems';
import type { Candidate, WorkerRequest, WorkerResponse } from './worker';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const R = BALL.R;
const COLORS: Record<BallId, string> = { white: '#f7f7f2', yellow: '#f4c430', red: '#d9262c' };

// ───────── 상태 ─────────
const PRESETS: { name: string; layout: Layout }[] = [
  { name: '초구 배치', layout: { white: { x: 0.71, y: 0.71 - 0.1524 }, yellow: { x: 0.71, y: 0.71 }, red: { x: 2.13, y: 0.71 } } },
  { name: '예시 A — 장쿠션 근처 적구', layout: { white: { x: 0.85, y: 0.42 }, yellow: { x: 1.55, y: 1.25 }, red: { x: 2.35, y: 0.95 } } },
  { name: '예시 B — 코너 몰림', layout: { white: { x: 1.9, y: 0.6 }, yellow: { x: 0.4, y: 1.15 }, red: { x: 2.55, y: 1.2 } } },
  { name: '예시 C — 중앙 배치', layout: { white: { x: 1.2, y: 0.9 }, yellow: { x: 1.65, y: 0.65 }, red: { x: 0.3, y: 0.25 } } },
];
let layout: Layout = clone(PRESETS[0].layout);
let shot: Shot = { cue: 'white', angleDeg: 6, speed: 3.2, tipX: 0.3, tipY: 0.2 };
let result: SimResult;
let prob: number | null = null;
let sysRes: SystemResult | null = null;
let candidates: Candidate[] = [];
let anim: { start: number; rate: number } | null = null;

function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)); }

// ───────── 워커 ─────────
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
let reqId = 0, probId = 0, searchId = 0;
worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
  const m = ev.data;
  if (m.kind === 'prob' && m.id === probId) { prob = m.value; renderDetail(); }
  if (m.kind === 'progress' && m.id === searchId) ($('progress').firstElementChild as HTMLElement).style.width = `${m.value * 100}%`;
  if (m.kind === 'search' && m.id === searchId) { candidates = m.candidates; $('progress').classList.add('hidden'); renderCands(); }
};
const send = (r: WorkerRequest) => worker.postMessage(r);
let probTimer = 0;
function requestProb() {
  prob = null;
  clearTimeout(probTimer);
  probTimer = window.setTimeout(() => { probId = ++reqId; send({ kind: 'prob', id: probId, layout, shot }); }, 200);
}

// ───────── 예측 ─────────
let pending = false;
let interacting = false; // 드래그 중에는 가벼운 시뮬레이션으로 반응성 확보
function recompute() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    result = simulate(layout, shot, interacting ? { dt: 0.001, maxTime: 15 } : {});
    anim = null;
    if (!interacting) requestProb();
    syncInputs();
    renderDetail();
    draw();
  });
}

// ───────── 테이블 캔버스 ─────────
const cv = $<HTMLCanvasElement>('table');
const ctx = cv.getContext('2d')!;
const RAIL = 0.15; // 나무 레일 + 쿠션 (화면용, m)
const stage = $('stage');
const mobileMq = matchMedia('(max-width: 960px)');
const landscapeMq = matchMedia('(max-width: 960px) and (orientation: landscape) and (max-height: 600px)');
let S = 300, OX = 0, OY = 0;
let vertical = false; // 세로 화면에서는 테이블을 90° 돌려서 더 크게 표시
let lastBox = '';
function resize() {
  // 가로 휴대폰: 그리드 칸 높이에 맞춤 / 세로 모바일: 화면 높이의 56%까지 / 데스크톱: 72%까지
  const fill = landscapeMq.matches;
  const boxW = stage.clientWidth;
  const boxH = fill ? stage.clientHeight : Math.max(200, innerHeight * (mobileMq.matches ? 0.56 : 0.72));
  const fullL = TABLE.L + 2 * RAIL, fullW = TABLE.W + 2 * RAIL;
  const sH = Math.min(boxW / fullL, boxH / fullW);
  const sV = Math.min(boxW / fullW, boxH / fullL);
  vertical = sV > sH * 1.1;
  S = vertical ? sV : sH;
  const w = (vertical ? fullW : fullL) * S, h = (vertical ? fullL : fullW) * S;
  const key = `${w}x${h}`;
  stage.style.height = fill ? '' : `${h}px`;
  const dpr = devicePixelRatio || 1;
  if (key !== lastBox) {
    lastBox = key;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    cv.style.width = `${w}px`; cv.style.height = `${h}px`;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  OX = RAIL * S; OY = RAIL * S;
  draw();
}
// 테이블 좌표(m) ↔ 화면 좌표(px). 세로 모드: 테이블 +x 가 화면 위쪽, +y 가 화면 왼쪽
const px = (p: Pos): [number, number] => vertical
  ? [OX + (TABLE.W - p.y) * S, OY + (TABLE.L - p.x) * S]
  : [OX + p.x * S, OY + (TABLE.W - p.y) * S];
const toTable = (cx: number, cy: number): Pos => vertical
  ? { x: TABLE.L - (cy - OY) / S, y: TABLE.W - (cx - OX) / S }
  : { x: (cx - OX) / S, y: TABLE.W - (cy - OY) / S };

function draw() {
  if (!result) return;
  const W = cv.clientWidth, H = cv.clientHeight;
  ctx.clearRect(0, 0, W, H);
  // 레일
  const wood = ctx.createLinearGradient(0, 0, 0, H);
  wood.addColorStop(0, '#5b3a22'); wood.addColorStop(1, '#3e2615');
  ctx.fillStyle = wood;
  roundRect(0, 0, W, H, 16); ctx.fill();
  // 쿠션 고무
  const cu = 0.045 * S;
  const cw = (vertical ? TABLE.W : TABLE.L) * S, ch = (vertical ? TABLE.L : TABLE.W) * S;
  ctx.fillStyle = '#17508a';
  ctx.fillRect(OX - cu, OY - cu, cw + 2 * cu, ch + 2 * cu);
  // 천
  const cloth = ctx.createRadialGradient(W / 2, H / 2, 10, W / 2, H / 2, Math.max(W, H) * 0.6);
  cloth.addColorStop(0, '#2a74c4'); cloth.addColorStop(1, '#1d5ea6');
  ctx.fillStyle = cloth;
  ctx.fillRect(OX, OY, cw, ch);

  // 다이아몬드 + 번호 (번호는 레일 바깥쪽)
  ctx.font = `${Math.max(9, S * 0.032)}px sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const off = 0.085, lab = 0.125;
  const mark = (p: Pos, q: Pos, show: boolean, text: string) => {
    ctx.fillStyle = '#efe6d2';
    if (show) diamond(...px(p));
    ctx.fillStyle = '#c9b38f';
    const [x, y] = px(q);
    ctx.fillText(text, x, y);
  };
  for (let i = 0; i <= 8; i++) {
    mark({ x: i * DIAMOND, y: -off }, { x: i * DIAMOND, y: -lab }, i > 0 && i < 8, String(i));
    mark({ x: i * DIAMOND, y: TABLE.W + off }, { x: i * DIAMOND, y: TABLE.W + lab }, i > 0 && i < 8, String(i));
  }
  for (let j = 0; j <= 4; j++) {
    mark({ x: -off, y: j * DIAMOND }, { x: -lab, y: j * DIAMOND }, j > 0 && j < 4, String(j));
    mark({ x: TABLE.L + off, y: j * DIAMOND }, { x: TABLE.L + lab, y: j * DIAMOND }, j > 0 && j < 4, String(j));
  }
  if (($('grid') as HTMLInputElement).checked) {
    ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 1;
    for (let i = 1; i < 8; i++) line(px({ x: i * DIAMOND, y: 0 }), px({ x: i * DIAMOND, y: TABLE.W }));
    for (let j = 1; j < 4; j++) line(px({ x: 0, y: j * DIAMOND }), px({ x: TABLE.L, y: j * DIAMOND }));
  }

  // 시스템 기하 경로
  if (sysRes?.geo) {
    ctx.setLineDash([3, 5]); ctx.strokeStyle = 'rgba(255,200,80,0.8)'; ctx.lineWidth = 1.5;
    polyline(sysRes.geo.pts);
    ctx.setLineDash([]);
  }

  const showOthers = ($('others') as HTMLInputElement).checked;
  if (anim) drawAnim(showOthers);
  else drawPrediction(showOthers);
}

function drawPrediction(showOthers: boolean) {
  // 적구 경로
  for (const id of BALL_IDS) {
    if (id === shot.cue || !showOthers) continue;
    ctx.strokeStyle = hexA(COLORS[id], 0.7); ctx.lineWidth = 1.6; ctx.setLineDash([6, 4]);
    polyline(result.paths[id]);
  }
  ctx.setLineDash([]);
  // 수구 경로
  ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = 2.2;
  polyline(result.paths[shot.cue]);
  // 이벤트 마커
  let n = 0, contact = 0;
  const secondT = result.events.find((e) => e.type === 'ball' && (e.ball === shot.cue || e.other === shot.cue) && ballOf(e) === result.outcome.secondHit)?.t ?? Infinity;
  for (const e of result.events) {
    if (e.type === 'cushion' && e.ball === shot.cue) {
      n++;
      if (n > 8) continue;
      const [x, y] = px(e);
      const before = e.t < secondT;
      ctx.fillStyle = before ? (n <= 3 ? '#ffb020' : '#9fe870') : 'rgba(180,180,180,0.7)';
      circle(x, y, 8); ctx.fill();
      ctx.fillStyle = '#111'; ctx.font = 'bold 10px sans-serif'; ctx.fillText(String(n), x, y + 0.5);
    }
    if (e.type === 'ball' && (e.ball === shot.cue || e.other === shot.cue)) {
      contact++;
      if (contact > 2) continue;
      // 접촉 순간 수구 위치 (고스트볼)
      const obj = ballOf(e)!;
      const cuePt = nearestPathPoint(result.paths[shot.cue], e);
      const [x, y] = px(cuePt);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.2; ctx.setLineDash([2, 2]);
      circle(x, y, R * S); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = COLORS[obj]; ctx.font = 'bold 11px sans-serif';
      ctx.fillText(contact === 1 ? '1적' : '2적', x, y - R * S - 9);
    }
  }
  // 정지 위치 (반투명)
  for (const id of BALL_IDS) {
    const p = result.paths[id];
    const end = p[p.length - 1];
    if (Math.hypot(end.x - layout[id].x, end.y - layout[id].y) > 0.01) ball(end, id, 0.35);
  }
  // 큐 + 겨냥선
  const c = layout[shot.cue];
  const a = (shot.angleDeg * Math.PI) / 180;
  const dx = Math.cos(a), dy = Math.sin(a);
  const back = 0.06 + shot.speed * 0.025;
  ctx.strokeStyle = '#d9b77c'; ctx.lineWidth = Math.max(4, S * 0.014); ctx.lineCap = 'round';
  line(px({ x: c.x - dx * back, y: c.y - dy * back }), px({ x: c.x - dx * (back + 0.6), y: c.y - dy * (back + 0.6) }));
  ctx.lineCap = 'butt';
  for (const id of BALL_IDS) ball(layout[id], id, 1, id === shot.cue);
  // 드래그 중인 공: 손가락에 가려지지 않도록 큰 링 표시
  if (drag?.kind === 'ball' && drag.moved) {
    const [x, y] = px(layout[drag.id]);
    ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]);
    circle(x, y, Math.max(R * S * 3, 26)); ctx.stroke(); ctx.setLineDash([]);
  }
}

function drawAnim(showOthers: boolean) {
  const t = ((performance.now() - anim!.start) / 1000) * anim!.rate;
  const fr = result.frames;
  let k = fr.findIndex((f) => f.t > t);
  if (k < 0) { k = fr.length - 1; anim = null; }
  BALL_IDS.forEach((id, i) => {
    if (id !== shot.cue && !showOthers) return;
    ctx.strokeStyle = id === shot.cue ? 'rgba(255,255,255,0.85)' : hexA(COLORS[id], 0.6);
    ctx.lineWidth = id === shot.cue ? 2 : 1.4;
    ctx.beginPath();
    for (let j = 0; j <= k; j++) {
      const [x, y] = px({ x: fr[j].p[i * 2], y: fr[j].p[i * 2 + 1] });
      j ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
  });
  BALL_IDS.forEach((id, i) => ball({ x: fr[k].p[i * 2], y: fr[k].p[i * 2 + 1] }, id, 1, id === shot.cue));
  if (anim) requestAnimationFrame(draw);
  else setTimeout(draw, 600);
}

function ballOf(e: { ball: BallId; other?: BallId }) { return e.ball === shot.cue ? e.other : e.ball; }
function nearestPathPoint(path: Pos[], p: Pos) {
  let best = path[0], bd = Infinity;
  for (const q of path) {
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}

function ball(p: Pos, id: BallId, alpha = 1, isCue = false) {
  const [x, y] = px(p);
  const r = R * S;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = 'rgba(0,0,0,0.3)'; circle(x + r * 0.2, y + r * 0.25, r); ctx.fill();
  const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
  g.addColorStop(0, '#fff'); g.addColorStop(0.35, COLORS[id]); g.addColorStop(1, shade(COLORS[id]));
  ctx.fillStyle = g; circle(x, y, r); ctx.fill();
  if (isCue) { ctx.strokeStyle = '#3fa7ff'; ctx.lineWidth = 2; circle(x, y, r + 4); ctx.stroke(); }
  ctx.globalAlpha = 1;
}
function diamond(x: number, y: number) {
  const s = Math.max(3, S * 0.012);
  ctx.beginPath(); ctx.moveTo(x, y - s); ctx.lineTo(x + s * 0.7, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s * 0.7, y); ctx.closePath(); ctx.fill();
}
function circle(x: number, y: number, r: number) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); }
function line(a: [number, number], b: [number, number]) { ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke(); }
function polyline(pts: Pos[]) {
  ctx.beginPath();
  pts.forEach((p, i) => { const [x, y] = px(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();
}
function roundRect(x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath(); ctx.roundRect(x, y, w, h, r);
}
function hexA(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
function shade(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.round(v * 0.55);
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

// ───────── 테이블 조작 (마우스 + 터치) ─────────
// 공 터치 후 드래그 = 이동(손가락 위치로 점프하지 않고 상대 이동), 적구 탭 = 그 공 정면 조준, 빈 곳 = 겨냥
type Drag =
  | { kind: 'ball'; id: BallId; sx: number; sy: number; from: Pos; p0: Pos; moved: boolean }
  | { kind: 'aim' };
let drag: Drag | null = null;
let locked = false;
const TAP_SLOP = 6; // px
function screenPos(ev: PointerEvent): [number, number] {
  const r = cv.getBoundingClientRect();
  return [ev.clientX - r.left, ev.clientY - r.top];
}
cv.addEventListener('pointerdown', (ev) => {
  if (anim) { anim = null; draw(); }
  const [sx, sy] = screenPos(ev);
  const p = toTable(sx, sy);
  const hitR = Math.max(R * S * 1.8, ev.pointerType === 'touch' ? 26 : 12);
  let hit: BallId | undefined, best = Infinity;
  for (const id of BALL_IDS) {
    const [bx, by] = px(layout[id]);
    const d = Math.hypot(bx - sx, by - sy);
    if (d < hitR && d < best) { best = d; hit = id; }
  }
  cv.setPointerCapture(ev.pointerId);
  if (hit) {
    drag = { kind: 'ball', id: hit, sx, sy, from: { ...layout[hit] }, p0: p, moved: false };
  } else {
    drag = { kind: 'aim' };
    interacting = true;
    aimAt(p);
  }
});
cv.addEventListener('pointermove', (ev) => {
  if (!drag) return;
  const [sx, sy] = screenPos(ev);
  const p = toTable(sx, sy);
  if (drag.kind === 'ball') {
    if (!drag.moved && Math.hypot(sx - drag.sx, sy - drag.sy) < TAP_SLOP) return;
    if (locked) { drag = { kind: 'aim' }; interacting = true; aimAt(p); return; }
    drag.moved = true;
    interacting = true;
    placeBall(drag.id, { x: drag.from.x + p.x - drag.p0.x, y: drag.from.y + p.y - drag.p0.y });
    sysRes = null;
    recompute();
  } else aimAt(p);
});
function endDrag() {
  if (!drag) return;
  if (drag.kind === 'ball' && !drag.moved && drag.id !== shot.cue) {
    // 적구 탭 → 그 공 중심으로 조준 (정면 맞춤)
    aimAt(layout[drag.id]);
    navigator.vibrate?.(8);
  }
  drag = null;
  interacting = false;
  recompute();
}
cv.addEventListener('pointerup', endDrag);
cv.addEventListener('pointercancel', endDrag);
function aimAt(p: Pos) {
  const c = layout[shot.cue];
  if (Math.hypot(p.x - c.x, p.y - c.y) < R * 2) return;
  shot.angleDeg = norm((Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI);
  sysRes = null;
  recompute();
}
function placeBall(id: BallId, p: Pos) {
  let x = Math.min(TABLE.L - R, Math.max(R, p.x));
  let y = Math.min(TABLE.W - R, Math.max(R, p.y));
  for (const o of BALL_IDS) {
    if (o === id) continue;
    const dx = x - layout[o].x, dy = y - layout[o].y, d = Math.hypot(dx, dy);
    if (d < 2 * R + 0.001) { const k = (2 * R + 0.001) / (d || 1); x = layout[o].x + dx * k; y = layout[o].y + dy * k; }
  }
  layout[id] = { x, y };
}
const lockBtn = $('lock');
lockBtn.addEventListener('click', () => {
  locked = !locked;
  lockBtn.setAttribute('aria-pressed', String(locked));
  lockBtn.textContent = locked ? '🔒 배치' : '🔓 배치';
});

// 방향 미세 조정 조그: 좌우 드래그 1px = 0.02°
const jog = $('jog');
let jogX: number | null = null, jogOffset = 0;
jog.addEventListener('pointerdown', (ev) => {
  jogX = ev.clientX; jog.setPointerCapture(ev.pointerId); jog.classList.add('active');
  interacting = true; updateJogText();
});
jog.addEventListener('pointermove', (ev) => {
  if (jogX === null) return;
  const dx = ev.clientX - jogX;
  jogX = ev.clientX;
  jogOffset += dx;
  jog.style.backgroundPositionX = `${jogOffset}px`;
  shot.angleDeg = norm(shot.angleDeg - dx * 0.02);
  sysRes = null;
  updateJogText();
  recompute();
});
const jogEnd = () => {
  if (jogX === null) return;
  jogX = null; jog.classList.remove('active'); interacting = false;
  $('jogTxt').textContent = '◀ 미세 조정 ▶';
  recompute();
};
jog.addEventListener('pointerup', jogEnd);
jog.addEventListener('pointercancel', jogEnd);
function updateJogText() { $('jogTxt').textContent = `${shot.angleDeg.toFixed(2)}°`; }

const norm = (a: number) => ((a % 360) + 360) % 360;
window.addEventListener('keydown', (ev) => {
  if ((ev.target as HTMLElement).tagName === 'INPUT' || (ev.target as HTMLElement).tagName === 'SELECT') return;
  if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
    const d = (ev.shiftKey ? 1 : 0.1) * (ev.key === 'ArrowLeft' ? 1 : -1);
    shot.angleDeg = norm(shot.angleDeg + d);
    ev.preventDefault();
    recompute();
  }
});

// ───────── 패널: 상황 입력 ─────────
const cueSel = $('cueSel');
cueSel.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
  shot.cue = b.dataset.v as BallId;
  recompute();
}));
const presetSel = $<HTMLSelectElement>('preset');
PRESETS.forEach((p, i) => presetSel.add(new Option(p.name, String(i))));
presetSel.add(new Option('랜덤 배치', 'rand'));
presetSel.addEventListener('change', () => {
  if (presetSel.value === 'rand') {
    for (const id of BALL_IDS) placeBall(id, { x: R + Math.random() * (TABLE.L - 2 * R), y: R + Math.random() * (TABLE.W - 2 * R) });
  } else layout = clone(PRESETS[+presetSel.value].layout);
  sysRes = null; candidates = []; renderCands();
  recompute();
});
const coordBody = $('coords');
for (const id of BALL_IDS) {
  const tr = document.createElement('tr');
  tr.innerHTML = `<td><span class="dot" style="background:${COLORS[id]}"></span>${KO[id]}</td>
    <td><input type="number" step="0.05" min="0" max="8" data-id="${id}" data-ax="x"></td>
    <td><input type="number" step="0.05" min="0" max="4" data-id="${id}" data-ax="y"></td>`;
  coordBody.appendChild(tr);
}
coordBody.querySelectorAll('input').forEach((inp) => inp.addEventListener('change', () => {
  const id = inp.dataset.id as BallId, ax = inp.dataset.ax as 'x' | 'y';
  const p = { ...layout[id], [ax]: parseFloat(inp.value) * DIAMOND };
  placeBall(id, p);
  recompute();
}));

// ───────── 패널: 샷 설정 ─────────
const angleIn = $<HTMLInputElement>('angle');
angleIn.addEventListener('change', () => { shot.angleDeg = norm(parseFloat(angleIn.value) || 0); recompute(); });
document.querySelectorAll<HTMLButtonElement>('[data-da]').forEach((b) => b.addEventListener('click', () => {
  shot.angleDeg = norm(shot.angleDeg + parseFloat(b.dataset.da!)); recompute();
}));
const speedIn = $<HTMLInputElement>('speed');
speedIn.addEventListener('input', () => { shot.speed = parseFloat(speedIn.value); interacting = true; recompute(); });
speedIn.addEventListener('change', () => { interacting = false; recompute(); });

const tipCv = $<HTMLCanvasElement>('tip');
const tctx = tipCv.getContext('2d')!;
const TIP_MAX = 0.6;
function drawTip() {
  const k = tipCv.width / 132; // 고해상도 캔버스 (CSS 132px)
  tctx.setTransform(k, 0, 0, k, 0, 0);
  const s = 132, c = s / 2, r = s / 2 - 6;
  tctx.clearRect(0, 0, s, s);
  const g = tctx.createRadialGradient(c - r * 0.3, c - r * 0.3, 4, c, c, r);
  g.addColorStop(0, '#fff'); g.addColorStop(1, COLORS[shot.cue] === '#f7f7f2' ? '#bdbdb5' : '#b38a10');
  tctx.fillStyle = g; tctx.beginPath(); tctx.arc(c, c, r, 0, Math.PI * 2); tctx.fill();
  tctx.strokeStyle = 'rgba(0,0,0,0.25)';
  for (let k = 1; k <= 3; k++) { tctx.beginPath(); tctx.arc(c, c, r * 0.2 * k, 0, Math.PI * 2); tctx.stroke(); }
  tctx.beginPath(); tctx.moveTo(c - r, c); tctx.lineTo(c + r, c); tctx.moveTo(c, c - r); tctx.lineTo(c, c + r); tctx.stroke();
  const x = c + shot.tipX * r, y = c - shot.tipY * r;
  tctx.fillStyle = '#1f6fd1'; tctx.beginPath(); tctx.arc(x, y, 7, 0, Math.PI * 2); tctx.fill();
  tctx.strokeStyle = '#fff'; tctx.lineWidth = 2; tctx.stroke(); tctx.lineWidth = 1;
}
let tipDrag = false;
function setTip(ev: PointerEvent) {
  const rc = tipCv.getBoundingClientRect();
  const r = rc.width / 2 - 6;
  let tx = (ev.clientX - rc.left - rc.width / 2) / r, ty = -(ev.clientY - rc.top - rc.height / 2) / r;
  const d = Math.hypot(tx, ty);
  if (d > TIP_MAX) { tx *= TIP_MAX / d; ty *= TIP_MAX / d; }
  shot.tipX = Math.round(tx * 100) / 100; shot.tipY = Math.round(ty * 100) / 100;
  recompute();
}
tipCv.addEventListener('pointerdown', (ev) => { tipDrag = true; interacting = true; tipCv.setPointerCapture(ev.pointerId); setTip(ev); });
tipCv.addEventListener('pointermove', (ev) => tipDrag && setTip(ev));
const tipEnd = () => { if (!tipDrag) return; tipDrag = false; interacting = false; recompute(); };
tipCv.addEventListener('pointerup', tipEnd);
tipCv.addEventListener('pointercancel', tipEnd);
$('tipReset').addEventListener('click', () => { shot.tipX = 0; shot.tipY = 0; recompute(); });

function tipText() {
  const d = Math.hypot(shot.tipX, shot.tipY);
  if (d < 0.03) return '중앙 (무회전)';
  const deg = (Math.atan2(shot.tipY, shot.tipX) * 180) / Math.PI;
  const hour = ((Math.round((90 - deg) / 30) % 12) + 12) % 12 || 12;
  const side = Math.abs(shot.tipX) < 0.03 ? '' : `${shot.tipX > 0 ? '우' : '좌'} ${(Math.abs(shot.tipX) / 0.2).toFixed(1)}팁`;
  const vert = Math.abs(shot.tipY) < 0.03 ? '' : `${shot.tipY > 0 ? '상단' : '하단'} ${(Math.abs(shot.tipY) / 0.2).toFixed(1)}팁`;
  return `${hour}시 방향 ${(d / 0.2).toFixed(1)}팁<br><span class="note">${[side, vert].filter(Boolean).join(' · ')}</span>`;
}
function powerText(v: number) {
  const lv = v < 1.6 ? '약' : v < 2.8 ? '중' : v < 4.2 ? '중강' : '강';
  return `${v.toFixed(2)} m/s (${lv})`;
}

function syncInputs() {
  cueSel.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === shot.cue));
  coordBody.querySelectorAll('input').forEach((inp) => {
    if (document.activeElement === inp) return;
    inp.value = (layout[inp.dataset.id as BallId][inp.dataset.ax as 'x' | 'y'] / DIAMOND).toFixed(2);
  });
  if (document.activeElement !== angleIn) angleIn.value = shot.angleDeg.toFixed(1);
  speedIn.value = String(shot.speed);
  $('speedTxt').textContent = powerText(shot.speed);
  $('tipTxt').innerHTML = tipText();
  drawTip();
}

// ───────── 결과 표시 ─────────
function renderDetail() {
  const o = result.outcome;
  const v = $('verdict');
  v.className = `verdict ${o.scored ? 'ok' : 'fail'}`;
  v.innerHTML = `<b>${o.scored ? '득점 예상' : '실패 예상'}</b>${o.reason}${prob === null ? '' : `<span class="p">성공 확률 ${Math.round(prob * 100)}%</span>`}`;
  const cueEvents = result.events.filter((e) => e.ball === shot.cue || e.other === shot.cue);
  const seq = o.cueCushions.map((w) => WALL_KO[w].replace(' ', '')).join(' → ') || '없음';
  const probHtml = prob === null
    ? '<span class="note">계산 중…</span>'
    : `${Math.round(prob * 100)}%<div class="bar"><div style="width:${prob * 100}%;background:${prob > 0.6 ? 'var(--ok)' : prob > 0.3 ? 'var(--warn)' : 'var(--fail)'}"></div></div>`;
  $('detail').innerHTML = `
    <div class="kv">
      <span>1적구</span><span>${o.firstHit ? KO[o.firstHit] : '—'}</span>
      <span>2적구</span><span>${o.secondHit ? KO[o.secondHit] : '—'}</span>
      <span>2적구 전 쿠션</span><span>${o.cushionsBeforeSecond}회</span>
      <span>쿠션 순서</span><span>${seq}</span>
      <span>키스</span><span>${o.kiss ? '<span style="color:var(--warn)">적구끼리 충돌 발생</span>' : '없음'}</span>
      <span>총 시간</span><span>${result.duration.toFixed(1)}초</span>
      <span>성공 확률</span><span>${probHtml}</span>
    </div>
    <p class="note">성공 확률 = 방향 ±0.35°, 힘 ±5%, 당점 ±0.05R 의 스트로크 오차를 가정한 40회 시뮬레이션</p>
    <ol class="events">${cueEvents.slice(0, 14).map((e) => `<li class="cue">${e.t.toFixed(2)}s · ${
      e.type === 'cushion' ? `${WALL_KO[e.wall!]} (${posTxt(e)})` : `${KO[ballOf(e)!]} 접촉`
    } · ${e.speed.toFixed(2)}m/s</li>`).join('')}</ol>`;
}
const posTxt = (p: Pos) => `${(p.x / DIAMOND).toFixed(1)}, ${(p.y / DIAMOND).toFixed(1)}`;

function renderCands() {
  const ol = $('cands');
  if (!candidates.length) { ol.innerHTML = searchId ? '<li class="note">득점 경로를 찾지 못했습니다. 힘/당점을 바꾸거나 "당점·힘도 탐색"을 켜 보세요.</li>' : ''; return; }
  ol.innerHTML = candidates.map((c) => `<li>
      <b>${c.angleDeg.toFixed(1)}°</b> · 힘 ${c.speed.toFixed(2)} · 좌우 ${c.tipX > 0 ? '우' : c.tipX < 0 ? '좌' : ''}${(Math.abs(c.tipX) / 0.2).toFixed(1)}팁
      <br><span class="note">성공 확률 ${Math.round(c.prob * 100)}% · 허용 각도폭 ${c.width.toFixed(1)}°</span></li>`).join('');
  ol.querySelectorAll('li').forEach((li, i) => li.addEventListener('click', () => {
    const c = candidates[i];
    Object.assign(shot, { angleDeg: c.angleDeg, speed: c.speed, tipX: c.tipX, tipY: c.tipY });
    recompute();
  }));
}
$('search').addEventListener('click', () => {
  searchId = ++reqId;
  candidates = [];
  $('cands').innerHTML = '';
  $('progress').classList.remove('hidden');
  send({ kind: 'search', id: searchId, layout, shot, wide: ($('wide') as HTMLInputElement).checked });
});

// ───────── 재생 ─────────
$('play').addEventListener('click', () => {
  anim = { start: performance.now(), rate: ($('slow') as HTMLInputElement).checked ? 0.5 : 1 };
  draw();
});
['grid', 'others'].forEach((id) => $(id).addEventListener('change', draw));

// ───────── 다이아몬드 시스템 ─────────
const WALLS: Wall[] = ['top', 'right', 'bottom', 'left'];
const sel = (['c1', 'c2', 'c3'] as const).map((id) => $<HTMLSelectElement>(id));
sel.forEach((s, i) => {
  WALLS.forEach((w) => s.add(new Option(WALL_KO[w], w)));
  s.value = ['top', 'right', 'bottom'][i];
});
const sysSeq = () => sel.map((s) => s.value) as [Wall, Wall, Wall];
const arrIn = $<HTMLInputElement>('arr');
function sysGeo() {
  sysRes = solveSystem(layout[shot.cue], sysSeq(), parseFloat(arrIn.value));
  let html = sysRes.ok ? '' : `<b style="color:var(--fail)">${sysRes.message}</b><br>`;
  if (sysRes.ok) {
    shot.angleDeg = norm(sysRes.angleDeg!);
    html += `기하 겨냥: <b>${shot.angleDeg.toFixed(1)}°</b> · 1쿠션 지점 <b>${sysRes.aimDiamond!.toFixed(2)}</b> 다이아몬드`;
    if (sysRes.fiveHalf) {
      const f = sysRes.fiveHalf;
      html += `<br>파이브앤하프 환산: 출발 <b>${f.cue.toFixed(0)}</b> − 1쿠션 <b>${f.aim.toFixed(0)}</b> = 3쿠션 <b>${f.arrival.toFixed(0)}</b>
        <br><span class="note">회전·마찰 없는 반사각 기준입니다. 실제 힘·당점을 반영하려면 "물리 보정"을 사용하세요.</span>`;
    }
  }
  $('sysOut').innerHTML = html;
  return sysRes.ok;
}
$('sysGeo').addEventListener('click', () => { sysGeo(); recompute(); });
$('sysCal').addEventListener('click', () => {
  if (!sysGeo()) { recompute(); return; }
  $('sysOut').innerHTML += '<br>물리 보정 중…';
  setTimeout(() => {
    const c = calibrate(layout, shot, sysSeq(), parseFloat(arrIn.value), shot.angleDeg);
    if (c.ok) {
      const geoA = shot.angleDeg;
      shot.angleDeg = norm(c.angleDeg);
      const tgt = railPoint(sysSeq()[2], parseFloat(arrIn.value));
      $('sysOut').innerHTML = $('sysOut').innerHTML.replace('<br>물리 보정 중…', '') +
        `<br>물리 보정 각도: <b>${shot.angleDeg.toFixed(2)}°</b> (기하 대비 ${(c.angleDeg - geoA >= 0 ? '+' : '')}${(c.angleDeg - geoA).toFixed(2)}°)
         <br><span class="note">현재 힘·당점으로 3쿠션 ${posTxt(tgt)} 도착 (오차 ${Math.abs(c.errorDiamond).toFixed(2)} 다이아몬드, 적구 무시)</span>`;
    } else {
      $('sysOut').innerHTML = $('sysOut').innerHTML.replace('<br>물리 보정 중…', '') + '<br><b style="color:var(--fail)">현재 힘·당점으로는 이 쿠션 순서를 만들 수 없습니다</b>';
    }
    recompute();
  }, 20);
});

// ───────── 시작 ─────────
// ───────── 모바일 탭 ─────────
const tabBtns = [...document.querySelectorAll<HTMLButtonElement>('#tabs button')];
const sections = [...document.querySelectorAll<HTMLDetailsElement>('#panel details')];
tabBtns.forEach((b) => b.addEventListener('click', () => {
  const i = +b.dataset.tab!;
  tabBtns.forEach((x) => x.classList.toggle('on', x === b));
  sections.forEach((d, j) => { d.classList.toggle('active', j === i); if (j === i) d.open = true; });
  $('panel').scrollTop = 0;
}));

new ResizeObserver(resize).observe(stage);
mobileMq.addEventListener('change', resize);
landscapeMq.addEventListener('change', resize);
addEventListener('resize', resize);
recompute();
