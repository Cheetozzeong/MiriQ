// 다이아몬드 시스템: 거울 반사(언폴딩) 기하 계산 + 파이브앤하프 환산 + 물리 보정
import { BALL, DIAMOND, TABLE, simulate, type Layout, type Pos, type Shot, type Wall } from './physics';

const R = BALL.R;
const LINE: Record<Wall, number> = { left: R, right: TABLE.L - R, bottom: R, top: TABLE.W - R };
export const isLong = (w: Wall) => w === 'top' || w === 'bottom';

function reflect(p: Pos, w: Wall): Pos {
  return isLong(w) ? { x: p.x, y: 2 * LINE[w] - p.y } : { x: 2 * LINE[w] - p.x, y: p.y };
}

// 레일 위 다이아몬드 위치(장쿠션 0~8, 단쿠션 0~4) → 공 중심 좌표
export function railPoint(w: Wall, diamonds: number): Pos {
  return isLong(w)
    ? { x: Math.min(TABLE.L - R, Math.max(R, diamonds * DIAMOND)), y: LINE[w] }
    : { x: LINE[w], y: Math.min(TABLE.W - R, Math.max(R, diamonds * DIAMOND)) };
}
export const railCoord = (w: Wall, p: Pos) => (isLong(w) ? p.x : p.y) / DIAMOND;

// 반사 직선 추적 (마찰·회전 없는 이상적 경로)
export function traceGeometric(start: Pos, angleDeg: number, bounces = 4): { pts: Pos[]; walls: Wall[] } {
  let x = start.x, y = start.y;
  let dx = Math.cos((angleDeg * Math.PI) / 180), dy = Math.sin((angleDeg * Math.PI) / 180);
  const pts: Pos[] = [{ x, y }];
  const walls: Wall[] = [];
  for (let i = 0; i < bounces; i++) {
    const cands: [number, Wall][] = [];
    if (dx > 1e-9) cands.push([(LINE.right - x) / dx, 'right']);
    if (dx < -1e-9) cands.push([(LINE.left - x) / dx, 'left']);
    if (dy > 1e-9) cands.push([(LINE.top - y) / dy, 'top']);
    if (dy < -1e-9) cands.push([(LINE.bottom - y) / dy, 'bottom']);
    cands.sort((a, b) => a[0] - b[0]);
    const [tt, w] = cands[0];
    x += dx * tt; y += dy * tt;
    pts.push({ x, y });
    walls.push(w);
    if (isLong(w)) dy = -dy; else dx = -dx;
  }
  return { pts, walls };
}

export interface SystemResult {
  ok: boolean;
  message: string;
  angleDeg?: number;
  geo?: { pts: Pos[]; walls: Wall[] };
  aimDiamond?: number;
  fiveHalf?: { cue: number; aim: number; arrival: number };
}

const corner = (a: Wall, b: Wall) => ({
  x: a === 'left' || b === 'left' ? 0 : a === 'right' || b === 'right' ? TABLE.L : NaN,
  y: a === 'bottom' || b === 'bottom' ? 0 : a === 'top' || b === 'top' ? TABLE.W : NaN,
});
// 코너에서 레일을 따라 잰 다이아몬드 수
const fromCorner = (w: Wall, p: Pos, c: { x: number; y: number }) =>
  isLong(w) ? Math.abs(p.x - c.x) / DIAMOND : Math.abs(p.y - c.y) / DIAMOND;

export function solveSystem(cue: Pos, seq: [Wall, Wall, Wall], arrivalDiamond: number): SystemResult {
  const [c1, c2, c3] = seq;
  if (c1 === c2 || c2 === c3) return { ok: false, message: '연속으로 같은 쿠션은 선택할 수 없습니다' };
  const target = railPoint(c3, arrivalDiamond);
  const img = reflect(reflect(target, c2), c1);
  const angleDeg = (Math.atan2(img.y - cue.y, img.x - cue.x) * 180) / Math.PI;
  const geo = traceGeometric(cue, angleDeg, 3);
  if (geo.walls.join() !== seq.join())
    return { ok: false, message: `이 배치에서는 ${seq.join('→')} 경로가 기하적으로 불가능합니다`, geo, angleDeg };
  const aimDiamond = railCoord(c1, geo.pts[1]);
  let fiveHalf: SystemResult['fiveHalf'];
  if (isLong(c1) && isLong(c3) && !isLong(c2) && c1 !== c3) {
    const aim = 10 * fromCorner(c1, geo.pts[1], corner(c1, c2));
    const arrival = 10 + 5 * fromCorner(c3, geo.pts[3], corner(c2, c3));
    fiveHalf = { cue: aim + arrival, aim, arrival };
  }
  return { ok: true, message: '기하 계산 완료', angleDeg, geo, aimDiamond, fiveHalf };
}

// 물리 보정: 실제 힘/당점으로 쳤을 때 3쿠션 도착점이 목표와 같아지는 각도 탐색
export function calibrate(layout: Layout, shot: Shot, seq: [Wall, Wall, Wall], arrivalDiamond: number, startAngle: number) {
  const target = railCoord(seq[2], railPoint(seq[2], arrivalDiamond));
  const err = (a: number): number => {
    const r = simulate(layout, { ...shot, angleDeg: a }, { dt: 0.001, maxTime: 10, record: false, only: [shot.cue] });
    const cs = r.events.filter((e) => e.type === 'cushion').slice(0, 3);
    if (cs.length < 3 || cs.some((e, i) => e.wall !== seq[i])) return NaN;
    return railCoord(seq[2], cs[2]) - target;
  };
  let best = { a: startAngle, e: Infinity };
  for (let d = -10; d <= 10; d += 0.1) {
    const e = err(startAngle + d);
    if (!Number.isNaN(e) && Math.abs(e) < Math.abs(best.e)) best = { a: startAngle + d, e };
  }
  if (!Number.isFinite(best.e)) return { ok: false as const };
  for (let step = 0.05; step > 0.002; step /= 2) {
    for (const a of [best.a - step, best.a + step]) {
      const e = err(a);
      if (!Number.isNaN(e) && Math.abs(e) < Math.abs(best.e)) best = { a, e };
    }
  }
  return { ok: true as const, angleDeg: best.a, errorDiamond: best.e };
}
