// 샷 분석: 경로 요약 → 난이도 점수, 경로 형태, 실전 표기(두께·당점 시계·힘 단계·겨냥점)
import { BALL, DIAMOND, TABLE, simulate, type BallId, type Layout, type Shot, type Wall } from './physics';

const R = BALL.R;
export const isLong = (w: Wall) => w === 'top' || w === 'bottom';

export interface ShotSummary {
  scored: boolean;
  firstHit?: BallId;
  secondHit?: BallId;
  cushions: Wall[]; // 2적구 전까지 수구가 맞은 쿠션
  cushionFirst: boolean; // 1적구보다 쿠션을 먼저 맞힘 (빈쿠션)
  thickness?: number; // 1적구 두께 (0~1, 1 = 정면). 빈쿠션이면 없음
  hitSide?: 'left' | 'right'; // 수구가 1적구의 어느 쪽을 맞히는지 (치는 사람 시점)
  firstCushion?: { wall: Wall; diamond: number }; // 빈쿠션일 때 1쿠션 도착 지점
  travel: number; // 2적구까지 수구 이동 거리(m)
  kiss: boolean;
}

export function summarize(layout: Layout, shot: Shot): ShotSummary {
  const r = simulate(layout, shot, { dt: 0.0005, maxTime: 14, record: false, stopWhenDecided: true });
  const o = r.outcome;
  const cue = layout[shot.cue];
  const cueEvents = r.events.filter((e) => e.ball === shot.cue || e.other === shot.cue);
  const first = cueEvents[0];
  const cushionFirst = first?.type === 'cushion';
  let thickness: number | undefined, hitSide: ShotSummary['hitSide'];
  if (first?.type === 'ball') {
    const obj = layout[first.ball === shot.cue ? first.other! : first.ball];
    const a = (shot.angleDeg * Math.PI) / 180;
    const cross = Math.cos(a) * (obj.y - cue.y) - Math.sin(a) * (obj.x - cue.x);
    thickness = Math.max(0, Math.min(1, 1 - Math.abs(cross) / (2 * R)));
    hitSide = cross > 0 ? 'right' : 'left'; // 1적구가 겨냥선 왼쪽에 있으면 1적구의 오른쪽을 맞힘
  }
  const firstCushion = cushionFirst && first.wall
    ? { wall: first.wall, diamond: (isLong(first.wall) ? first.x : first.y) / DIAMOND }
    : undefined;
  // 이동 거리: 이벤트 지점 사이 직선 거리 합 (2적구 접촉까지)
  let travel = 0, px = cue.x, py = cue.y;
  for (const e of cueEvents) {
    travel += Math.hypot(e.x - px, e.y - py);
    px = e.x; py = e.y;
    if (e.type === 'ball' && o.secondHit && (e.ball === o.secondHit || e.other === o.secondHit)) break;
  }
  return {
    scored: o.scored, firstHit: o.firstHit, secondHit: o.secondHit, cushions: o.cueCushions,
    cushionFirst, thickness, hitSide, firstCushion, travel, kiss: o.kiss,
  };
}

// ───────── 난이도 ─────────
export interface Difficulty { score: number; level: 'easy' | 'normal' | 'hard'; reasons: string[] }
export function difficulty(layout: Layout, shot: Shot, s: ShotSummary): Difficulty {
  let score = 0;
  const reasons: string[] = [];
  const add = (v: number, why: string) => { score += v; reasons.push(why); };
  const cue = layout[shot.cue];
  if (s.cushionFirst) add(15, '빈쿠션');
  else if (s.thickness !== undefined) {
    if (s.thickness < 0.2) add(22, '아주 얇은 두께');
    else if (s.thickness < 0.33) add(10, '얇은 두께');
  }
  if (shot.speed > 4.0) add(14, '강한 힘');
  else if (shot.speed > 3.5) add(6, '센 힘');
  const tip = Math.hypot(shot.tipX, shot.tipY);
  if (tip > 0.52) add(12, '강한 회전');
  else if (tip > 0.44) add(5, '회전 많음');
  if (shot.tipY < -0.15) add(6, '끌어치기');
  const n = s.cushions.length;
  if (n > 4) add(7 * (n - 4), `쿠션 ${n}회`);
  if (s.travel > 6) add(10, '긴 이동');
  else if (s.travel > 4.2) add(4, '이동 거리 김');
  const railGap = Math.min(cue.x, TABLE.L - cue.x, cue.y, TABLE.W - cue.y) - R;
  if (railGap < 0.03) add(12, '수구가 레일에 붙음');
  else if (railGap < 0.08) add(5, '수구가 레일 가까움');
  if (s.firstHit) {
    const d = Math.hypot(layout[s.firstHit].x - cue.x, layout[s.firstHit].y - cue.y);
    if (!s.cushionFirst && d > 1.8) add(6, '1적구가 멂');
  }
  if (s.kiss) add(12, '키스 위험');
  const level = score < 18 ? 'easy' : score < 40 ? 'normal' : 'hard';
  return { score, level, reasons };
}
export const LEVEL_KO = { easy: '쉬움', normal: '보통', hard: '어려움' } as const;

// ───────── 경로 형태 (장/단 쿠션 순서와 회전 방향) ─────────
const ORDER: Wall[] = ['bottom', 'right', 'top', 'left']; // 반시계 방향 순서
export function pattern(s: ShotSummary): { key: string; label: string } {
  if (!s.firstHit) return { key: 'none', label: '—' };
  const c = s.cushions;
  if (s.cushionFirst) {
    const k = c.slice(0, 3).map((w) => (isLong(w) ? '장' : '단')).join('');
    return { key: `bank-${k}`, label: `빈쿠션 · ${c.slice(0, 3).map((w) => (isLong(w) ? '장' : '단')).join('→')}` };
  }
  const ls = c.slice(0, 3).map((w) => (isLong(w) ? '장' : '단'));
  // 연속 쿠션이 인접 레일을 같은 방향으로 도는지 → 돌리기, 같은 레일 반복 → 더블, 방향 바뀜 → 리버스
  let dir = 0, reverse = false, repeat = false;
  for (let i = 1; i < Math.min(c.length, 4); i++) {
    const a = ORDER.indexOf(c[i - 1]), b = ORDER.indexOf(c[i]);
    if (a === b) { repeat = true; continue; }
    const step = (b - a + 4) % 4;
    const d = step === 1 ? 1 : step === 3 ? -1 : 0; // 0 = 맞은편 레일로 건너감
    if (d && dir && d !== dir) reverse = true;
    if (d) dir = d;
  }
  const seq = ls.join('→');
  if (c.length >= 4 && !reverse && !repeat && ls[0] !== ls[1]) return { key: `around4-${ls[0]}`, label: `대회전 · ${seq}…` };
  if (repeat) return { key: `double-${ls.join('')}`, label: `더블쿠션 · ${seq}` };
  if (reverse) return { key: `reverse-${ls.join('')}`, label: `리버스 · ${seq}` };
  if (ls[0] !== ls[1] && ls[1] !== ls[2]) return { key: `around-${ls.join('')}`, label: `돌리기 · ${seq}` };
  return { key: `cross-${ls.join('')}`, label: `가로지르기 · ${seq}` };
}

// ───────── 실전 표기 ─────────
export function thicknessText(t: number) {
  const k = Math.max(1, Math.round(t * 8));
  return k >= 8 ? '정면' : ['', '1/8', '1/4', '3/8', '1/2', '5/8', '3/4', '7/8'][k];
}
export function powerLevel(speed: number) {
  return speed < 1.9 ? 1 : speed < 2.7 ? 2 : speed < 3.5 ? 3 : speed < 4.3 ? 4 : 5;
}
export const POWER_KO = ['', '약하게', '부드럽게', '중간', '세게', '아주 세게'];
export function tipClock(tx: number, ty: number) {
  const d = Math.hypot(tx, ty);
  if (d < 0.04) return '중앙';
  const deg = (Math.atan2(ty, tx) * 180) / Math.PI;
  const hour = ((Math.round((90 - deg) / 30) % 12) + 12) % 12 || 12;
  return `${hour}시 ${(d / 0.2).toFixed(1).replace('.0', '')}팁`;
}
const WALL_RAIL: Record<Wall, string> = { top: '위 장쿠션', bottom: '아래 장쿠션', left: '왼쪽 단쿠션', right: '오른쪽 단쿠션' };
// "어떻게 쳐야 하는지" 한 줄: 겨냥(두께 또는 1쿠션 지점) · 당점 · 힘
export function howTo(shot: Shot, s: ShotSummary | undefined) {
  const p = powerLevel(shot.speed);
  let aim = '';
  if (s?.firstCushion) aim = `${WALL_RAIL[s.firstCushion.wall]} ${s.firstCushion.diamond.toFixed(1)}포인트로`;
  else if (s?.firstHit && s.thickness !== undefined) {
    const side = s.thickness >= 0.94 ? '' : s.hitSide === 'right' ? ' 오른쪽' : ' 왼쪽';
    aim = `1적구${side} ${thicknessText(s.thickness)}${s.thickness >= 0.94 ? '' : ' 두께'}`;
  }
  return { aim, tip: tipClock(shot.tipX, shot.tipY), power: `힘 ${p}/5 ${POWER_KO[p]}` };
}
