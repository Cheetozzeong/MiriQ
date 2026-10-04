// 3쿠션(캐롬) 물리 엔진
// 좌표계: 미터 단위, 원점 = 플레이 면 왼쪽 아래, x = 장축(0..L), y = 단축(0..W), z = 위쪽
// 공 상태: 위치, 속도(2D), 각속도(3D). 미끄럼/구름/회전 마찰, 공-공 충돌(스로우 포함), 쿠션 반발(회전 영향 포함)

export const TABLE = { L: 2.84, W: 1.42 };
export const DIAMOND = TABLE.L / 8; // 0.355m
export const BALL = { R: 0.03075, m: 0.21 };

export const PHYS = {
  g: 9.81,
  muSlide: 0.2, // 천-공 미끄럼 마찰
  muRoll: 0.011, // 구름 저항
  muSpin: 0.03, // 수직축 회전(좌우 회전) 감쇠
  eBall: 0.94, // 공-공 반발계수
  muBall: 0.055, // 공-공 마찰 (스로우)
  muCushion: 0.17, // 쿠션 마찰
  cushionH: 0.037, // 쿠션 접촉 높이
  squirt: 0.02, // 당점 좌우에 의한 큐볼 이탈각(rad / R)
  cushionEAdj: 0, // 테이블 상태에 따른 쿠션 반발 보정
};

export type BallId = 'white' | 'yellow' | 'red';
export const BALL_IDS: BallId[] = ['white', 'yellow', 'red'];
export type Wall = 'left' | 'right' | 'top' | 'bottom';
export const WALL_KO: Record<Wall, string> = { left: '좌측 단쿠션', right: '우측 단쿠션', top: '상단 장쿠션', bottom: '하단 장쿠션' };

export interface Pos { x: number; y: number }
export type Layout = Record<BallId, Pos>;

export interface Shot {
  cue: BallId;
  angleDeg: number; // 테이블 좌표계 기준 각도 (x축 +방향 = 0°, 반시계 +)
  speed: number; // 큐볼 초속 m/s
  tipX: number; // 좌우 당점 (R 단위, 오른쪽 +)
  tipY: number; // 상하 당점 (R 단위, 위 +)
  firstBall?: BallId; // 1적구 지정. 없으면 어느 공이든 먼저 맞혀도 됨
  opening?: boolean; // 초구 규칙: 빨간공을 쿠션 없이 직접 먼저 맞혀야 함 (아니면 파울)
}

interface Ball { id: BallId; x: number; y: number; vx: number; vy: number; wx: number; wy: number; wz: number; on: boolean }

export interface SimEvent {
  t: number;
  type: 'cushion' | 'ball';
  ball: BallId;
  other?: BallId;
  wall?: Wall;
  x: number;
  y: number;
  speed: number;
  counted?: boolean; // 수구 쿠션: 3쿠션 규칙상 쿠션 1회로 인정했는지
}

export interface Outcome {
  scored: boolean;
  firstHit?: BallId;
  secondHit?: BallId;
  cushionsBeforeSecond: number;
  cueCushions: Wall[]; // 2적구 전까지(또는 정지까지) 수구가 맞은 쿠션 순서
  kiss: boolean; // 적구끼리 충돌(키스) 발생
  reason: string;
}

export interface Frame { t: number; p: number[] } // [wx, wy, yx, yy, rx, ry]

export interface SimResult {
  paths: Record<BallId, Pos[]>;
  frames: Frame[];
  events: SimEvent[];
  outcome: Outcome;
  duration: number;
  nearMiss: number;
}

export interface SimOptions {
  dt?: number;
  maxTime?: number;
  record?: boolean;
  stopWhenDecided?: boolean;
  only?: BallId[]; // 이 공들만 테이블에 올림 (시스템 보정용)
  prune?: boolean; // 에너지 부족으로 실패가 확정되면 조기 종료 (탐색용)
}

const R = BALL.R;
const I = 0.4 * BALL.m * R * R;
const m = BALL.m;

function strike(b: Ball, shot: Shot) {
  const ang = (shot.angleDeg * Math.PI) / 180 + PHYS.squirt * shot.tipX;
  const dx = Math.cos(ang), dy = Math.sin(ang);
  const v = shot.speed;
  b.vx = v * dx;
  b.vy = v * dy;
  // 상하 당점 → 진행 방향 수평축 회전 (tipY=0.4 이면 자연 구름)
  const k = (2.5 * v) / R;
  b.wx = k * shot.tipY * -dy;
  b.wy = k * shot.tipY * dx;
  // 좌우 당점 → 수직축 회전 (오른쪽 당점 = 반시계, wz > 0)
  b.wz = k * shot.tipX;
}

function isMoving(b: Ball) {
  if (Math.abs(b.vx) > 1e-4 || Math.abs(b.vy) > 1e-4) return true;
  return Math.abs(b.wx) * R > 1e-4 || Math.abs(b.wy) * R > 1e-4;
}

function integrate(b: Ball, dt: number) {
  const g = PHYS.g;
  const ux = b.vx - R * b.wy;
  const uy = b.vy + R * b.wx;
  const us = Math.hypot(ux, uy);
  if (us > 1e-4) {
    // 미끄럼: 접점 미끄럼 반대 방향 마찰. 미끄럼 속도는 3.5·μg 로 감소
    const f = Math.min(1, us / (3.5 * PHYS.muSlide * g * dt));
    const ax = (-PHYS.muSlide * g * ux) / us * f;
    const ay = (-PHYS.muSlide * g * uy) / us * f;
    b.vx += ax * dt;
    b.vy += ay * dt;
    b.wx += (2.5 / R) * ay * dt;
    b.wy += (-2.5 / R) * ax * dt;
  } else {
    const s = Math.hypot(b.vx, b.vy);
    if (s > 0) {
      const ns = Math.max(0, s - PHYS.muRoll * g * dt);
      b.vx *= ns / s;
      b.vy *= ns / s;
    }
    b.wx = -b.vy / R;
    b.wy = b.vx / R;
  }
  const dwz = ((2.5 * PHYS.muSpin * g) / R) * dt;
  b.wz = Math.abs(b.wz) <= dwz ? 0 : b.wz - Math.sign(b.wz) * dwz;
  b.x += b.vx * dt;
  b.y += b.vy * dt;
}

const SIN_T = (PHYS.cushionH - R) / R;
const COS_T = Math.sqrt(1 - SIN_T * SIN_T);

// n: 쿠션에서 테이블 안쪽을 향하는 법선
function cushionImpulse(b: Ball, nx: number, ny: number) {
  const vn = -(b.vx * nx + b.vy * ny);
  if (vn <= 0) return 0;
  const e = Math.max(0.65, Math.min(0.95, 0.92 + PHYS.cushionEAdj - 0.03 * vn));
  const Jn = (1 + e) * m * vn;
  const rx = -nx * R * COS_T, ry = -ny * R * COS_T, rz = R * SIN_T;
  // 접점 속도 = v + w × r
  const cvx = b.vx + (b.wy * rz - b.wz * ry);
  const cvy = b.vy + (b.wz * rx - b.wx * rz);
  const tx = -ny, ty = nx;
  const ut = cvx * tx + cvy * ty;
  const Jt = -Math.sign(ut) * Math.min(PHYS.muCushion * Jn, (m * Math.abs(ut)) / 3.5);
  const Fx = Jn * nx + Jt * tx, Fy = Jn * ny + Jt * ty;
  b.vx += Fx / m;
  b.vy += Fy / m;
  b.wx += (-rz * Fy) / I;
  b.wy += (rz * Fx) / I;
  b.wz += (rx * Fy - ry * Fx) / I;
  return vn;
}

function ballImpulse(a: Ball, b: Ball, nx: number, ny: number) {
  const vrel = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
  if (vrel <= 0) return 0;
  const Jn = 0.5 * (1 + PHYS.eBall) * m * vrel;
  const cax = a.vx - a.wz * R * ny, cay = a.vy + a.wz * R * nx;
  const cbx = b.vx + b.wz * R * ny, cby = b.vy - b.wz * R * nx;
  const tx = -ny, ty = nx;
  const ut = (cax - cbx) * tx + (cay - cby) * ty;
  const Jt = -Math.sign(ut) * Math.min(PHYS.muBall * Jn, (m * Math.abs(ut)) / 7);
  const Px = -Jn * nx + Jt * tx, Py = -Jn * ny + Jt * ty;
  a.vx += Px / m; a.vy += Py / m;
  b.vx -= Px / m; b.vy -= Py / m;
  const dwz = (R * (nx * Py - ny * Px)) / I;
  a.wz += dwz;
  b.wz += dwz;
  return vrel;
}

export function simulate(layout: Layout, shot: Shot, opt: SimOptions = {}): SimResult {
  const dt = opt.dt ?? 0.0005;
  const maxTime = opt.maxTime ?? 25;
  const record = opt.record ?? true;
  const balls: Ball[] = BALL_IDS.map((id) => ({
    id, x: layout[id].x, y: layout[id].y, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0,
    on: !opt.only || opt.only.includes(id),
  })).filter((b) => b.on);
  const cue = balls.find((b) => b.id === shot.cue)!;
  strike(cue, shot);

  const events: SimEvent[] = [];
  const paths = { white: [], yellow: [], red: [] } as Record<BallId, Pos[]>;
  const frames: Frame[] = [];
  const pushFrame = (t: number) => {
    const p: number[] = [];
    for (const id of BALL_IDS) {
      const b = balls.find((x) => x.id === id);
      p.push(b ? b.x : layout[id].x, b ? b.y : layout[id].y);
    }
    frames.push({ t, p });
  };
  const pushPath = (b: Ball) => paths[b.id].push({ x: b.x, y: b.y });
  if (record) { balls.forEach(pushPath); pushFrame(0); }

  // 득점 판정 상태
  let firstHit: BallId | undefined, secondHit: BallId | undefined;
  let cushionCount = 0, cushionsBeforeSecond = 0, cushionsBeforeFirst = 0, kiss = false;
  let nearMiss = Infinity; // 3쿠션 이후 수구와 2적구의 최소 간격(공 표면 기준) — 탐색 시 "아깝게 빗나감" 판단용
  const cueCushions: Wall[] = [];

  const onBallContact = (a: Ball, b: Ball, t: number, speed: number) => {
    events.push({ t, type: 'ball', ball: a.id, other: b.id, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, speed });
    const isCueA = a.id === shot.cue, isCueB = b.id === shot.cue;
    if (!isCueA && !isCueB) { kiss = true; return; }
    const obj = isCueA ? b.id : a.id;
    lastCueBall = { id: obj, t };
    if (!firstHit) { firstHit = obj; cushionsBeforeFirst = cushionCount; }
    else if (!secondHit && obj !== firstHit) { secondHit = obj; cushionsBeforeSecond = cushionCount; }
  };
  // 3쿠션 규칙상 쿠션 1회로 인정할지:
  //  - 아주 약한 스침(초속 3cm 미만) 제외
  //  - 같은 쿠션을 0.12초 안에 다시 닿음(레일 타기) → 한 번으로
  //  - 공과 부딪친 직후(10ms 이내, 그 공과 2cm 이내)에 생긴 쿠션 접촉 제외 — 1적구를 맞힌 것과 구분이 안 되는 동시 접촉
  let lastCueBall: { id: BallId; t: number } | null = null;
  let lastCueCushion: { wall: Wall; t: number } | null = null;
  const countsAsCushion = (b: Ball, wall: Wall, t: number, speed: number) => {
    if (speed < 0.03) return false;
    if (lastCueCushion && lastCueCushion.wall === wall && t - lastCueCushion.t < 0.12) return false;
    if (lastCueBall && t - lastCueBall.t < 0.01) {
      const o = balls.find((x) => x.id === lastCueBall!.id)!;
      if (Math.hypot(o.x - b.x, o.y - b.y) < 2 * R + 0.02) return false;
    }
    return true;
  };
  // 한 계산 구간 안에서 일어난 접촉들을 실제 시각 순으로 처리 (쿠션과 2적구 접촉 순서가 뒤바뀌지 않게)
  type StepEv = { time: number; kind: 'cushion'; b: Ball; wall: Wall; speed: number } | { time: number; kind: 'ball'; a: Ball; b: Ball; speed: number };
  const stepEvents: StepEv[] = [];

  let t = 0;
  let lastRec = 0, lastFrame = 0;
  const frameDt = 1 / 120;
  const pathDt = 0.004;
  const lo = R, hiX = TABLE.L - R, hiY = TABLE.W - R;
  const WALLS: [Wall, number, number][] = [['left', 1, 0], ['right', -1, 0], ['bottom', 0, 1], ['top', 0, -1]];
  while (t < maxTime) {
    let moving = false;
    for (const b of balls) if (isMoving(b)) { integrate(b, dt); moving = true; }
    t += dt;
    for (const b of balls) {
      for (const [wall, nx, ny] of WALLS) {
        const pen = nx ? (nx > 0 ? lo - b.x : b.x - hiX) : (ny > 0 ? lo - b.y : b.y - hiY);
        if (pen <= 0) continue;
        // 충돌 순간으로 되돌려 반발 처리 후 남은 시간만큼 진행 (큰 dt 에서도 반사각 정확)
        const vin = -(b.vx * nx + b.vy * ny);
        const tau = vin > 0 ? Math.min(dt, pen / vin) : 0;
        b.x -= b.vx * tau; b.y -= b.vy * tau;
        const speed = cushionImpulse(b, nx, ny);
        b.x += b.vx * tau; b.y += b.vy * tau;
        b.x = Math.min(hiX, Math.max(lo, b.x));
        b.y = Math.min(hiY, Math.max(lo, b.y));
        if (speed > 0) {
          stepEvents.push({ time: t - tau, kind: 'cushion', b, wall, speed });
          if (record) pushPath(b);
        }
      }
    }
    for (let i = 0; i < balls.length; i++) for (let j = i + 1; j < balls.length; j++) {
      const a = balls[i], b = balls[j];
      let dx = b.x - a.x, dy = b.y - a.y;
      let d = Math.hypot(dx, dy);
      if (d >= 2 * R || d === 0) continue;
      // 접촉 순간(중심 거리 = 2R)까지 되돌림
      const ux = b.vx - a.vx, uy = b.vy - a.vy;
      const uu = ux * ux + uy * uy;
      let tau = 0;
      if (uu > 1e-12) {
        const du = dx * ux + dy * uy;
        const disc = du * du - uu * (d * d - 4 * R * R);
        tau = Math.min(dt, Math.max(0, (du + Math.sqrt(Math.max(0, disc))) / uu));
      }
      a.x -= a.vx * tau; a.y -= a.vy * tau; b.x -= b.vx * tau; b.y -= b.vy * tau;
      dx = b.x - a.x; dy = b.y - a.y; d = Math.hypot(dx, dy) || 1e-9;
      const nx = dx / d, ny = dy / d;
      const speed = ballImpulse(a, b, nx, ny);
      a.x += a.vx * tau; a.y += a.vy * tau; b.x += b.vx * tau; b.y += b.vy * tau;
      dx = b.x - a.x; dy = b.y - a.y; d = Math.hypot(dx, dy);
      if (d < 2 * R) {
        const push = (2 * R - d) / 2;
        a.x -= nx * push; a.y -= ny * push; b.x += nx * push; b.y += ny * push;
      }
      if (speed > 0) {
        if (record) { pushPath(a); pushPath(b); }
        stepEvents.push({ time: t - tau, kind: 'ball', a, b, speed });
      }
    }
    if (stepEvents.length) {
      stepEvents.sort((p, q) => p.time - q.time);
      for (const e of stepEvents) {
        if (e.kind === 'ball') { onBallContact(e.a, e.b, e.time, e.speed); continue; }
        const isCue = e.b.id === shot.cue;
        const counted = isCue && !secondHit && countsAsCushion(e.b, e.wall, e.time, e.speed);
        events.push({ t: e.time, type: 'cushion', ball: e.b.id, wall: e.wall, x: e.b.x, y: e.b.y, speed: e.speed, counted: isCue && !secondHit ? counted : undefined });
        if (counted) { cushionCount++; cueCushions.push(e.wall); }
        if (isCue) lastCueCushion = { wall: e.wall, t: e.time }; // 레일을 타는 동안엔 계속 갱신 → 한 번으로 묶임
      }
      stepEvents.length = 0;
    }
    if (firstHit && !secondHit && cushionCount >= 3) {
      for (const o of balls) if (o !== cue && o.id !== firstHit) nearMiss = Math.min(nearMiss, Math.hypot(o.x - cue.x, o.y - cue.y) - 2 * R);
    }
    if (record) {
      if (t - lastRec >= pathDt) { lastRec = t; balls.forEach((b) => isMoving(b) && pushPath(b)); }
      if (t - lastFrame >= frameDt) { lastFrame = t; pushFrame(t); }
    }
    if (!moving) break;
    if (opt.stopWhenDecided) {
      if (secondHit || !isMoving(cue)) break;
      if (shot.firstBall && firstHit && firstHit !== shot.firstBall) break; // 지정한 1적구가 아닌 공을 먼저 맞힘 → 실패 확정
      if (shot.opening && !firstHit && cushionCount > 0) break; // 초구에서 쿠션을 먼저 맞힘 → 파울 확정
      // 가지치기: 남은 운동 에너지로 갈 수 있는 최대 거리 < 아직 맞혀야 할 (정지한) 공까지 직선거리 → 실패 확정
      if (opt.prune && (t * 1000) % 20 < dt * 1000) {
        const targets = balls.filter((o) => o !== cue && (firstHit ? o.id !== firstHit : true));
        if (targets.every((o) => !isMoving(o))) {
          const w2 = cue.wx * cue.wx + cue.wy * cue.wy + cue.wz * cue.wz;
          const reach = (0.5 * (cue.vx * cue.vx + cue.vy * cue.vy) + 0.2 * R * R * w2) / (PHYS.muRoll * PHYS.g);
          const need = Math.min(...targets.map((o) => Math.hypot(o.x - cue.x, o.y - cue.y))) - 2 * R;
          if (reach < need) break;
        }
      }
    }
  }
  if (record) { balls.forEach(pushPath); pushFrame(t); }

  const wrongFirst = !!shot.firstBall && !!firstHit && firstHit !== shot.firstBall;
  // 초구 파울: 빨간공이 아닌 공을 먼저 맞히거나, 쿠션을 먼저 맞힘(빈쿠션)
  const openingFoul = !!shot.opening && (firstHit ? firstHit !== 'red' || cushionsBeforeFirst > 0 : cushionCount > 0);
  const scored = !!secondHit && cushionsBeforeSecond >= 3 && !wrongFirst && !openingFoul;
  let reason: string;
  if (openingFoul) reason = '초구 파울 — 초구는 빨간공을 쿠션 없이 직접 먼저 맞혀야 합니다';
  else if (!firstHit) reason = '수구가 적구를 하나도 맞히지 못했습니다';
  else if (wrongFirst) reason = `1적구는 ${KO[shot.firstBall!]}이어야 하는데 ${KO[firstHit]}을(를) 먼저 맞혔습니다`;
  else if (!secondHit) reason = `1적구(${KO[firstHit]})만 맞고 2적구를 맞히지 못했습니다 (쿠션 ${cushionCount}회)`;
  else if (!scored) reason = `2적구 전에 쿠션 ${cushionsBeforeSecond}회 — 3쿠션 미달`;
  else reason = `1적구 ${KO[firstHit]} → 쿠션 ${cushionsBeforeSecond}회 → 2적구 ${KO[secondHit]} 득점`;
  return {
    paths, frames, events, duration: t, nearMiss,
    outcome: { scored, firstHit, secondHit, cushionsBeforeSecond: secondHit ? cushionsBeforeSecond : cushionCount, cueCushions, kiss, reason },
  };
}

export const KO: Record<BallId, string> = { white: '흰공', yellow: '노란공', red: '빨간공' };

// 탐색용 빠른 시뮬레이션 (충돌 시점 보정 덕분에 큰 dt 사용 가능)
export const QUICK_DT = 0.0015;
// 0 = 빗나감, 1 = 아깝게 빗나감(3쿠션 후 2적구와 6cm 이내), 2 = 득점
export function scanShot(layout: Layout, shot: Shot): 0 | 1 | 2 {
  const r = simulate(layout, shot, { dt: QUICK_DT, maxTime: 14, record: false, stopWhenDecided: true, prune: true });
  if (r.outcome.scored) return 2;
  return r.nearMiss < 0.06 ? 1 : 0;
}
export const quickScore = (layout: Layout, shot: Shot) => scanShot(layout, shot) === 2;

// 결정적 의사난수 (성공률 계산 재현성 위해)
export function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}
function gauss(r: () => number) {
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
}

// 실력 단계별 스트로크 오차 (표준편차): 방향(°), 힘(비율), 당점(R 단위)
export interface ErrorModel { angle: number; speed: number; tip: number }
export type Skill = 'beginner' | 'intermediate' | 'advanced';
export const SKILL: Record<Skill, ErrorModel & { label: string; desc: string }> = {
  beginner: { angle: 0.9, speed: 0.12, tip: 0.1, label: '입문', desc: '에버리지 ~0.3' },
  intermediate: { angle: 0.55, speed: 0.08, tip: 0.07, label: '중급', desc: '에버리지 0.3~0.7' },
  advanced: { angle: 0.35, speed: 0.05, tip: 0.05, label: '상급', desc: '에버리지 0.7 이상' },
};

// 오차를 반영한 성공 확률 (n회 무작위 시뮬레이션)
export function robustness(layout: Layout, shot: Shot, n = 40, err: ErrorModel = SKILL.intermediate): number {
  const r = rng(12345);
  let ok = 0;
  for (let i = 0; i < n; i++) {
    const s: Shot = {
      ...shot,
      angleDeg: shot.angleDeg + gauss(r) * err.angle,
      speed: shot.speed * (1 + gauss(r) * err.speed),
      tipX: shot.tipX + gauss(r) * err.tip,
      tipY: shot.tipY + gauss(r) * err.tip,
    };
    if (quickScore(layout, s)) ok++;
  }
  return ok / n;
}

// 테이블 상태 (천·쿠션 상태에 따라 구름 저항과 쿠션 반발 조정)
export type TableSpeed = 'slow' | 'normal' | 'fast';
const BASE = { muRoll: PHYS.muRoll, cushionE: 0 };
export const TABLE_SPEED: Record<TableSpeed, { label: string; muRoll: number; cushionE: number }> = {
  slow: { label: '느림', muRoll: BASE.muRoll * 1.25, cushionE: -0.04 },
  normal: { label: '보통', muRoll: BASE.muRoll, cushionE: 0 },
  fast: { label: '빠름', muRoll: BASE.muRoll * 0.8, cushionE: 0.03 },
};
export function setTableSpeed(ts: TableSpeed) {
  PHYS.muRoll = TABLE_SPEED[ts].muRoll;
  PHYS.cushionEAdj = TABLE_SPEED[ts].cushionE;
}
