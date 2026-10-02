import './style.css';
import {
  BALL, BALL_IDS, DIAMOND, KO, PHYS, TABLE, WALL_KO, simulate,
  type BallId, type Layout, type Pos, type Shot, type SimResult, type Wall,
} from './physics';
import { calibrate, railPoint, solveSystem, type SystemResult } from './systems';
import { findRanges, type ScanRange } from './ranges';
import type { ShotSummary, WorkerRequest, WorkerResponse } from './worker';

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
interface Candidate extends ScanRange { tipX: number; tipY: number; speed: number; prob: number; summary?: ShotSummary }
let candidates: Candidate[] = [];
let selected = -1; // 현재 적용된 추천 후보
let anim: { start: number; rate: number } | null = null;

function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)); }

// ───────── 워커 ─────────
const newWorker = () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
// 현재 샷 성공 확률 전용 워커 (상시)
const probe = newWorker();
let reqId = 0, probId = 0;
probe.onmessage = (ev: MessageEvent<WorkerResponse>) => {
  const m = ev.data;
  if (m.kind === 'eval' && m.id === probId) { prob = m.prob; renderDetail(); renderDispute(); }
};
let probTimer = 0;
function requestProb() {
  prob = null;
  clearTimeout(probTimer);
  probTimer = window.setTimeout(() => {
    probId = ++reqId;
    probe.postMessage({ kind: 'eval', id: probId, layout, shot, n: 40 } satisfies WorkerRequest);
  }, 200);
}

// 작업 여러 개를 코어 수만큼 워커에 나눠 실행. cancel() 시 워커를 종료하고 결과는 버린다
function runPool<T extends WorkerResponse>(reqs: WorkerRequest[], onProgress: (p: number) => void) {
  const n = Math.max(1, Math.min(reqs.length, (navigator.hardwareConcurrency || 4) - 1, 8));
  const workers = Array.from({ length: n }, newWorker);
  const results: T[] = new Array(reqs.length);
  const prog = new Array(reqs.length).fill(0);
  let next = 0, done = 0, cancelled = false;
  const promise = new Promise<T[]>((resolve) => {
    if (!reqs.length) { resolve([]); return; }
    const assign = (w: Worker) => {
      if (next >= reqs.length) return;
      const i = next++;
      w.onmessage = (ev: MessageEvent<WorkerResponse>) => {
        if (cancelled) return;
        const m = ev.data;
        if (m.kind === 'progress') prog[i] = m.value;
        else {
          results[i] = m as T; prog[i] = 1; done++;
          if (done === reqs.length) { workers.forEach((x) => x.terminate()); resolve(results); }
          else assign(w);
        }
        onProgress(prog.reduce((a, b) => a + b, 0) / reqs.length);
      };
      w.postMessage({ ...reqs[i], id: i });
    };
    workers.forEach(assign);
  });
  return { promise, cancel: () => { cancelled = true; workers.forEach((w) => w.terminate()); } };
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
    renderCands();
    renderDispute();
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
const portraitMq = matchMedia('(orientation: portrait)');
let S = 300, OX = 0, OY = 0;
let vertical = false; // 세로 화면에서는 테이블을 90° 돌려서 더 크게 표시
let lastBox = '';
const layoutEl = document.querySelector<HTMLElement>('.layout')!;
const RAIL_W = 66; // 와이드 모드 오른쪽 도구 막대 폭(간격 포함)
function resize() {
  const fullL = TABLE.L + 2 * RAIL, fullW = TABLE.W + 2 * RAIL;
  const wide = document.body.classList.contains('wide');
  let w: number, h: number;
  if (wide) {
    // 와이드(가로 눕힘) 모드: 테이블이 화면을 가득 채우고 오른쪽엔 얇은 도구 막대만
    const cs = getComputedStyle(layoutEl);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const boxW = layoutEl.clientWidth - padX - RAIL_W, boxH = layoutEl.clientHeight - padY;
    vertical = false;
    S = Math.max(40, Math.min(boxW / fullL, boxH / fullW));
    w = fullL * S; h = fullW * S;
    stage.style.width = `${w}px`;
  } else {
    // 세로 모바일: 화면 높이의 56%까지 / 데스크톱: 72%까지. 더 크게 나오는 방향으로 테이블을 세운다
    stage.style.width = '';
    const boxW = stage.clientWidth;
    const boxH = Math.max(200, innerHeight * (mobileMq.matches ? 0.56 : 0.72));
    const sH = Math.min(boxW / fullL, boxH / fullW);
    const sV = Math.min(boxW / fullW, boxH / fullL);
    vertical = sV > sH * 1.1;
    S = vertical ? sV : sH;
    w = (vertical ? fullW : fullL) * S; h = (vertical ? fullL : fullW) * S;
  }
  const key = `${w}x${h}`;
  stage.style.height = `${h}px`;
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
// 포인터 위치 → 요소 자신의 좌표. 회전(와이드) 모드에서는 화면이 시계 방향 90° 돌아가 있으므로 역변환
function localXY(el: Element, ev: PointerEvent): [number, number] {
  const r = el.getBoundingClientRect();
  return document.body.classList.contains('rotated')
    ? [ev.clientY - r.top, r.right - ev.clientX]
    : [ev.clientX - r.left, ev.clientY - r.top];
}
const screenPos = (ev: PointerEvent) => localXY(cv, ev);
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
    if (locked || dispute) { drag = { kind: 'aim' }; interacting = true; aimAt(p); return; }
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
  const movedBall = drag.kind === 'ball' && drag.moved;
  drag = null;
  if (movedBall) layoutChanged();
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

// 방향 미세 조정 조그: 드래그 1px = 0.02°. 아래쪽 바는 좌우, 와이드 모드 도구 막대는 위아래로 드래그
function bindJog(el: HTMLElement, label: HTMLElement, axis: 0 | 1, idle: string) {
  let last: number | null = null, offset = 0;
  el.addEventListener('pointerdown', (ev) => {
    last = localXY(el, ev)[axis]; el.setPointerCapture(ev.pointerId); el.classList.add('active');
    interacting = true; label.textContent = `${shot.angleDeg.toFixed(2)}°`;
  });
  el.addEventListener('pointermove', (ev) => {
    if (last === null) return;
    const v = localXY(el, ev)[axis];
    const d = v - last;
    last = v;
    offset += d;
    el.style.setProperty(axis ? 'background-position-y' : 'background-position-x', `${offset}px`);
    shot.angleDeg = norm(shot.angleDeg + (axis ? d : -d) * 0.02);
    sysRes = null;
    label.textContent = `${shot.angleDeg.toFixed(2)}°`;
    recompute();
  });
  const end = () => {
    if (last === null) return;
    last = null; el.classList.remove('active'); interacting = false;
    label.innerHTML = idle;
    recompute();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}
bindJog($('jog'), $('jogTxt'), 0, '◀ 미세 조정 ▶');
bindJog($('railJog'), $('railJogTxt'), 1, '미세<br>조정');


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
  if (dispute) return;
  shot.cue = b.dataset.v as BallId;
  recompute();
  layoutChanged();
}));
const presetSel = $<HTMLSelectElement>('preset');
PRESETS.forEach((p, i) => presetSel.add(new Option(p.name, String(i))));
presetSel.add(new Option('랜덤 배치', 'rand'));
presetSel.addEventListener('change', () => {
  if (dispute) return;
  if (presetSel.value === 'rand') {
    for (const id of BALL_IDS) placeBall(id, { x: R + Math.random() * (TABLE.L - 2 * R), y: R + Math.random() * (TABLE.W - 2 * R) });
  } else layout = clone(PRESETS[+presetSel.value].layout);
  sysRes = null;
  recompute();
  layoutChanged();
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
  if (dispute) { syncInputs(); return; }
  const id = inp.dataset.id as BallId, ax = inp.dataset.ax as 'x' | 'y';
  const p = { ...layout[id], [ax]: parseFloat(inp.value) * DIAMOND };
  placeBall(id, p);
  recompute();
  layoutChanged();
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
  const half = tipCv.clientWidth / 2, r = half * (60 / 66); // 그림 반지름 = 132px 기준 60px
  const [lx, ly] = localXY(tipCv, ev);
  let tx = (lx - half) / r, ty = -(ly - half) / r;
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
  const ci = currentCand();
  v.innerHTML = `${ci >= 0 ? `<span class="rec-tag">추천 ${ci + 1}</span>` : ''}<b>${o.scored ? '득점 예상' : '실패 예상'}</b>${o.reason}${prob === null ? '' : `<span class="p">성공 확률 ${Math.round(prob * 100)}%</span>`}`;
  renderHud();
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

// ───────── 추천 샷 (메인 기능) ─────────
// 1) 여러 힘·당점 조합으로 360° 전 방향을 병렬 시뮬레이션 → 득점 각도 구간 수집
// 2) 구간이 넓은 상위 후보를 스트로크 오차 30회로 재평가 → 성공 확률 순 정렬
const MODES = {
  fast: [
    ...[-0.3, 0, 0.3].map((tipX) => ({ tipX, tipY: 0.2, speed: 3.0 })),
    ...[-0.3, 0.3].map((tipX) => ({ tipX, tipY: 0.2, speed: 4.2 })),
  ],
  fine: [
    ...[-0.4, -0.2, 0, 0.2, 0.4].flatMap((tipX) => [2.2, 3.0, 4.2].map((speed) => ({ tipX, tipY: 0.2, speed }))),
    ...[-0.3, 0.3].map((tipX) => ({ tipX, tipY: -0.3, speed: 3.4 })),
  ],
};
let recMode: keyof typeof MODES = 'fast';
let searchGen = 0;
let activeSearch: { cancel(): void } | null = null;

function setProgress(p: number | null, text = '') {
  $('progress').classList.toggle('hidden', p === null);
  if (p !== null) ($('progress').firstElementChild as HTMLElement).style.width = `${p * 100}%`;
  $('recStatus').innerHTML = text;
}

async function recommend() {
  activeSearch?.cancel();
  const gen = ++searchGen;
  const lay = clone(layout);
  const base = { ...shot };
  candidates = []; renderCands();
  const variants = MODES[recMode];
  const t0 = performance.now();
  setProgress(0, `득점 경로 탐색 중… (${variants.length}가지 힘·당점 × 900방향)`);
  // 힘·당점 조합마다 360°를 4조각으로 나눠 코어에 고르게 분배
  const STEP = 0.4, N = Math.round(360 / STEP), CHUNKS = 4;
  const jobs = variants.flatMap((v, vi) => Array.from({ length: CHUNKS }, (_, c) => ({
    vi, req: { kind: 'scan', id: 0, layout: lay, shot: { ...base, ...v }, step: STEP,
      from: Math.floor((c * N) / CHUNKS), to: Math.floor(((c + 1) * N) / CHUNKS) } as WorkerRequest,
  })));
  const scan = runPool<Extract<WorkerResponse, { kind: 'scan' }>>(
    jobs.map((j) => j.req),
    (p) => { if (gen === searchGen) setProgress(p * 0.8, `득점 경로 탐색 중… ${Math.round(p * 100)}%`); },
  );
  activeSearch = scan;
  const scans = await scan.promise;
  if (gen !== searchGen) return;
  const okAll = variants.map(() => new Uint8Array(N));
  scans.forEach((r, k) => okAll[jobs[k].vi].set(r.ok, (jobs[k].req as { from: number }).from));
  let cands: Candidate[] = okAll.flatMap((ok, vi) => findRanges(ok, STEP).map((g) => ({ ...g, ...variants[vi], prob: 0 })));
  cands.sort((a, b) => b.width - a.width);
  cands = cands.slice(0, 14);
  const ev = runPool<Extract<WorkerResponse, { kind: 'eval' }>>(
    cands.map((c) => ({ kind: 'eval', id: 0, layout: lay, shot: { ...base, ...c }, n: 30 })),
    (p) => { if (gen === searchGen) setProgress(0.8 + p * 0.2, '성공 확률 계산 중…'); },
  );
  activeSearch = ev;
  const evals = await ev.promise;
  if (gen !== searchGen) return;
  cands.forEach((c, i) => { c.prob = evals[i].prob; c.summary = evals[i].summary; });
  cands.sort((a, b) => b.prob - a.prob || b.width - a.width);
  // 거의 같은 샷(각도 1° 이내, 같은 당점·힘) 중복 제거
  const kept: Candidate[] = [];
  for (const c of cands) {
    if (kept.some((k) => Math.abs(k.angleDeg - c.angleDeg) < 1 && k.tipX === c.tipX && k.speed === c.speed)) continue;
    kept.push(c);
    if (kept.length === 6) break;
  }
  candidates = kept;
  activeSearch = null;
  const sec = ((performance.now() - t0) / 1000).toFixed(1);
  setProgress(null, candidates.length
    ? `득점 가능한 샷 ${candidates.length}개 · ${sec}초 · 카드를 탭하면 경로 표시, 한 번 더 탭하면 재생`
    : `득점 경로를 찾지 못했습니다${recMode === 'fast' ? ' — <b>정밀</b> 모드로 다시 시도해 보세요' : ''}`);
  $('disputeBtn').classList.remove('hidden');
  if (candidates.length) applyCandidate(0);
  else renderCands();
}

let recTimer = 0;
function layoutChanged() {
  activeSearch?.cancel(); searchGen++;
  $('disputeBtn').classList.add('hidden');
  candidates = []; lastApplied = -1; renderCands();
  clearTimeout(recTimer);
  if (!($('autoRec') as HTMLInputElement).checked) { setProgress(null, '배치가 바뀌었습니다. <b>추천 받기</b>를 눌러 주세요.'); return; }
  setProgress(null, '배치 변경 — 곧 추천을 시작합니다');
  recTimer = window.setTimeout(recommend, 450);
}

let lastApplied = -1; // 마지막으로 적용한 추천 (이의제기 대상 기본값)
function applyCandidate(i: number) {
  const c = candidates[i];
  lastApplied = i;
  Object.assign(shot, { angleDeg: c.angleDeg, speed: c.speed, tipX: c.tipX, tipY: c.tipY });
  sysRes = null;
  recompute();
}
const currentCand = () => candidates.findIndex((c) =>
  c.angleDeg === shot.angleDeg && c.speed === shot.speed && c.tipX === shot.tipX && c.tipY === shot.tipY);

const WALL_SHORT: Record<Wall, string> = { top: '상', bottom: '하', left: '좌', right: '우' };
function thicknessText(t: number) {
  const k = Math.max(1, Math.round(t * 8));
  return k >= 8 ? '정면' : ['', '1/8', '1/4', '3/8', '1/2', '5/8', '3/4', '7/8'][k] + ' 두께';
}
function tipIcon(tx: number, ty: number) {
  const x = 12 + tx * 10, y = 12 - ty * 10;
  return `<svg class="tipico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10.5"/><circle class="d" cx="${x}" cy="${y}" r="2.6"/></svg>`;
}
function tipLabel(tx: number, ty: number) {
  const side = Math.abs(tx) < 0.03 ? '중앙' : `${tx > 0 ? '우' : '좌'} ${(Math.abs(tx) / 0.2).toFixed(1)}팁`;
  const vert = Math.abs(ty) < 0.03 ? '' : ` · ${ty > 0 ? '상' : '하'} ${(Math.abs(ty) / 0.2).toFixed(1)}팁`;
  return side + vert;
}
function renderCands() {
  const ol = $('cands');
  const cur = currentCand();
  ol.innerHTML = candidates.map((c, i) => {
    const s = c.summary;
    const pct = Math.round(c.prob * 100);
    const color = c.prob > 0.6 ? 'var(--ok)' : c.prob > 0.3 ? 'var(--warn)' : 'var(--fail)';
    const dot = (id: BallId) => `<span class="ball-dot" style="background:${COLORS[id]}"></span>${KO[id]}`;
    const route = s?.firstHit
      ? `${dot(s.firstHit)}${s.thickness !== undefined ? ` <i>${thicknessText(s.thickness)}</i>` : ' <i>(쿠션 먼저)</i>'}
         → ${s.cushions.map((w) => WALL_SHORT[w]).join('·') || '—'} → ${s.secondHit ? dot(s.secondHit) : '—'}`
      : '';
    return `<li class="card${i === cur ? ' on' : ''}" data-i="${i}">
      <div class="card-top"><span class="rank">${i + 1}</span>
        <div class="prob"><b style="color:${color}">${pct}%</b><div class="bar"><div style="width:${pct}%;background:${color}"></div></div></div>
        ${i === cur ? '<span class="tag">적용됨 · 탭=재생</span>' : ''}</div>
      <div class="route">${route}${s?.kiss ? ' <span class="kiss">키스 주의</span>' : ''}</div>
      <div class="params">${tipIcon(c.tipX, c.tipY)} ${tipLabel(c.tipX, c.tipY)} · 힘 ${c.speed.toFixed(1)} · ${c.angleDeg.toFixed(1)}° <span class="note">(허용폭 ${c.width.toFixed(1)}°)</span></div>
    </li>`;
  }).join('');
  ol.querySelectorAll<HTMLElement>('.card').forEach((li) => li.addEventListener('click', () => {
    const i = +li.dataset.i!;
    if (i === currentCand()) { closeDrawer(); startAnim(); return; } // 이미 적용된 카드를 다시 탭하면 재생
    applyCandidate(i);
    closeDrawer(); // 와이드 모드: 테이블 전체로 경로 확인
  }));
  renderHud();
}
$('recBtn').addEventListener('click', () => { clearTimeout(recTimer); recommend(); });
$('recMode').querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => {
  recMode = b.dataset.v as keyof typeof MODES;
  $('recMode').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  clearTimeout(recTimer); recommend();
}));

// ───────── 재생 ─────────
function startAnim() {
  anim = { start: performance.now(), rate: ($('slow') as HTMLInputElement).checked ? 0.5 : 1 };
  draw();
}
$('play').addEventListener('click', startAnim);
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

// ───────── 이의제기 (데이터 수집) ─────────
// 추천이 아쉬울 때: 배치는 고정한 채 방향·힘·당점만 바꿔 "내 샷"을 제안 → /api/feedback 으로 전송
// 서버 저장소가 아직 없거나 오프라인이면 이 기기(localStorage)에 보관했다가 다음에 자동 재전송
interface Dispute { rank: number; recs: Candidate[]; reason: string | null; actual: string }
let dispute: Dispute | null = null;
const QUEUE_KEY = 'miriq.feedbackQueue';
const store = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 저장 불가 환경 */ } },
};
function clientId() {
  let id = store.get<string>('miriq.clientId', '');
  if (!id) { id = crypto.randomUUID?.() ?? String(Math.random()).slice(2); store.set('miriq.clientId', id); }
  return id;
}

function setDisputeLocks(on: boolean) {
  document.body.classList.toggle('disputing', on);
  [sections[1], tabBtns[1], $('recBtn'), $('recMode'), $('lock'), $('disputeBtn')].forEach((el) => el.classList.toggle('lock-hide', on));
}
function startDispute() {
  const cur = currentCand();
  const rank = cur >= 0 ? cur : lastApplied < candidates.length ? lastApplied : -1;
  dispute = { rank, recs: clone(candidates), reason: null, actual: 'untested' };
  ($('dComment') as HTMLTextAreaElement).value = '';
  $('dMsg').textContent = '';
  $('dReason').querySelectorAll('button').forEach((b) => b.classList.remove('on'));
  $('dActual').querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('on', b.dataset.v === 'untested'));
  $('disputeBox').classList.remove('hidden');
  setDisputeLocks(true);
  selectTab(2);
  renderDispute();
}
function endDispute(restore: boolean) {
  if (!dispute) return;
  const d = dispute;
  dispute = null;
  $('disputeBox').classList.add('hidden');
  setDisputeLocks(false);
  if (restore && d.rank >= 0 && candidates[d.rank]) applyCandidate(d.rank);
  if (document.body.classList.contains('wide')) closeDrawer(); else selectTab(0);
}
function renderDispute() {
  if (!dispute || !result) return;
  const rec = dispute.rank >= 0 ? dispute.recs[dispute.rank] : null;
  const s = rec?.summary;
  const o = result.outcome;
  const pct = (v: number | null) => (v === null ? '…' : `${Math.round(v * 100)}%`);
  const routeOf = (first?: BallId, cush: Wall[] = [], second?: BallId) =>
    first ? `${KO[first]} → ${cush.map((w) => WALL_SHORT[w]).join('·') || '—'} → ${second ? KO[second] : '—'}` : '적구 못 맞힘';
  $('dCompare').innerHTML = `
    <div><h5>추천 ${rec ? `#${dispute.rank + 1}` : '(없음)'}</h5>
      ${rec ? `<div class="big">${pct(rec.prob)}</div><div>${routeOf(s?.firstHit, s?.cushions, s?.secondHit)}</div>
      <div class="note">${tipLabel(rec.tipX, rec.tipY)} · 힘 ${rec.speed.toFixed(1)} · ${rec.angleDeg.toFixed(1)}°</div>` : '<div class="note">득점 추천이 없었던 배치</div>'}</div>
    <div><h5>내 샷</h5>
      <div class="big" style="color:${o.scored ? 'var(--ok)' : 'var(--fail)'}">${o.scored ? '득점' : '실패'} 예상 · ${pct(prob)}</div>
      <div>${routeOf(o.firstHit, o.cueCushions, o.secondHit)}</div>
      <div class="note">${tipLabel(shot.tipX, shot.tipY)} · 힘 ${shot.speed.toFixed(1)} · ${shot.angleDeg.toFixed(1)}°</div></div>`;
}
$('disputeBtn').addEventListener('click', startDispute);
$('dCancel').addEventListener('click', () => endDispute(true));
$('dReason').querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => {
  if (!dispute) return;
  dispute.reason = b.dataset.v!;
  $('dReason').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
}));
$('dActual').querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => {
  if (!dispute) return;
  dispute.actual = b.dataset.v!;
  $('dActual').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
}));

async function postFeedback(payload: unknown): Promise<{ ok: true; id: number } | { ok: false; retry: boolean }> {
  try {
    const res = await fetch('/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    if (res.ok) return { ok: true, id: (await res.json()).id };
    return { ok: false, retry: res.status === 503 || res.status === 404 || res.status >= 500 };
  } catch { return { ok: false, retry: true }; }
}
$('dSubmit').addEventListener('click', async () => {
  if (!dispute) return;
  if (!dispute.reason) { $('dMsg').innerHTML = '<span style="color:var(--warn)">사유를 골라 주세요</span>'; return; }
  const o = result.outcome;
  const pick = (c: Candidate) => ({ angleDeg: c.angleDeg, speed: c.speed, tipX: c.tipX, tipY: c.tipY, prob: c.prob, width: c.width, summary: c.summary });
  const payload = {
    v: 1, kind: 'dispute', clientId: clientId(), appVersion: __APP_VERSION__,
    layout, cue: shot.cue, recMode,
    recommended: dispute.recs.map(pick), disputedRank: dispute.rank,
    userShot: { angleDeg: shot.angleDeg, speed: shot.speed, tipX: shot.tipX, tipY: shot.tipY },
    userSim: { scored: o.scored, firstHit: o.firstHit ?? null, secondHit: o.secondHit ?? null, cushions: o.cueCushions, kiss: o.kiss, prob },
    reason: dispute.reason, actualResult: dispute.actual,
    comment: ($('dComment') as HTMLTextAreaElement).value.trim().slice(0, 500),
    physics: PHYS, createdAt: new Date().toISOString(),
  };
  $('dMsg').textContent = '전송 중…';
  const r = await postFeedback(payload);
  if (r.ok) $('dMsg').innerHTML = `<span style="color:var(--ok)">제출 완료 (#${r.id}) — 고맙습니다!</span>`;
  else if (r.retry) {
    const q = store.get<unknown[]>(QUEUE_KEY, []);
    q.push(payload); store.set(QUEUE_KEY, q);
    $('dMsg').innerHTML = `<span style="color:var(--warn)">서버 저장소에 연결되지 않아 이 기기에 보관했습니다 (${q.length}건) — 연결되면 자동 전송</span>`;
  } else { $('dMsg').innerHTML = '<span style="color:var(--fail)">전송 실패 (입력값 오류)</span>'; return; }
  renderQueueNote();
  setTimeout(() => endDispute(false), 1400);
});

// 보관된 피드백 재전송
async function flushQueue() {
  const q = store.get<unknown[]>(QUEUE_KEY, []);
  if (!q.length) return;
  const left: unknown[] = [];
  for (const item of q) {
    const r = await postFeedback(item);
    if (!r.ok && r.retry) left.push(item);
  }
  store.set(QUEUE_KEY, left);
  renderQueueNote();
}
function renderQueueNote() {
  const n = store.get<unknown[]>(QUEUE_KEY, []).length;
  $('queueNote').classList.toggle('hidden', !n);
  $('queueNote').textContent = n ? `전송 대기 중인 이의제기 ${n}건 (이 기기에 보관됨)` : '';
}

// ───────── 와이드 모드: 도구 막대 · 서랍 · 테이블 위 정보 ─────────
const railBtn = (act: string) => document.querySelector<HTMLButtonElement>(`#rail [data-act="${act}"]`)!;
function openDrawer() {
  document.body.classList.add('drawer-open');
  railBtn('rec').classList.toggle('on', activeTab === 0);
  railBtn('shot').classList.toggle('on', activeTab === 2 && !dispute);
  railBtn('dispute').classList.toggle('on', activeTab === 2 && !!dispute);
}
function closeDrawer() {
  document.body.classList.remove('drawer-open');
  document.querySelectorAll('#rail button').forEach((b) => b.classList.remove('on'));
}
const drawerOpen = () => document.body.classList.contains('drawer-open');
$('drawerClose').addEventListener('click', closeDrawer);
document.querySelectorAll<HTMLButtonElement>('#rail button').forEach((b) => b.addEventListener('click', () => {
  const act = b.dataset.act;
  if (act === 'play') { closeDrawer(); startAnim(); return; }
  if (act === 'exit') { wideBtn.click(); return; }
  if (act === 'dispute') {
    if (!dispute) { if (searchGen && !$('disputeBtn').classList.contains('hidden')) startDispute(); else { selectTab(0); return; } }
    else if (drawerOpen() && activeTab === 2) closeDrawer(); else selectTab(2);
    return;
  }
  const tab = act === 'rec' ? 0 : 2;
  if (drawerOpen() && activeTab === tab) { closeDrawer(); return; }
  if (tab === 0 && !candidates.length && !activeSearch) recommend();
  selectTab(tab);
}));
// 서랍 밖(테이블)을 건드리면 서랍 닫기
// (이의제기 중에는 서랍을 열어 둔 채 겨냥할 수 있게 유지)
cv.addEventListener('pointerdown', () => { if (drawerOpen() && !dispute) closeDrawer(); });

function renderHud() {
  if (!result) return;
  const o = result.outcome;
  const hv = $('hudVerdict');
  hv.className = `hud-verdict ${o.scored ? 'ok' : 'fail'}`;
  hv.innerHTML = `<b>${o.scored ? '득점 예상' : '실패 예상'}</b>${prob === null ? '' : ` · 성공 ${Math.round(prob * 100)}%`}${dispute ? ' · <span style="color:var(--warn)">이의제기 중</span>' : ''}`;
  const hr = $('hudRec');
  hr.classList.toggle('hidden', !candidates.length || !!dispute);
  if (!candidates.length) return;
  const cur = currentCand();
  const c = candidates[Math.max(0, cur)];
  const s = c.summary;
  const route = s?.firstHit ? ` · ${KO[s.firstHit]}${s.thickness !== undefined ? ` ${thicknessText(s.thickness)}` : ''} → ${s.cushions.map((w) => WALL_SHORT[w]).join('·')} → ${s.secondHit ? KO[s.secondHit] : '—'}` : '';
  $('hudRecTxt').innerHTML = cur >= 0
    ? `추천 ${cur + 1}/${candidates.length} · <span class="r-prob">${Math.round(c.prob * 100)}%</span>${route}`
    : `추천 ${candidates.length}개 · ◀▶로 보기`;
}
const stepCand = (d: number) => {
  if (!candidates.length) return;
  const cur = currentCand();
  applyCandidate(cur < 0 ? 0 : (cur + d + candidates.length) % candidates.length);
};
$('hudPrev').addEventListener('click', () => stepCand(-1));
$('hudNext').addEventListener('click', () => stepCand(1));

// ───────── 시작 ─────────
// ───────── 모바일 탭 ─────────
const tabBtns = [...document.querySelectorAll<HTMLButtonElement>('#tabs button')];
const sections = [...document.querySelectorAll<HTMLDetailsElement>('#panel details')];
const TAB_TITLES = ['★ 추천 샷', '배치', '샷 조정', '다이아몬드 시스템'];
let activeTab = 0;
function selectTab(i: number) {
  activeTab = i;
  $('drawerTitle').textContent = dispute && i === 2 ? '⚑ 이의제기' : TAB_TITLES[i];
  if (document.body.classList.contains('wide')) openDrawer();
  tabBtns.forEach((x, j) => x.classList.toggle('on', j === i));
  sections.forEach((d, j) => { d.classList.toggle('active', j === i); if (j === i) d.open = true; });
  $('panel').scrollTop = 0;
}
tabBtns.forEach((b) => b.addEventListener('click', () => selectTab(+b.dataset.tab!)));

new ResizeObserver(resize).observe(stage);
// ───────── 큰 테이블(와이드) 모드 ─────────
// 세로로 든 휴대폰에서도 화면 전체를 90° 돌려 가로 당구대처럼 크게 표시. 실제로 가로로 돌리면 회전 없이 같은 배치
let wideMode = false;
const wideBtn = $('wideBtn');
function applyMode() {
  const rotated = wideMode && portraitMq.matches && mobileMq.matches;
  const wide = rotated || landscapeMq.matches;
  document.body.classList.toggle('rotated', rotated);
  document.body.classList.toggle('wide', wide);
  wideBtn.setAttribute('aria-pressed', String(wideMode));
  wideBtn.textContent = wideMode ? '↩ 기본' : '⤢ 크게';
  wideBtn.hidden = !mobileMq.matches || (!portraitMq.matches && !wideMode);
  railBtn('exit').hidden = !wideMode;
  if (!wide) closeDrawer();
  lastBox = '';
  resize();
}
wideBtn.addEventListener('click', async () => {
  wideMode = !wideMode;
  // 안드로이드 등 지원 기기: 전체화면 + 가로 고정으로 진짜 회전. 미지원(iOS)이면 CSS 회전으로 대체
  try {
    if (wideMode) {
      await document.documentElement.requestFullscreen?.();
      await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape');
    } else if (document.fullscreenElement) {
      screen.orientation?.unlock?.();
      await document.exitFullscreen();
    }
  } catch { /* 지원하지 않으면 CSS 회전만 사용 */ }
  applyMode();
});
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && wideMode && !portraitMq.matches) { wideMode = false; applyMode(); }
});
[mobileMq, landscapeMq, portraitMq].forEach((mq) => mq.addEventListener('change', applyMode));
applyMode();
addEventListener('resize', resize);
recompute();
recommend();
renderQueueNote();
flushQueue();

// 개발 서버에서만: 상태 확인용
if (import.meta.env.DEV) (window as unknown as { __state: () => unknown }).__state = () => ({ layout, shot, candidates });
