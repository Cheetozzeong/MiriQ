import './style.css';
import {
  BALL, BALL_IDS, DIAMOND, KO, PHYS, SKILL, TABLE, TABLE_SPEED, WALL_KO, setTableSpeed, simulate,
  type BallId, type Layout, type Pos, type Shot, type SimResult, type Skill, type TableSpeed, type Wall,
} from './physics';
import { calibrate, railPoint, solveSystem, type SystemResult } from './systems';
import type { ScanRange } from './ranges';
import { runJob, type ShotSummary, type WorkerRequest, type WorkerResponse } from './jobs';
import { initPhoto } from './photo';
import { LEVEL_KO, POWER_KO, difficulty, howTo, pattern, powerLevel, summarize, thicknessText, tipClock, type Difficulty } from './analysis';

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
interface Candidate extends ScanRange {
  direct?: boolean; // 탐색 단계에서 본 1차 분류: 공을 먼저 맞힘
  position?: number; // 후구 배치 (0~1): 득점 후 멈춘 배치에서 같은 수구로 칠 다음 샷의 최고 성공 확률
  defense?: number; // 수비 (0~1): 실패했을 때 상대가 치기 어려운 정도
  next?: Layout; // 이 샷 뒤 예상 배치
  tipX: number; tipY: number; speed: number; prob: number; score: number;
  summary?: ShotSummary; diff?: Difficulty; pat?: { key: string; label: string }; pending?: boolean;
}
let candidates: Candidate[] = [];
let selected = -1; // 현재 적용된 추천 후보
let anim: { start: number; rate: number } | null = null;

function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)); }

// ───────── 워커 ─────────
const newWorker = () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
// 현재 샷 성공 확률 전용 워커 (상시)
const probe = newWorker();
let reqId = 0, probId = 0;
const onProbe = (m: WorkerResponse) => {
  if (m.kind === 'eval' && m.id === probId) { prob = m.prob; renderDetail(); renderDispute(); }
};
probe.onmessage = (ev: MessageEvent<WorkerResponse>) => onProbe(ev.data);
let probeBroken = false;
probe.onerror = (e) => { e.preventDefault(); probeBroken = true; };
let probTimer = 0;
function requestProb() {
  prob = null;
  clearTimeout(probTimer);
  probTimer = window.setTimeout(() => {
    probId = ++reqId;
    const req: WorkerRequest = { kind: 'eval', id: probId, layout, shot, width: -1, n: 40, err: SKILL[prefs.skill as Skill], table: prefs.table };
    if (probeBroken || workersBroken) runJob(req, onProbe); else probe.postMessage(req);
  }, 200);
}

// 작업 여러 개를 코어 수만큼 워커에 나눠 실행. cancel() 시 워커를 종료하고 결과는 버린다
// 안정장치: 워커가 오류로 죽거나 40초 넘게 응답이 없으면 새 워커로 한 번 다시 시도하고,
// 그래도 안 되면(워커를 못 쓰는 환경 포함) 메인 스레드에서 직접 계산 → 진행률이 멈춘 채 끝나지 않는 일 방지
let workersBroken = false;
const JOB_TIMEOUT = 40000;
function runPool<T extends WorkerResponse>(reqs: WorkerRequest[], onProgress: (p: number) => void, onResult?: (i: number, r: T) => void) {
  const n = Math.max(1, Math.min(reqs.length, (navigator.hardwareConcurrency || 4) - 1, 8));
  const live = new Set<Worker>();
  const results: T[] = new Array(reqs.length);
  const prog = new Array(reqs.length).fill(0);
  const tries = new Array(reqs.length).fill(0);
  const queue = reqs.map((_, i) => i);
  let done = 0, cancelled = false;
  let resolve!: (r: T[]) => void;
  const promise = new Promise<T[]>((r) => { resolve = r; });
  const report = () => onProgress(prog.reduce((a, b) => a + b, 0) / Math.max(1, reqs.length));
  const finish = (i: number, m: T) => {
    if (cancelled || results[i]) return;
    results[i] = m; prog[i] = 1; done++;
    onResult?.(i, m);
    report();
    if (done === reqs.length) { live.forEach((w) => w.terminate()); live.clear(); resolve(results); }
  };
  // 메인 스레드에서 실행 (다음 프레임에 양보하며)
  const runOnMain = (i: number) => setTimeout(() => {
    if (cancelled) return;
    runJob({ ...reqs[i], id: i }, (m) => {
      if (m.kind === 'progress') { prog[i] = m.value; return; }
      finish(i, m as T);
    });
    if (queue.length) runOnMain(queue.shift()!);
  }, 0);
  const startWorker = () => {
    if (cancelled || !queue.length) return;
    if (workersBroken) { runOnMain(queue.shift()!); return; }
    let w: Worker;
    try { w = newWorker(); } catch { workersBroken = true; runOnMain(queue.shift()!); return; }
    live.add(w);
    let cur = -1, timer = 0, gotAny = false;
    const next = () => {
      clearTimeout(timer);
      if (cancelled || !queue.length) { w.terminate(); live.delete(w); return; }
      cur = queue.shift()!;
      tries[cur]++;
      timer = window.setTimeout(() => fail(), JOB_TIMEOUT);
      w.postMessage({ ...reqs[cur], id: cur });
    };
    const fail = () => {
      clearTimeout(timer);
      w.terminate(); live.delete(w);
      if (cancelled) return;
      if (!gotAny) workersBroken = true; // 한 번도 응답 못 한 워커 = 이 환경에선 워커 사용 불가
      if (cur >= 0 && !results[cur]) {
        if (tries[cur] < 2 && !workersBroken) queue.unshift(cur); else runOnMain(cur);
      }
      startWorker();
    };
    w.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      if (cancelled) return;
      gotAny = true;
      const m = ev.data;
      if (m.kind === 'progress') { prog[cur] = m.value; report(); clearTimeout(timer); timer = window.setTimeout(() => fail(), JOB_TIMEOUT); return; }
      finish(cur, m as T);
      next();
    };
    w.onerror = (e) => { e.preventDefault(); fail(); };
    w.onmessageerror = () => fail();
    next();
  };
  if (!reqs.length) resolve([]);
  else for (let k = 0; k < n; k++) startWorker();
  return { promise, cancel: () => { cancelled = true; live.forEach((w) => w.terminate()); live.clear(); } };
}

// ───────── 예측 ─────────
let pending = false;
let interacting = false; // 드래그 중에는 가벼운 시뮬레이션으로 반응성 확보
function recompute() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    updateOpening();
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

// ───────── 초구 규칙 ─────────
// 공이 초구 위치(빨간공 풋 스팟, 상대 공 헤드 스팟, 수구는 헤드 스트링 위 좌우 15.24cm)에 있으면
// 자동으로 초구 규칙 적용: 1적구는 빨간공, 쿠션을 먼저 맞히면 파울. 공을 움직이면 자동 해제
let openingForcedFirst = false;
function isOpeningLayout() {
  const near = (p: Pos, x: number, y: number) => Math.hypot(p.x - x, p.y - y) < 0.015;
  const other: BallId = shot.cue === 'white' ? 'yellow' : 'white';
  const head = DIAMOND * 2, foot = DIAMOND * 6, mid = TABLE.W / 2;
  return near(layout.red, foot, mid) && near(layout[other], head, mid)
    && (near(layout[shot.cue], head, mid - 0.1524) || near(layout[shot.cue], head, mid + 0.1524));
}
function updateOpening() {
  shot.opening = isOpeningLayout();
  if (shot.opening) { shot.firstBall = 'red'; openingForcedFirst = true; }
  else if (openingForcedFirst) { shot.firstBall = undefined; openingForcedFirst = false; }
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
  const portrait = document.body.classList.contains('portrait');
  let w: number, h: number;
  if (wide || portrait) {
    // 와이드: 테이블이 화면을 가득 채우고 오른쪽엔 얇은 도구 막대만
    // 세로 휴대폰: 하단 시트 위 영역을 테이블이 채움 (더 크게 나오는 방향으로 세움)
    const cs = getComputedStyle(layoutEl);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const railW = ($('rail').offsetWidth || RAIL_W - 6) + 6;
    const boxW = layoutEl.clientWidth - padX - railW, boxH = layoutEl.clientHeight - padY;
    const sH = Math.min(boxW / fullL, boxH / fullW), sV = Math.min(boxW / fullW, boxH / fullL);
    vertical = !wide && sV > sH * 1.05;
    S = Math.max(30, vertical ? sV : sH);
    w = (vertical ? fullW : fullL) * S; h = (vertical ? fullL : fullW) * S;
    stage.style.width = `${w}px`;
  } else if (!mobileMq.matches) {
    // 데스크톱: 페이지가 스크롤되지 않는 고정 화면 — 테이블 영역(stage)을 꽉 채움
    stage.style.width = ''; stage.style.height = '';
    const boxW = stage.clientWidth, boxH = Math.max(160, stage.clientHeight);
    vertical = false;
    S = Math.min(boxW / fullL, boxH / fullW);
    w = fullL * S; h = fullW * S;
  } else {
    // 그 밖의 작은 화면: 화면 높이의 56%까지, 더 크게 나오는 방향으로 테이블을 세운다
    stage.style.width = '';
    const boxW = stage.clientWidth;
    const boxH = Math.max(200, innerHeight * 0.56);
    const sH = Math.min(boxW / fullL, boxH / fullW);
    const sV = Math.min(boxW / fullW, boxH / fullL);
    vertical = sV > sH * 1.1;
    S = vertical ? sV : sH;
    w = (vertical ? fullW : fullL) * S; h = (vertical ? fullL : fullW) * S;
  }
  const key = `${w}x${h}`;
  if (mobileMq.matches || wide || portrait) stage.style.height = `${h}px`;
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
    if (e.type === 'cushion' && e.ball === shot.cue && e.counted !== false) {
      n++;
      if (n > 8) continue;
      const [x, y] = px(e);
      const before = e.t < secondT;
      ctx.fillStyle = before ? (n <= 3 ? '#ffb020' : '#9fe870') : 'rgba(180,180,180,0.7)';
      circle(x, y, 8); ctx.fill();
      ctx.fillStyle = '#111'; ctx.font = 'bold 10px sans-serif'; ctx.fillText(String(n), x, y + 0.5);
    }
    if (e.type === 'ball' && (e.ball === shot.cue || e.other === shot.cue)) {
      // 1적 = 1적구에 처음 닿은 순간, 2적 = 2적구에 처음 닿은 순간 (1적구 되맞음은 표시하지 않음)
      const obj = ballOf(e)!;
      const which = obj === result.outcome.firstHit && !(contact & 1) ? 1 : obj === result.outcome.secondHit && !(contact & 2) ? 2 : 0;
      if (!which) continue;
      contact |= which;
      const cuePt = nearestPathPoint(result.paths[shot.cue], e);
      const [x, y] = px(cuePt);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.2; ctx.setLineDash([2, 2]);
      circle(x, y, R * S); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = COLORS[obj]; ctx.font = 'bold 11px sans-serif';
      ctx.fillText(which === 1 ? '1적' : '2적', x, y - R * S - 9);
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
  if (loupe) drawLoupe(loupe.x, loupe.y, loupe.id);
}

// 돋보기: 손가락에 가려지는 부분을 2.5배로 확대해 구석에 표시 + 좌표(다이아몬드)
let loupe: { x: number; y: number; id: BallId } | null = null;
function drawLoupe(sx: number, sy: number, id: BallId) {
  const r = 54, zoom = 2.5, dpr = devicePixelRatio || 1, W = cv.clientWidth;
  const cx = sx < W / 2 ? W - r - 12 : r + 12, cy = r + 12;
  const src = r / zoom;
  ctx.save();
  circle(cx, cy, r); ctx.clip();
  ctx.drawImage(cv, (sx - src) * dpr, (sy - src) * dpr, 2 * src * dpr, 2 * src * dpr, cx - r, cy - r, 2 * r, 2 * r);
  ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 1;
  line([cx - 10, cy], [cx + 10, cy]); line([cx, cy - 10], [cx, cy + 10]);
  ctx.restore();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; circle(cx, cy, r); ctx.stroke();
  const p = layout[id];
  ctx.fillStyle = 'rgba(0,0,0,.7)'; ctx.fillRect(cx - 44, cy + r + 4, 88, 20);
  ctx.fillStyle = '#fff'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(`${(p.x / DIAMOND).toFixed(2)} , ${(p.y / DIAMOND).toFixed(2)}`, cx, cy + r + 14);
}

function drawAnim(showOthers: boolean) {
  const t = ((performance.now() - anim!.start) / 1000) * anim!.rate;
  const fr = result.frames;
  let k = fr.findIndex((f) => f.t > t);
  if (k < 0) { k = fr.length - 1; anim = null; showAfterShot(); }
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
  const c = document.body.classList;
  if (!c.contains('rotated')) return [ev.clientX - r.left, ev.clientY - r.top];
  return c.contains('rotated-ccw')
    ? [r.bottom - ev.clientY, ev.clientX - r.left] // 반시계 90°
    : [ev.clientY - r.top, r.right - ev.clientX]; // 시계 90°
}
const screenPos = (ev: PointerEvent) => localXY(cv, ev);
cv.addEventListener('pointerdown', (ev) => {
  if (anim) { anim = null; clearTimeout(animTimer); draw(); }
  const [sx, sy] = screenPos(ev);
  const p = toTable(sx, sy);
  if (placeMode && !dispute) {
    // 탭 배치 모드: 고른 공을 탭한 자리에 놓고 다음 공으로
    placeBall(placeMode, snapPos(p));
    loupe = { x: sx, y: sy, id: placeMode };
    setTimeout(() => { loupe = null; draw(); }, 700);
    const order: BallId[] = ['white', 'yellow', 'red'];
    const next = order[order.indexOf(placeMode) + 1];
    placedSinceStart = true;
    saveHistory();
    setPlaceMode(next ?? null);
    recompute();
    return;
  }
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
    placeBall(drag.id, snapPos({ x: drag.from.x + p.x - drag.p0.x, y: drag.from.y + p.y - drag.p0.y }));
    const [lx, ly] = px(layout[drag.id]);
    loupe = { x: lx, y: ly, id: drag.id };
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
  loupe = null;
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
  const rl = document.querySelector<HTMLElement>('#rail [data-act="lock"]');
  if (rl) { rl.querySelector('.ico')!.textContent = locked ? '🔒' : '🔓'; rl.classList.toggle('on-lock', locked); }
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
  if (shot.firstBall === shot.cue) shot.firstBall = undefined;
  recompute();
  layoutChanged();
}));
const presetSel = $<HTMLSelectElement>('preset');
presetSel.add(new Option('배치 선택…', ''));
PRESETS.forEach((p, i) => presetSel.add(new Option(p.name, String(i))));
presetSel.add(new Option('랜덤 배치', 'rand'));
presetSel.addEventListener('change', () => {
  if (dispute || presetSel.value === '') return;
  if (presetSel.value === 'rand') {
    for (const id of BALL_IDS) placeBall(id, { x: R + Math.random() * (TABLE.L - 2 * R), y: R + Math.random() * (TABLE.W - 2 * R) });
  } else layout = clone(PRESETS[+presetSel.value].layout);
  if (presetSel.value !== '0' && !openingForcedFirst) shot.firstBall = undefined;
  presetSel.value = ''; // 같은 배치를 다시 골라도 동작하도록
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
document.querySelectorAll<HTMLButtonElement>('#panel [data-da]').forEach((b) => b.addEventListener('click', () => {
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

function renderFirstSel() {
  const other = shot.cue === 'white' ? 'yellow' : 'white';
  const opts: [string, string][] = [['', '자동'], ['red', '빨간공'], [other, KO[other]]];
  const cur = shot.firstBall ?? '';
  $('firstSel').innerHTML = opts.map(([v, t]) => `<button data-v="${v}" class="${v === cur ? 'on' : ''}"${shot.opening ? ' disabled' : ''}>${t}</button>`).join('');
  $('firstNote').innerHTML = shot.opening
    ? '<b style="color:var(--warn)">초구 규칙</b> · 빨간공을 쿠션 없이 직접'
    : shot.firstBall ? '이 공을 먼저 맞혀야 득점' : '어느 공이든 먼저';
  $('firstNote').classList.toggle('opening', !!shot.opening);
}
$('firstSel').addEventListener('click', (ev) => {
  const b = (ev.target as HTMLElement).closest('button');
  if (!b || dispute || shot.opening) return;
  shot.firstBall = (b.dataset.v || undefined) as BallId | undefined;
  openingForcedFirst = false;
  renderFirstSel();
  recompute();
  layoutChanged();
});
function syncInputs() {
  renderFirstSel();
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
    <p class="note">성공 확률 = ${SKILL[prefs.skill as Skill].label} 기준 스트로크 오차(방향 ±${SKILL[prefs.skill as Skill].angle}°, 힘 ±${Math.round(SKILL[prefs.skill as Skill].speed * 100)}%)로 40회 시뮬레이션</p>
    <ol class="events">${cueEvents.slice(0, 14).map((e) => `<li class="cue">${e.t.toFixed(2)}s · ${
      e.type === 'cushion' ? `${WALL_KO[e.wall!]} (${posTxt(e)})${e.counted === false ? ' · 쿠션 미인정(스침/레일 타기)' : ''}` : `${KO[ballOf(e)!]} 접촉`
    } · ${e.speed.toFixed(2)}m/s</li>`).join('')}</ol>`;
}
const posTxt = (p: Pos) => `${(p.x / DIAMOND).toFixed(1)}, ${(p.y / DIAMOND).toFixed(1)}`;

// ───────── 추천 샷 (메인 기능) ─────────
// 1) 여러 힘·당점 조합으로 360° 를 병렬 탐색 (1° → 득점/아까운 방향만 0.2°) — 조합 하나 끝날 때마다 바로 표시
// 2) 각도 허용폭이 넓은 후보를 실력 단계 오차로 성공 확률 계산 + 정밀 검증
// 3) 순위 = 성공 확률 − 난이도 벌점, 경로 형태별 대표를 우선 보여줘 비슷한 샷만 나오지 않게
const MODES = {
  fast: [-0.3, 0, 0.3].flatMap((tipX) => [2.6, 3.4].map((speed) => ({ tipX, tipY: 0.2, speed }))),
  fine: [
    ...[-0.4, -0.2, 0, 0.2, 0.4].flatMap((tipX) => [2.2, 3.0, 3.8].map((speed) => ({ tipX, tipY: 0.2, speed }))),
    ...[-0.3, 0.3].map((tipX) => ({ tipX, tipY: -0.3, speed: 3.2 })),
    { tipX: 0, tipY: 0.4, speed: 2.8 },
  ],
};
let recMode: keyof typeof MODES = 'fast';
// 추천 기준: 지표별 가중치 [득점 확률, 후구 배치, 수비]
type Priority = 'score' | 'position' | 'defense' | 'balanced';
const PRIO: Record<Priority, { label: string; w: [number, number, number] }> = {
  score: { label: '득점 우선', w: [1, 0.15, 0.1] },
  position: { label: '후구 배치 우선', w: [0.55, 0.65, 0.1] },
  defense: { label: '수비 우선', w: [0.55, 0.1, 0.65] },
  balanced: { label: '균형', w: [0.7, 0.35, 0.35] },
};
let pool: Candidate[] = []; // 득점이 확인된 모든 후보 (기준을 바꾸면 여기서 다시 고름)
let posDone = false; // 후구·수비 평가가 끝났는지
let searchGen = 0;
let activeSearch: { cancel(): void } | null = null;

// 사용자 설정 (이 기기에 저장)
const prefs = (() => {
  const def = { skill: 'intermediate' as Skill, table: 'normal' as TableSpeed, easyFirst: true, priority: 'score' as Priority, bigMode: true, flip: false };
  try { return { ...def, ...JSON.parse(localStorage.getItem('miriq.prefs') || '{}') }; } catch { return def; }
})();
const savePrefs = () => { try { localStorage.setItem('miriq.prefs', JSON.stringify(prefs)); } catch { /* 저장 불가 */ } };
setTableSpeed(prefs.table);

function setProgress(p: number | null, text = '') {
  $('progress').classList.toggle('hidden', p === null);
  if (p !== null) ($('progress').firstElementChild as HTMLElement).style.width = `${p * 100}%`;
  $('recStatus').innerHTML = text;
  setTableLoading(p === null ? null : `추천 경로 찾는 중… ${Math.round(p * 100)}%`, p);
}
// 테이블 위 로딩 표시: 시트를 접어 둬도 탐색 중임을 알 수 있게
function setTableLoading(text: string | null, p: number | null = null) {
  $('tableLoading').classList.toggle('hidden', text === null);
  if (text === null) return;
  $('tlText').textContent = text;
  $('tlBar').style.width = `${(p ?? 0) * 100}%`;
}

// 순위: ① 공을 먼저 맞히는 샷(직접) → ② 빈쿠션은 직접 샷 다음에. 각 그룹 안에서는 점수(확률 − 난이도) 순,
// 경로 형태별 대표를 먼저 골라 비슷한 샷만 나오지 않게 함
function rankCandidates(list: Candidate[], prio: Priority = prefs.priority as Priority, limit = 6) {
  const w = prefs.easyFirst ? 0.75 : 0.25;
  const [ws, wp, wd] = PRIO[prio].w;
  // 평가하지 않은 후보의 후구(다음 샷 성공 확률)는 낮게(0.1), 수비는 0.3으로 가정 → 평가가 끝난 좋은 후보가 위로
  for (const c of list) c.score = ws * c.prob * 100 + wp * (c.position ?? 0.1) * 100 + wd * (c.defense ?? 0.3) * 100 - w * (c.diff?.score ?? 0);
  const pick = (group: Candidate[]) => {
    group.sort((a, b) => b.score - a.score);
    const out: Candidate[] = [], seen = new Set<string>();
    for (const c of group) if (c.pat && !seen.has(c.pat.key)) { seen.add(c.pat.key); out.push(c); }
    for (const c of group) if (!out.includes(c)) out.push(c);
    return out.sort((a, b) => b.score - a.score);
  };
  const direct = pick(list.filter((c) => !c.summary?.cushionFirst));
  const bank = pick(list.filter((c) => c.summary?.cushionFirst));
  // 성공 확률 5% 미만은 사실상 치기 어려운 샷 → 직접·빈쿠션 모두 뒤로
  const ok = (c: Candidate) => c.prob >= 0.05;
  return [...direct.filter(ok), ...bank.filter(ok), ...direct.filter((c) => !ok(c)), ...bank.filter((c) => !ok(c))].slice(0, limit);
}

async function recommend() {
  activeSearch?.cancel();
  const gen = ++searchGen;
  updateOpening();
  const lay = clone(layout);
  const base = { ...shot };
  candidates = []; renderCands();
  const variants = MODES[recMode];
  const t0 = performance.now();
  setProgress(0, `득점 경로 탐색 중… (${variants.length}가지 힘·당점)`);
  let found: Candidate[] = [];
  const scan = runPool<Extract<WorkerResponse, { kind: 'scan' }>>(
    variants.map((v) => ({ kind: 'scan', id: 0, layout: lay, shot: { ...base, ...v }, table: prefs.table })),
    (p) => { if (gen === searchGen) setProgress(p * 0.75, `득점 경로 탐색 중… ${Math.round(p * 100)}%${found.length ? ` · 후보 ${found.length}개 발견` : ''}`); },
    (i, r) => {
      if (gen !== searchGen) return;
      found = found.concat(r.ranges.map((g) => ({ ...g, ...variants[i], prob: 0, score: 0, pending: true })));
      // 확률 계산 전 임시 표시 (허용폭 순)
      candidates = [...found].sort((a, b) => b.width - a.width).slice(0, 6);
      renderCands();
    },
  );
  activeSearch = scan;
  await scan.promise;
  if (gen !== searchGen) return;
  // 확률 계산 대상: 공을 먼저 맞히는 후보 위주(최대 12개) + 빈쿠션 후보(최대 6개)
  const byWidth = [...found].sort((a, b) => b.width - a.width);
  const top = [...byWidth.filter((c) => c.direct).slice(0, 12), ...byWidth.filter((c) => !c.direct).slice(0, 6)];
  const err = SKILL[prefs.skill as Skill];
  const ev = runPool<Extract<WorkerResponse, { kind: 'eval' }>>(
    top.map((c) => ({ kind: 'eval', id: 0, layout: lay, shot: { ...base, ...c }, width: c.width, n: 30, err, table: prefs.table })),
    (p) => { if (gen === searchGen) setProgress(0.75 + p * 0.25, `${SKILL[prefs.skill as Skill].label} 기준 성공 확률 계산 중…`); },
  );
  activeSearch = ev;
  const evals = await ev.promise;
  if (gen !== searchGen) return;
  const scored: Candidate[] = [];
  top.forEach((c, i) => {
    const e = evals[i];
    if (!e.verified || !e.summary.scored) return; // 정밀 시뮬레이션에서 득점이 확인된 후보만 추천
    const shotC = { ...base, ...c, angleDeg: e.angleDeg };
    scored.push({ ...c, angleDeg: e.angleDeg, prob: e.prob, summary: e.summary, pending: false, score: 0,
      diff: difficulty(lay, shotC, e.summary), pat: pattern(e.summary) });
  });
  pool = scored;
  candidates = rankCandidates(pool);
  activeSearch = null;
  renderCands();
  const doneText = () => `득점 샷 ${candidates.length}개 (직접 ${candidates.filter((c) => !c.summary?.cushionFirst).length} · 빈쿠션 ${candidates.filter((c) => c.summary?.cushionFirst).length}) · ${((performance.now() - t0) / 1000).toFixed(1)}초 <span class="rec-sum">(${prefsSummary()})</span>`;
  $('disputeBtn').classList.remove('hidden');
  if (!candidates.length) {
    setProgress(null, `득점 경로를 찾지 못했습니다${recMode === 'fast' ? ' — <b>정밀</b> 모드로 다시 시도해 보세요' : ''}`);
    renderCands();
    return;
  }
  // 득점 우선이면 바로 1순위를 보여주고, 후구·수비는 뒤에서 계산해 카드에 채움
  const waitPos = prefs.priority !== 'score';
  if (!waitPos) { setProgress(null, doneText()); applyCandidate(0); }
  // 3단계: 상위 후보(득점 기준 4개)의 후구 배치·수비 평가 — 후구는 다음 배치에 추천 엔진을 다시 돌려 계산
  // (대기 시간을 줄이려고 4개만; 나머지 카드는 후구·수비 "—")
  const targets = rankCandidates(pool, 'score', 4);
  posDone = false;
  const posJob = runPool<Extract<WorkerResponse, { kind: 'pos' }>>(
    targets.map((c) => ({ kind: 'pos', id: 0, layout: lay, shot: { ...base, angleDeg: c.angleDeg, speed: c.speed, tipX: c.tipX, tipY: c.tipY }, err, table: prefs.table })),
    (p) => {
      if (gen !== searchGen) return;
      if (waitPos) setProgress(p, `후구 배치·수비 평가 중… ${Math.round(p * 100)}%`);
      else $('recStatus').innerHTML = `${doneText()} <span class="note">· 후구·수비 평가 ${Math.round(p * 100)}%</span>`;
    },
    (i, r) => {
      if (gen !== searchGen) return;
      Object.assign(targets[i], { position: r.position, defense: r.defense, next: r.next });
      renderCands();
    },
  );
  activeSearch = posJob;
  await posJob.promise;
  if (gen !== searchGen) return;
  activeSearch = null;
  posDone = true;
  const cur = currentCand() >= 0 ? candidates[currentCand()] : null;
  candidates = rankCandidates(pool);
  setProgress(null, doneText());
  if (waitPos || !cur) applyCandidate(0);
  else renderCands(); // 득점 우선: 보고 있던 샷은 그대로 두고 지표만 갱신
}

let recTimer = 0;
function layoutChanged() {
  updateOpening(); // 초구 여부(→ 1적구 자동 지정/해제)를 배치 기준으로 바로 반영
  hideAfterShot();
  hideGuide();
  setShooting(false);
  activeSearch?.cancel(); searchGen++;
  $('disputeBtn').classList.add('hidden');
  candidates = []; pool = []; lastApplied = -1; renderCands();
  clearTimeout(recTimer);
  saveHistory();
  if (!($('autoRec') as HTMLInputElement).checked) {
    setProgress(null, '배치가 바뀌었습니다. <b>추천 받기</b>를 눌러 주세요.');
    return;
  }
  setProgress(null, '배치 변경 — 곧 추천을 시작합니다');
  setTableLoading('배치 변경 확인 — 추천 경로 찾는 중…', 0);
  recTimer = window.setTimeout(recommend, 450);
}

let lastApplied = -1; // 마지막으로 적용한 추천 (이의제기 대상 기본값)
function applyCandidate(i: number, guide = false) {
  const c = candidates[i];
  lastApplied = i;
  Object.assign(shot, { angleDeg: c.angleDeg, speed: c.speed, tipX: c.tipX, tipY: c.tipY });
  sysRes = null;
  recompute();
  // 안내 카드는 자동으로 띄우지 않음 — "이걸로 칠게요"를 눌렀을 때만 (테이블을 가리지 않게)
  if (guide) guideSoon();
}
const currentCand = () => candidates.findIndex((c) =>
  c.angleDeg === shot.angleDeg && c.speed === shot.speed && c.tipX === shot.tipX && c.tipY === shot.tipY);

const WALL_SHORT: Record<Wall, string> = { top: '상', bottom: '하', left: '좌', right: '우' };
const thickLabel = (t: number) => (t >= 0.94 ? '정면' : `${thicknessText(t)} 두께`);
function tipIcon(tx: number, ty: number) {
  const x = 12 + tx * 10, y = 12 - ty * 10;
  return `<svg class="tipico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10.5"/><circle class="d" cx="${x}" cy="${y}" r="2.6"/></svg>`;
}
function tipLabel(tx: number, ty: number) {
  const side = Math.abs(tx) < 0.03 ? '중앙' : `${tx > 0 ? '우' : '좌'} ${(Math.abs(tx) / 0.2).toFixed(1)}팁`;
  const vert = Math.abs(ty) < 0.03 ? '' : ` · ${ty > 0 ? '상' : '하'} ${(Math.abs(ty) / 0.2).toFixed(1)}팁`;
  return side + vert;
}
// 카드의 세 지표: 득점 확률 · 후구 배치 · 수비 (선택한 기준은 강조)
function metricsHtml(c: Candidate) {
  const prio = prefs.priority as Priority;
  const bar = (v: number | undefined, label?: string, good = 0.6, ok = 0.3) => {
    if (v === undefined) return `<span class="wait">${posDone ? '—' : '계산 중'}</span>`;
    const col = v > good ? 'var(--ok)' : v > ok ? 'var(--warn)' : 'var(--fail)';
    return `<span class="m-bar"><i style="width:${Math.round(Math.min(1, v / (good * 1.4)) * 100)}%;background:${col}"></i></span>${label ?? (v > good ? '좋음' : v > ok ? '보통' : '나쁨')}`;
  };
  return `<div class="metrics">
    <span class="metric${prio === 'score' ? ' prio' : ''}">득점 ${Math.round(c.prob * 100)}%</span>
    <span class="metric${prio === 'position' ? ' prio' : ''}" title="득점 후 멈춘 배치에서 같은 수구로 칠 다음 샷의 최고 성공 확률">후구 ${bar(c.position, c.position === undefined ? undefined : `다음 ${Math.round(c.position * 100)}%`, 0.35, 0.12)}</span>
    <span class="metric${prio === 'defense' ? ' prio' : ''}" title="실패했을 때 상대가 치기 어려운 정도">수비 ${bar(c.defense)}</span>
  </div>`;
}
function renderCands() {
  const ol = $('cands');
  const cur = currentCand();
  ol.innerHTML = candidates.map((c, i) => {
    const s = c.summary;
    const dot = (id: BallId) => `<span class="ball-dot" style="background:${COLORS[id]}"></span>${KO[id]}`;
    if (c.pending) {
      return `<li class="card pending" data-i="${i}"><div class="card-top"><span class="rank">…</span>
        <span class="note">확률 계산 중 · 허용폭 ${c.width.toFixed(1)}°</span></div>
        <div class="params">${tipIcon(c.tipX, c.tipY)} ${tipClock(c.tipX, c.tipY)} · 힘 ${powerLevel(c.speed)}/5</div></li>`;
    }
    const pct = Math.round(c.prob * 100);
    const color = c.prob > 0.6 ? 'var(--ok)' : c.prob > 0.3 ? 'var(--warn)' : 'var(--fail)';
    const h = howTo({ ...shot, ...c }, s);
    const route = s?.firstHit ? `${dot(s.firstHit)} → ${s.cushions.map((w) => WALL_SHORT[w]).join('·') || '—'} → ${s.secondHit ? dot(s.secondHit) : '—'}` : '';
    const lv = c.diff?.level ?? 'normal';
    return `<li class="card${i === cur ? ' on' : ''}" data-i="${i}">
      <div class="card-top"><span class="rank">${i + 1}</span>
        <span class="lv lv-${lv}">${LEVEL_KO[lv]}</span><span class="pat">${c.pat?.label ?? ''}</span>
        <b class="pct" style="color:${color}">${pct}%</b></div>
      <div class="how"><b>${h.aim}</b> · ${tipIcon(c.tipX, c.tipY)} ${h.tip} · ${h.power}</div>
      <div class="route">${route}${s?.kiss ? ' <span class="kiss">키스 주의</span>' : ''}</div>
      ${metricsHtml(c)}
      ${c.diff && c.diff.reasons.length ? `<div class="note">까다로운 점: ${c.diff.reasons.slice(0, 3).join(', ')}</div>` : ''}
      ${i === cur ? '<div class="tag">적용됨 · 한 번 더 탭하면 재생</div><button class="primary card-go" data-go="1">🎯 이걸로 칠게요</button>' : ''}
    </li>`;
  }).join('');
  ol.querySelectorAll<HTMLElement>('.card').forEach((li) => li.addEventListener('click', (ev) => {
    if ((ev.target as HTMLElement).closest('[data-go]')) { goShoot(); return; }
    const i = +li.dataset.i!;
    if (candidates[i]?.pending) return;
    if (i === currentCand()) { closeDrawer(); startAnim(); return; } // 이미 적용된 카드를 다시 탭하면 재생
    applyCandidate(i);
    closeDrawer(); // 와이드 모드: 테이블 전체로 경로 확인
  }));
  renderHud();
  renderStats();
}
$('recBtn').addEventListener('click', () => { clearTimeout(recTimer); recommend(); });
$('recMode').querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => {
  recMode = b.dataset.v as keyof typeof MODES;
  $('recMode').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  clearTimeout(recTimer); recommend();
}));
// ⚙ 추천 설정 접기/펼치기 (접힌 상태에선 현재 설정 요약을 상태줄에 표시)
const recOpts = $('recOpts');
recOpts.classList.add('collapsed');
$('recOptBtn').addEventListener('click', () => {
  const open = recOpts.classList.toggle('collapsed') === false;
  $('recOptBtn').setAttribute('aria-expanded', String(open));
});
const prefsSummary = () => `${PRIO[prefs.priority as Priority].label} · ${shot.opening ? '초구 규칙 · ' : shot.firstBall ? `1적구 ${KO[shot.firstBall]} · ` : ''}${SKILL[prefs.skill as Skill].label} · 테이블 ${TABLE_SPEED[prefs.table as TableSpeed].label}${prefs.easyFirst ? ' · 쉬운 샷 우선' : ''}`;

// 추천 기준 선택: 후구·수비 평가가 끝났으면 바로 다시 정렬, 아니면 새로 탐색
const prioSel = $<HTMLSelectElement>('prioSel');
prioSel.value = prefs.priority;
prioSel.addEventListener('change', () => {
  prefs.priority = prioSel.value as Priority; savePrefs();
  if (!activeSearch && pool.some((c) => c.position !== undefined)) {
    candidates = rankCandidates(pool);
    applyCandidate(0);
    renderCands();
  } else { clearTimeout(recTimer); recommend(); }
});

// 설정: 실력 단계 · 테이블 상태 · 쉬운 샷 우선
function bindSeg(id: string, key: 'skill' | 'table', after: () => void) {
  const btns = $(id).querySelectorAll<HTMLButtonElement>('button');
  const sync = () => btns.forEach((x) => x.classList.toggle('on', x.dataset.v === prefs[key]));
  btns.forEach((b) => b.addEventListener('click', () => { (prefs as Record<string, unknown>)[key] = b.dataset.v; savePrefs(); sync(); after(); }));
  sync();
}
bindSeg('skillSel', 'skill', () => { clearTimeout(recTimer); recommend(); requestProb(); });
bindSeg('tableSel', 'table', () => { setTableSpeed(prefs.table); recompute(); clearTimeout(recTimer); recommend(); });
($('easyFirst') as HTMLInputElement).checked = prefs.easyFirst;
$('easyFirst').addEventListener('change', () => {
  prefs.easyFirst = ($('easyFirst') as HTMLInputElement).checked; savePrefs();
  if (pool.length && !activeSearch) { candidates = rankCandidates(pool); applyCandidate(0); }
});

// ───────── 재생 ─────────
let animTimer = 0;
function startAnim() {
  if (isPortrait()) setSheet('min'); // 재생할 땐 시트를 최소로 접어 테이블 전체를 보여줌
  hideGuide(); hideAfterShot(); hideAdj();
  anim = { start: performance.now(), rate: ($('slow') as HTMLInputElement).checked ? 0.5 : 1 };
  // 화면 갱신이 멈춰도(백그라운드 등) 재생 시간이 지나면 끝난 것으로 처리
  const a0 = anim;
  clearTimeout(animTimer);
  animTimer = window.setTimeout(() => { if (anim === a0) { anim = null; draw(); showAfterShot(); } }, (result.duration / a0.rate) * 1000 + 300);
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
  [sections[1], document.querySelector<HTMLElement>('#tabs [data-tab="1"]')!, $('recBtn'), $('recMode'), $('lock'), $('disputeBtn')].forEach((el) => el.classList.toggle('lock-hide', on));
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
    layout, cue: shot.cue, firstBall: shot.firstBall ?? null, recMode,
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
// 세로 휴대폰 하단 시트 3단계: min(탭만 · 테이블 최대) / mid(첫 추천 카드까지) / full(화면 대부분)
type SheetState = 'min' | 'mid' | 'full';
let sheetState: SheetState = 'mid';
const isPortrait = () => document.body.classList.contains('portrait');
function setSheet(st: SheetState) {
  const prev = sheetState;
  sheetState = st;
  const b = document.body.classList;
  b.toggle('sheet-min', st === 'min');
  b.toggle('drawer-open', st === 'full');
  b.toggle('sheet-half', st === 'full' && activeTab === 2);
  // min ↔ mid 는 테이블 영역 높이가 바뀌므로 다시 맞춤
  if (isPortrait() && (prev === 'min') !== (st === 'min')) { lastBox = ''; resize(); }
}
function openDrawer() {
  if (isPortrait()) { setSheet('full'); return; }
  document.body.classList.add('drawer-open');
  document.body.classList.toggle('sheet-half', activeTab === 2);
  railBtn('rec').classList.toggle('on', activeTab === 0);
  railBtn('shot').classList.toggle('on', activeTab === 2 && !dispute);
  railBtn('dispute').classList.toggle('on', activeTab === 2 && !!dispute);
}
// 닫기: 세로 시트는 full → mid (테이블 경로가 보이게), 와이드 서랍은 닫음
function closeDrawer() {
  if (isPortrait()) { if (sheetState === 'full') setSheet('mid'); return; }
  document.body.classList.remove('drawer-open');
  document.querySelectorAll('#rail button').forEach((b) => b.classList.remove('on'));
}
const drawerOpen = () => document.body.classList.contains('drawer-open');
// 와이드(서랍) 또는 세로 휴대폰(하단 시트): 패널을 펼치고 접는 구조
const sheetLayout = () => document.body.classList.contains('wide') || document.body.classList.contains('portrait');

// 하단 시트 손잡이: 위로 밀면 한 단계 펼침, 아래로 밀면 한 단계 접힘 (크게 밀면 두 단계), 탭하면 min→mid→full→mid
{
  const handle = $('sheetHandle');
  const order: SheetState[] = ['min', 'mid', 'full'];
  let y0: number | null = null;
  handle.addEventListener('pointerdown', (ev) => { y0 = ev.clientY; handle.setPointerCapture(ev.pointerId); });
  handle.addEventListener('pointerup', (ev) => {
    if (y0 === null) return;
    const dy = ev.clientY - y0;
    y0 = null;
    const i = order.indexOf(sheetState);
    if (Math.abs(dy) < 20) { setSheet(sheetState === 'full' ? 'mid' : order[i + 1]); return; }
    const steps = Math.abs(dy) > innerHeight * 0.3 ? 2 : 1;
    setSheet(order[Math.max(0, Math.min(2, i + (dy < 0 ? steps : -steps)))]);
  });
  handle.addEventListener('pointercancel', () => { y0 = null; });
}
$('drawerClose').addEventListener('click', closeDrawer);
document.querySelectorAll<HTMLButtonElement>('#rail button').forEach((b) => b.addEventListener('click', () => {
  const act = b.dataset.act;
  if (act === 'play') { closeDrawer(); startAnim(); return; }
  if (act === 'lock') { $('lock').click(); return; }
  if (act === 'flip') { prefs.flip = !prefs.flip; savePrefs(); applyMode(); return; }
  if (act === 'adjust') { closeDrawer(); if ($('adj').classList.contains('hidden')) showAdj(); else hideAdj(); return; }
  if (act === 'photo') { closeDrawer(); hideAdj(); $('photoBtn').click(); return; }
  if (act === 'wide') { wideBtn.click(); return; }
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
  $('hudGo').classList.toggle('hidden', !!dispute);
  const cur = currentCand();
  $('hudMini').innerHTML = cur >= 0
    ? `★ ${cur + 1}/${candidates.length} · ${Math.round(candidates[cur].prob * 100)}% ▾`
    : `<span class="${o.scored ? 'ok' : 'fail'}">●</span> ${o.scored ? '득점' : '실패'}${prob === null ? '' : ` ${Math.round(prob * 100)}%`} ▾`;
  if (!candidates.length) return;
  const c = candidates[Math.max(0, cur)];
  const s = c.summary;
  const route = s?.firstHit ? ` · ${KO[s.firstHit]}${s.thickness !== undefined ? ` ${thickLabel(s.thickness)}` : ''} → ${s.cushions.map((w) => WALL_SHORT[w]).join('·')} → ${s.secondHit ? KO[s.secondHit] : '—'}` : '';
  $('hudRecTxt').innerHTML = cur >= 0
    ? `추천 ${cur + 1}/${candidates.length} · <span class="r-prob">${Math.round(c.prob * 100)}%</span>${route}`
    : `추천 ${candidates.length}개 · ◀▶로 보기`;
}
// 접은 상태: 작은 알약(★ 1/6 · 60% 또는 득점/실패 예상)만 표시 — 테이블을 가리지 않게
let hudFolded = (() => { try { return localStorage.getItem('miriq.hudFolded') === '1'; } catch { return false; } })();
function setHudFolded(v: boolean) {
  hudFolded = v;
  $('hud').classList.toggle('folded', v);
  try { localStorage.setItem('miriq.hudFolded', v ? '1' : '0'); } catch { /* 무시 */ }
  renderHud();
}
$('hudFold').addEventListener('click', () => setHudFolded(true));
$('hudMini').addEventListener('click', () => setHudFolded(false));
$('hud').classList.toggle('folded', hudFolded);

const stepCand = (d: number) => {
  if (!candidates.length) return;
  const cur = currentCand();
  applyCandidate(cur < 0 ? 0 : (cur + d + candidates.length) % candidates.length);
};
$('hudPrev').addEventListener('click', () => stepCand(-1));
$('hudNext').addEventListener('click', () => stepCand(1));

// ───────── 배치 입력 도구: 탭 배치 · 격자 맞춤 · 되돌리기 · 공유 링크 ─────────
let placeMode: BallId | null = null;
let placedSinceStart = false;
function setPlaceMode(id: BallId | null) {
  // 탭 배치를 마치거나 중간에 끄면 그때 한 번 추천 시작
  if (!id && placedSinceStart) { placedSinceStart = false; layoutChanged(); }
  placeMode = id;
  $('placeSel').querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('placing', b.dataset.v === id));
  $('placeHint').innerHTML = id
    ? `<b style="color:var(--warn)">${KO[id]}</b> 위치를 테이블에서 탭하세요`
    : '공을 고른 뒤 테이블을 탭하면 그 자리에 놓입니다 (흰공 → 노란공 → 빨간공 순서로 자동 진행)';
  if (id && sheetLayout()) closeDrawer(); // 공을 놓을 테이블이 보이도록 시트·서랍 접기
}
$('placeSel').querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => {
  setPlaceMode(placeMode === b.dataset.v ? null : (b.dataset.v as BallId));
}));
function snapPos(p: Pos): Pos {
  if (!($('snap') as HTMLInputElement).checked) return p;
  const g = DIAMOND / 4;
  return { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g };
}

// 배치 이력 (되돌리기/다시) + 주소에 배치 저장 (공유·새로고침 유지)
const layoutHist: string[] = [];
let histIdx = -1;
const snapshot = () => JSON.stringify({ layout, cue: shot.cue, firstBall: shot.opening ? null : shot.firstBall ?? null });
function saveHistory() {
  const snap = snapshot();
  if (layoutHist[histIdx] === snap) return;
  layoutHist.splice(histIdx + 1);
  layoutHist.push(snap);
  if (layoutHist.length > 60) layoutHist.shift();
  histIdx = layoutHist.length - 1;
  updateHistButtons();
  try { history.replaceState(null, '', `#l=${encodeLayout()}`); } catch { /* 무시 */ }
}
function restoreHistory(i: number) {
  if (i < 0 || i >= layoutHist.length) return;
  histIdx = i;
  const v = JSON.parse(layoutHist[i]);
  layout = v.layout; shot.cue = v.cue; shot.firstBall = v.firstBall ?? undefined;
  updateHistButtons();
  recompute();
  layoutChanged();
}
function updateHistButtons() {
  ($('undoBtn') as HTMLButtonElement).disabled = histIdx <= 0;
  ($('redoBtn') as HTMLButtonElement).disabled = histIdx >= layoutHist.length - 1;
}
$('undoBtn').addEventListener('click', () => { if (!dispute) restoreHistory(histIdx - 1); });
$('redoBtn').addEventListener('click', () => { if (!dispute) restoreHistory(histIdx + 1); });

function encodeLayout() {
  const n = BALL_IDS.flatMap((id) => [layout[id].x, layout[id].y]).map((v) => Math.round((v / DIAMOND) * 100));
  return [...n, shot.cue[0] + (shot.firstBall && !shot.opening ? shot.firstBall[0] : '')].join('.');
}
function loadFromHash() {
  const m = location.hash.match(/l=([\d.]+)\.([wy])([rwy]?)/);
  if (!m) return false;
  const n = m[1].split('.').map(Number);
  if (n.length !== 6 || n.some((v) => !Number.isFinite(v))) return false;
  BALL_IDS.forEach((id, i) => placeBall(id, { x: (n[i * 2] / 100) * DIAMOND, y: (n[i * 2 + 1] / 100) * DIAMOND }));
  shot.cue = m[2] === 'y' ? 'yellow' : 'white';
  const fb = ({ r: 'red', w: 'white', y: 'yellow' } as Record<string, BallId>)[m[3]];
  // 예전 링크(1적구 정보 없음)라도 초구 배치면 빨간공
  const isOpening = BALL_IDS.every((id) => Math.hypot(layout[id].x - PRESETS[0].layout[id].x, layout[id].y - PRESETS[0].layout[id].y) < 0.01);
  // 초구 배치의 빨간공은 규칙으로 정해지는 값 → 여기서는 지정하지 않고 updateOpening 이 처리 (초구 후 자동 해제)
  shot.firstBall = !isOpening && fb && fb !== shot.cue ? fb : undefined;
  return true;
}
// 초구 배치로 돌아가기 (공 위치 + 흰공 수구 → 초구 규칙 자동 적용)
$('openingBtn').addEventListener('click', () => {
  if (dispute) return;
  layout = clone(PRESETS[0].layout);
  shot.cue = 'white';
  runCount = 0;
  sysRes = null;
  recompute();
  layoutChanged();
  selectTab(0);
});
$('shareBtn').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}#l=${encodeLayout()}`;
  try {
    if (navigator.share) await navigator.share({ title: '미리Q 배치', url });
    else { await navigator.clipboard.writeText(url); $('placeHint').textContent = '배치 링크를 복사했습니다'; }
  } catch { /* 취소 */ }
});

// ───────── 친 결과 기록 (이 기기에 저장 · 추후 서버 동기화) ─────────
interface ShotRecord { ts: string; layout: Layout; shot: Shot; rank: number; level?: string; prob: number; result: 'scored' | 'missed'; skill: string }
const RECORDS_KEY = 'miriq.records';
const loadRecords = (): ShotRecord[] => { try { return JSON.parse(localStorage.getItem(RECORDS_KEY) || '[]'); } catch { return []; } };
function renderStats() {
  const recs = loadRecords();
  $('logBox').classList.toggle('hidden', currentCand() < 0 || !!dispute);
  if (!recs.length) { $('statsNote').textContent = ''; return; }
  const ok = recs.filter((r) => r.result === 'scored').length;
  const by = (lv: string) => { const a = recs.filter((r) => r.level === lv); return a.length ? ` · ${LEVEL_KO[lv as 'easy']} ${a.filter((r) => r.result === 'scored').length}/${a.length}` : ''; };
  $('statsNote').textContent = `내 기록: ${recs.length}회 중 ${ok}회 득점 (${Math.round((ok / recs.length) * 100)}%)${by('easy')}${by('normal')}${by('hard')}`;
}
function addRecord(res: 'scored' | 'missed') {
  const i = currentCand();
  const c = i >= 0 ? candidates[i] : null;
  const recs = loadRecords();
  recs.push({ ts: new Date().toISOString(), layout: clone(layout), shot: { ...shot }, rank: i, level: c?.diff?.level, prob: c?.prob ?? prob ?? 0, result: res, skill: prefs.skill });
  try { localStorage.setItem(RECORDS_KEY, JSON.stringify(recs.slice(-500))); } catch { /* 저장 불가 */ }
  renderStats();
}
$('logBox').querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => {
  if (currentCand() < 0) return;
  addRecord(b.dataset.r as 'scored' | 'missed');
  runCount = b.dataset.r === 'scored' ? runCount + 1 : 0;
  $('logMsg').textContent = b.dataset.r === 'scored' ? '기록했습니다 👏' : '기록했습니다';
  setTimeout(() => { $('logMsg').textContent = ''; }, 1500);
}));

// ───────── 샷 안내 카드: 어떻게 쳐야 하는지 자동으로 잠깐 보여주기 ─────────
function showGuide() {
  // 이의제기·재생 중이거나 조정 시트·결과 카드가 떠 있으면 겹치지 않게 생략
  if (dispute || anim || !result || !$('adj').classList.contains('hidden') || !$('afterShot').classList.contains('hidden')) return;
  const i = currentCand();
  const c = i >= 0 ? candidates[i] : null;
  const s = c?.summary ?? summarize(layout, shot); // 추천이 아니면 지금 샷을 바로 분석
  const h = howTo(shot, s);
  $('gTitle').textContent = c ? `추천 ${i + 1}/${candidates.length} · ${c.pat?.label ?? ''}` : '현재 샷';
  $('gLevel').innerHTML = c?.diff ? `<span class="lv lv-${c.diff.level}">${LEVEL_KO[c.diff.level]}</span>` : '';
  $('gAim').textContent = h.aim || `방향 ${shot.angleDeg.toFixed(1)}°`;
  $('gTipTxt').textContent = h.tip;
  const p = powerLevel(shot.speed);
  $('gPow').textContent = `${p}/5 ${POWER_KO[p]}`;
  $('gPowBar').innerHTML = [1, 2, 3, 4, 5].map((k) => `<i class="${k <= p ? 'on' : ''}"></i>`).join('');
  const tx = 32 + shot.tipX * 26, ty = 32 - shot.tipY * 26;
  $('gTip').innerHTML = `<circle cx="32" cy="32" r="28" fill="#e9e6dc"/><circle cx="32" cy="32" r="16.8" fill="none" stroke="rgba(0,0,0,.18)"/>
    <line x1="4" y1="32" x2="60" y2="32" stroke="rgba(0,0,0,.18)"/><line x1="32" y1="4" x2="32" y2="60" stroke="rgba(0,0,0,.18)"/>
    <circle cx="${tx}" cy="${ty}" r="5" fill="#1f6fd1" stroke="#fff" stroke-width="1.5"/>`;
  $('gRoute').innerHTML = s.firstHit
    ? `${KO[s.firstHit]} → ${s.cushions.map((w) => WALL_SHORT[w]).join('·') || '—'} → ${s.secondHit ? KO[s.secondHit] : '—'} ${result.outcome.scored ? '<b style="color:var(--ok)">득점</b>' : '<b style="color:var(--fail)">실패</b>'}${c ? ` · 성공 ${Math.round(c.prob * 100)}%` : ''}`
    : `<span style="color:var(--fail)">${result.outcome.reason}</span>`;
  if (c?.position !== undefined) $('gRoute').innerHTML += `<br><span class="note">후구: 득점 후 다음 샷 예상 성공 ${Math.round(c.position * 100)}%</span>`;
  $('gPos').textContent = BALL_IDS.map((id) => `${KO[id]} ${(layout[id].x / DIAMOND).toFixed(1)},${(layout[id].y / DIAMOND).toFixed(1)}`).join(' · ') + ' (포인트)';
  $('guide').classList.remove('hidden');
}
function hideGuide() { clearTimeout(guideTimer); $('guide').classList.add('hidden'); }
$('hudRecTxt').addEventListener('click', () => showGuide()); // 테이블 위 추천 표시를 누르면 다시 보기
let guideTimer = 0;
const guideSoon = () => { hideGuide(); guideTimer = window.setTimeout(showGuide, 0); };

// ───────── "이걸로 칠게요" → 안내 카드 → "치러 가기" → 결과 기록 대기 ─────────
function goShoot() {
  if (dispute) return;
  hideAdj(); hideAfterShot();
  if (isPortrait()) setSheet('min');
  else closeDrawer();
  showGuide();
}
$('hudGo').addEventListener('click', goShoot);
$('gBack').addEventListener('click', hideGuide);
// 치러 가기: 안내를 닫고, 치고 돌아와 바로 결과를 기록할 수 있게 작은 표시를 남김
// 치러 가는 동안: 테이블 위 배너(판정·추천 표시)는 잠시 접고, 결과 기록 표시만 남김 (설정은 바꾸지 않음)
function setShooting(on: boolean) {
  document.body.classList.toggle('shooting', on);
  $('hud').classList.toggle('folded', on || hudFolded);
  $('pendingRec').classList.toggle('hidden', !on);
}
$('gOk').addEventListener('click', () => { hideGuide(); setShooting(true); });
$('pendingRec').addEventListener('click', () => { setShooting(false); showAfterShot(); });

// ───────── 큰 화면 조정 시트: 방향(±·문지르기)·힘 ─────────
function syncAdj() {
  $('adjAngle').textContent = `${shot.angleDeg.toFixed(1)}°`;
  ($('adjSpeed') as HTMLInputElement).value = String(shot.speed);
  $('adjSpeedTxt').textContent = `${powerLevel(shot.speed)}/5`;
}
function showAdj() { hideGuide(); syncAdj(); $('adj').classList.remove('hidden'); }
function hideAdj() { $('adj').classList.add('hidden'); }
$('adjClose').addEventListener('click', hideAdj);
$('adj').querySelectorAll<HTMLButtonElement>('[data-da]').forEach((b) => b.addEventListener('click', () => {
  shot.angleDeg = norm(shot.angleDeg + parseFloat(b.dataset.da!)); sysRes = null; recompute(); syncAdj();
}));
$('adjSpeed').addEventListener('input', () => { shot.speed = parseFloat(($('adjSpeed') as HTMLInputElement).value); interacting = true; recompute(); syncAdj(); });
$('adjSpeed').addEventListener('change', () => { interacting = false; recompute(); });
bindJog($('adjJog'), $('adjJogTxt'), 0, '◀ 문질러서 미세 조정 ▶');

// ───────── 재생 후 "성공하셨나요?" → 기록 + 뒷공으로 이어가기 ─────────
let runCount = 0; // 이번에 이어서 친 연속 득점
function toast(msg: string, ms = 2600) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}
function showAfterShot() {
  if (dispute || !result) return;
  setShooting(false); // 결과를 묻는 순간 배너·버튼 원래대로
  const o = result.outcome;
  $('asTitle').textContent = '실제로 쳐 보셨나요? 결과는?';
  $('asRun').textContent = runCount ? `연속 득점 ${runCount}점` : '';
  $('asSub').textContent = o.scored
    ? '예상: 득점 — 득점했다면 시뮬레이션에서 공이 멈춘 자리로 뒷공을 이어서 추천해 드려요'
    : `예상: 실패 (${o.reason})`;
  $('asMain').classList.remove('hidden');
  $('asMissOpts').classList.add('hidden');
  $('afterShot').classList.remove('hidden');
}
const hideAfterShot = () => $('afterShot').classList.add('hidden');
// 시뮬레이션에서 공이 멈춘 자리 → 다음 배치 (수구는 그대로, 득점했으니 계속 침)
function loadNextLayout(cue: BallId) {
  const next = result.final;
  layout = clone(next);
  BALL_IDS.forEach((id) => placeBall(id, next[id]));
  shot.cue = cue;
  if (shot.firstBall === cue) shot.firstBall = undefined;
  sysRes = null;
  recompute();
  layoutChanged();
}
$('asClose').addEventListener('click', hideAfterShot);
$('afterShot').addEventListener('click', (ev) => {
  const a = (ev.target as HTMLElement).closest('button')?.dataset.a;
  if (!a) return;
  if (a === 'cont' || a === 'adjust') {
    addRecord('scored');
    runCount++;
    hideAfterShot();
    loadNextLayout(shot.cue);
    if (a === 'adjust') { selectTab(1); toast('예상 배치를 불러왔어요. 실제 위치와 다른 공을 끌어서 맞춰 주세요'); }
    else toast(`뒷공 배치로 이어갑니다 (연속 ${runCount}점) — 실제와 다르면 공을 끌어서 맞춰 주세요`);
  } else if (a === 'miss') {
    addRecord('missed');
    runCount = 0;
    $('asTitle').textContent = '기록했어요. 다음은?';
    $('asSub').textContent = '실제로 멈춘 위치는 시뮬레이션과 다를 수 있어요';
    $('asRun').textContent = '';
    $('asMain').classList.add('hidden');
    $('asMissOpts').classList.remove('hidden');
  } else if (a === 'opp') {
    // 상대 차례: 상대 수구로 바꾸고, 실제 멈춘 위치로 공을 맞추도록 배치 탭 열기
    hideAfterShot();
    loadNextLayout(shot.cue === 'white' ? 'yellow' : 'white');
    selectTab(1);
    toast('상대 차례예요. 실제로 멈춘 위치로 공을 맞춰 주세요 (사진 입력도 가능)');
  } else if (a === 'retry') {
    hideAfterShot();
  }
});

// ───────── 시작 ─────────
// ───────── 모바일 탭 ─────────
const tabBtns = [...document.querySelectorAll<HTMLButtonElement>('#tabs button')];
const sections = [...document.querySelectorAll<HTMLDetailsElement>('#panel details')];
const TAB_TITLES = ['★ 추천 샷', '배치', '샷 조정', '다이아몬드 시스템'];
let activeTab = 0;
function selectTab(i: number) {
  activeTab = i;
  $('drawerTitle').textContent = dispute && i === 2 ? '⚑ 이의제기' : TAB_TITLES[i];
  if (sheetLayout()) openDrawer();
  tabBtns.forEach((x) => x.classList.toggle('on', +x.dataset.tab! === i));
  sections.forEach((d, j) => { d.classList.toggle('active', j === i); if (j === i) d.open = true; });
  $('panel').scrollTop = 0;
}
tabBtns.forEach((b) => b.addEventListener('click', () => {
  const i = +b.dataset.tab!;
  if (document.body.classList.contains('portrait') && drawerOpen() && i === activeTab) { closeDrawer(); return; }
  selectTab(i);
}));

new ResizeObserver(resize).observe(stage);
// ───────── 큰 테이블(와이드) 모드 ─────────
// 세로로 든 휴대폰에서도 화면 전체를 90° 돌려 가로 당구대처럼 크게 표시. 실제로 가로로 돌리면 회전 없이 같은 배치
let wideMode = false;
const wideBtn = $('wideBtn');
function applyMode() {
  const rotated = wideMode && portraitMq.matches && mobileMq.matches;
  const wide = rotated || landscapeMq.matches;
  document.body.classList.toggle('rotated', rotated);
  document.body.classList.toggle('rotated-ccw', rotated && !!prefs.flip);
  document.body.classList.toggle('wide', wide);
  document.body.classList.toggle('portrait', !wide && mobileMq.matches && portraitMq.matches);
  if (!document.body.classList.contains('portrait')) { document.body.classList.remove('sheet-min'); sheetState = 'mid'; }
  wideBtn.setAttribute('aria-pressed', String(wideMode));
  wideBtn.textContent = wideMode ? '↩ 기본' : '⤢ 크게';
  wideBtn.hidden = !mobileMq.matches || (!portraitMq.matches && !wideMode);
  railBtn('exit').hidden = !wideMode;
  closeDrawer();
  lastBox = '';
  resize();
}
// 안드로이드 앱(미리Q) 안에서는 네이티브로 화면 방향을 바꾼다
const nativeApp = (window as unknown as { MiriQApp?: { setOrientation(mode: string): void } }).MiriQApp;
wideBtn.addEventListener('click', async () => {
  wideMode = !wideMode;
  prefs.bigMode = wideMode; savePrefs(); // 큰 화면 / 축소 선택 기억
  if (nativeApp) { nativeApp.setOrientation(wideMode ? 'landscape' : 'auto'); applyMode(); return; }
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
// 휴대폰은 큰 화면(가로)이 기본 — "축소"를 누른 적이 있으면 그 선택을 따름
wideMode = mobileMq.matches && prefs.bigMode !== false;
if (wideMode && nativeApp) nativeApp.setOrientation('landscape');
applyMode();
addEventListener('resize', resize);
// 사진으로 배치 입력 → 적용하면 바로 추천
initPhoto((l) => {
  if (dispute) return;
  BALL_IDS.forEach((id) => placeBall(id, l[id]));
  recompute();
  layoutChanged();
  selectTab(0);
  closeDrawer();
}, {
  // 앱(APK) 큰 화면에서는 촬영 화면 동안만 세로로, 닫으면 다시 가로로
  onOpen: () => { if (nativeApp && wideMode) nativeApp.setOrientation('portrait'); },
  onClose: () => { if (nativeApp && wideMode) nativeApp.setOrientation('landscape'); },
});

loadFromHash();
saveHistory();
recompute();
recommend();
renderQueueNote();
flushQueue();

// 개발 서버에서만: 상태 확인용
if (import.meta.env.DEV) (window as unknown as { __state: () => unknown }).__state = () => ({ layout, shot, candidates });
