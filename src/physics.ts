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
}

export interface SimOptions {
  dt?: number;
  maxTime?: number;
  record?: boolean;
  stopWhenDecided?: boolean;
  only?: BallId[]; // 이 공들만 테이블에 올림 (시스템 보정용)
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
  const e = Math.max(0.7, 0.92 - 0.03 * vn);
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
  let cushionCount = 0, cushionsBeforeSecond = 0, kiss = false;
  const cueCushions: Wall[] = [];

  const onBallContact = (a: Ball, b: Ball, t: number, speed: number) => {
    events.push({ t, type: 'ball', ball: a.id, other: b.id, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, speed });
    const isCueA = a.id === shot.cue, isCueB = b.id === shot.cue;
    if (!isCueA && !isCueB) { kiss = true; return; }
    const obj = isCueA ? b.id : a.id;
    if (!firstHit) firstHit = obj;
    else if (!secondHit && obj !== firstHit) { secondHit = obj; cushionsBeforeSecond = cushionCount; }
  };

  let t = 0;
  let lastRec = 0, lastFrame = 0;
  const frameDt = 1 / 120;
  const pathDt = 0.004;
  const lo = R, hiX = TABLE.L - R, hiY = TABLE.W - R;
  while (t < maxTime) {
    let moving = false;
    for (const b of balls) if (isMoving(b)) { integrate(b, dt); moving = true; }
    t += dt;
    for (const b of balls) {
      const hits: [Wall, number, number, boolean][] = [
        ['left', 1, 0, b.x < lo], ['right', -1, 0, b.x > hiX], ['bottom', 0, 1, b.y < lo], ['top', 0, -1, b.y > hiY],
      ];
      for (const [wall, nx, ny, pen] of hits) {
        if (!pen) continue;
        const speed = cushionImpulse(b, nx, ny);
        b.x = Math.min(hiX, Math.max(lo, b.x));
        b.y = Math.min(hiY, Math.max(lo, b.y));
        if (speed > 0) {
          events.push({ t, type: 'cushion', ball: b.id, wall, x: b.x, y: b.y, speed });
          if (b.id === shot.cue && !secondHit) { cushionCount++; cueCushions.push(wall); }
          if (record) pushPath(b);
        }
      }
    }
    for (let i = 0; i < balls.length; i++) for (let j = i + 1; j < balls.length; j++) {
      const a = balls[i], b = balls[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      if (d >= 2 * R || d === 0) continue;
      const nx = dx / d, ny = dy / d;
      const speed = ballImpulse(a, b, nx, ny);
      const push = (2 * R - d) / 2;
      a.x -= nx * push; a.y -= ny * push; b.x += nx * push; b.y += ny * push;
      if (speed > 0) {
        if (record) { pushPath(a); pushPath(b); }
        onBallContact(a, b, t, speed);
      }
    }
    if (record) {
      if (t - lastRec >= pathDt) { lastRec = t; balls.forEach((b) => isMoving(b) && pushPath(b)); }
      if (t - lastFrame >= frameDt) { lastFrame = t; pushFrame(t); }
    }
    if (!moving) break;
    if (opt.stopWhenDecided && (secondHit || !isMoving(cue))) break;
  }
  if (record) { balls.forEach(pushPath); pushFrame(t); }

  const scored = !!secondHit && cushionsBeforeSecond >= 3;
  let reason: string;
  if (!firstHit) reason = '수구가 적구를 하나도 맞히지 못했습니다';
  else if (!secondHit) reason = `1적구(${KO[firstHit]})만 맞고 2적구를 맞히지 못했습니다 (쿠션 ${cushionCount}회)`;
  else if (!scored) reason = `2적구 전에 쿠션 ${cushionsBeforeSecond}회 — 3쿠션 미달`;
  else reason = `1적구 ${KO[firstHit]} → 쿠션 ${cushionsBeforeSecond}회 → 2적구 ${KO[secondHit]} 득점`;
  return {
    paths, frames, events, duration: t,
    outcome: { scored, firstHit, secondHit, cushionsBeforeSecond: secondHit ? cushionsBeforeSecond : cushionCount, cueCushions, kiss, reason },
  };
}

export const KO: Record<BallId, string> = { white: '흰공', yellow: '노란공', red: '빨간공' };

// 득점 여부만 빠르게 계산 (탐색용)
export function quickScore(layout: Layout, shot: Shot): boolean {
  return simulate(layout, shot, { dt: 0.001, maxTime: 14, record: false, stopWhenDecided: true }).outcome.scored;
}

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

// 실제 스트로크 오차(방향 ±0.35°, 힘 ±5%, 당점 ±0.05R)를 가정한 성공 확률
export function robustness(layout: Layout, shot: Shot, n = 40): number {
  const r = rng(12345);
  let ok = 0;
  for (let i = 0; i < n; i++) {
    const s: Shot = {
      ...shot,
      angleDeg: shot.angleDeg + gauss(r) * 0.35,
      speed: shot.speed * (1 + gauss(r) * 0.05),
      tipX: shot.tipX + gauss(r) * 0.05,
      tipY: shot.tipY + gauss(r) * 0.05,
    };
    if (quickScore(layout, s)) ok++;
  }
  return ok / n;
}
