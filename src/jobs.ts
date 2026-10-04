// 추천 계산 작업 (워커/메인 스레드 공용)
//  - scan: 한 가지 힘·당점 조합으로 360° 를 1° 간격으로 훑고, 득점/아까운 방향 주변만 0.2° 로 정밀 탐색
//  - eval: 실력 단계 오차를 반영한 성공 확률 + 정밀 시뮬레이션으로 득점 검증(필요하면 각도 미세 보정) + 경로 요약
import { summarize, type ShotSummary } from './analysis';
import { findRanges, type ScanRange } from './ranges';
import {
  layoutEase, perturb, rng, robustness, scanShot, setTableSpeed, simulate,
  type BallId, type ErrorModel, type Layout, type Shot, type TableSpeed,
} from './physics';

export type WorkerRequest =
  | { kind: 'scan'; id: number; layout: Layout; shot: Shot; table: TableSpeed }
  | { kind: 'eval'; id: number; layout: Layout; shot: Shot; width: number; n: number; err: ErrorModel; table: TableSpeed }
  | { kind: 'pos'; id: number; layout: Layout; shot: Shot; err: ErrorModel; table: TableSpeed };

export type { ScanRange, ShotSummary };
export type WorkerResponse =
  | { kind: 'progress'; id: number; value: number }
  | { kind: 'scan'; id: number; ranges: ScanRange[] }
  | { kind: 'eval'; id: number; prob: number; angleDeg: number; verified: boolean; summary: ShotSummary }
  | { kind: 'pos'; id: number; position: number; defense: number; next: Layout; nextShot?: Shot };

const FINE = 0.2; // 정밀 탐색 간격(°)
const BINS = Math.round(360 / FINE);

const preciseScore = (layout: Layout, shot: Shot) =>
  simulate(layout, shot, { dt: 0.0005, maxTime: 14, record: false, stopWhenDecided: true }).outcome.scored;

// 다음 배치에서의 최고 성공 확률 — 본 추천 엔진의 축소판
//  힘·당점 3가지 × (2° 간격 훑기 → 득점/아까운 방향만 0.5° 정밀) → 허용폭 상위 4개를 실력 오차 16회로 평가
export function bestNextShot(layout: Layout, cue: BallId, err: ErrorModel): { prob: number; shot?: Shot } {
  const variants = [-0.3, 0, 0.3].map((tipX) => ({ tipX, tipY: 0.2, speed: 3.0 }));
  const STEP = 0.5, N = Math.round(360 / STEP);
  const found: (ScanRange & { v: (typeof variants)[number] })[] = [];
  for (const v of variants) {
    const ok = new Uint8Array(N);
    const todo = new Set<number>();
    for (let a = 0; a < 360; a += 2) {
      const st = scanShot(layout, { cue, angleDeg: a, ...v });
      if (st === 2) ok[a / STEP] = 1;
      if (st) for (let k = -2; k <= 2; k++) todo.add((a / STEP + k + N) % N);
    }
    for (const b of todo) if (b % 4 !== 0) ok[b] = scanShot(layout, { cue, angleDeg: b * STEP, ...v }) === 2 ? 1 : 0;
    for (const g of findRanges(ok, STEP)) found.push({ ...g, v });
  }
  found.sort((a, b) => b.width - a.width);
  let best = { prob: 0 } as { prob: number; shot?: Shot };
  for (const g of found.slice(0, 4)) {
    const shot: Shot = { cue, angleDeg: g.angleDeg, ...g.v };
    const prob = robustness(layout, shot, 16, err);
    if (prob > best.prob) best = { prob, shot };
  }
  return best;
}

// 작업 하나 처리 — 워커에서도, 워커를 못 쓸 때 메인 스레드에서도 같은 코드로 실행
export function runJob(req: WorkerRequest, post: (m: WorkerResponse) => void) {
  setTableSpeed(req.table);
  if (req.kind === 'eval') {
    const { layout, shot, width, n, err, id } = req;
    // 탐색은 빠른 시뮬레이션이라 정밀 시뮬레이션에서 빗나갈 수 있음 → 구간 안에서 정밀 득점 각도 찾기
    let angle = shot.angleDeg, verified = preciseScore(layout, shot);
    for (let k = 1; !verified && k * 0.1 <= width / 2 + 0.2; k++) {
      for (const a of [shot.angleDeg + k * 0.1, shot.angleDeg - k * 0.1]) {
        if (preciseScore(layout, { ...shot, angleDeg: a })) { angle = (a + 360) % 360; verified = true; break; }
      }
    }
    const s = { ...shot, angleDeg: angle };
    post({ kind: 'eval', id, prob: robustness(layout, s, n, err), angleDeg: angle, verified, summary: summarize(layout, s) });
    return;
  }
  if (req.kind === 'pos') {
    // 후구 배치: 이 샷으로 득점하고 공이 모두 멈춘 배치에서 같은 수구로 다시 칠 때의 쉬움
    // 수비: 이 샷이 실패한 경우(오차 샘플)의 멈춘 배치에서 상대가 자기 수구로 칠 때 어려움
    const { layout, shot, err, id } = req;
    const full = (s: Shot) => simulate(layout, s, { dt: 0.001, maxTime: 25, record: false });
    const nominal = full(shot);
    // 후구: 득점 후 멈춘 배치에서 같은 수구로 칠 다음 샷의 최고 성공 확률 (본 추천 엔진)
    const next = nominal.outcome.scored ? bestNextShot(nominal.final, shot.cue, err) : { prob: 0 };
    const position = next.prob;
    post({ kind: 'progress', id, value: 0.5 });
    const opp: BallId = shot.cue === 'white' ? 'yellow' : 'white';
    const r = rng(777);
    const eases: number[] = [];
    for (let k = 0; k < 14 && eases.length < 2; k++) {
      const res = full(perturb(shot, err, r));
      if (!res.outcome.scored) eases.push(layoutEase(res.final, opp));
    }
    const defense = eases.length ? 1 - eases.reduce((a, b) => a + b, 0) / eases.length : 1;
    post({ kind: 'pos', id, position, defense, next: nominal.final, nextShot: next.shot });
    return;
  }
  const { layout, shot, id } = req;
  // 1단계: 1° 간격
  const status = new Uint8Array(360);
  for (let a = 0; a < 360; a++) {
    status[a] = scanShot(layout, { ...shot, angleDeg: a });
    if (a % 30 === 29) post({ kind: 'progress', id, value: (a / 360) * 0.6 });
  }
  // 2단계: 득점(2)·아까움(1) 방향 주변 ±0.8° 를 0.2° 간격으로
  const ok = new Uint8Array(BINS);
  const todo = new Set<number>();
  for (let a = 0; a < 360; a++) {
    if (!status[a]) continue;
    const span = status[a] === 2 ? 4 : 2; // 득점 방향은 ±0.8°, 아깝게 빗나간 방향은 ±0.4°
    for (let k = -span; k <= span; k++) todo.add((a * 5 + k + BINS) % BINS);
  }
  let i = 0;
  for (const b of todo) {
    ok[b] = b % 5 === 0 ? (status[b / 5] === 2 ? 1 : 0) : scanShot(layout, { ...shot, angleDeg: b * FINE }) === 2 ? 1 : 0;
    if (++i % 40 === 0) post({ kind: 'progress', id, value: 0.6 + (i / todo.size) * 0.4 });
  }
  // 각 구간이 공을 먼저 맞히는 샷인지(빈쿠션 아님) 분류 — 추천 순서에 사용
  const ranges = findRanges(ok, FINE).map((g) => {
    const r = simulate(layout, { ...shot, angleDeg: g.angleDeg }, { dt: 0.0015, maxTime: 14, record: false, stopWhenDecided: true });
    const first = r.events.find((e) => e.ball === shot.cue || e.other === shot.cue);
    return { ...g, direct: first?.type === 'ball' };
  });
  post({ kind: 'scan', id, ranges });
}
