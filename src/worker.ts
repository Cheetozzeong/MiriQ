// 계산 워커: 메인 스레드가 여러 개를 띄워 작업을 나눠 처리한다 (UI 끊김 방지 + 멀티코어 활용)
//  - scan: 한 가지 힘·당점 조합으로 360° 를 1° 간격으로 훑고, 득점/아까운 방향 주변만 0.2° 로 정밀 탐색
//  - eval: 실력 단계 오차를 반영한 성공 확률 + 정밀 시뮬레이션으로 득점 검증(필요하면 각도 미세 보정) + 경로 요약
import { summarize, type ShotSummary } from './analysis';
import { findRanges, type ScanRange } from './ranges';
import {
  robustness, scanShot, setTableSpeed, simulate,
  type ErrorModel, type Layout, type Shot, type TableSpeed,
} from './physics';

export type WorkerRequest =
  | { kind: 'scan'; id: number; layout: Layout; shot: Shot; table: TableSpeed }
  | { kind: 'eval'; id: number; layout: Layout; shot: Shot; width: number; n: number; err: ErrorModel; table: TableSpeed };

export type { ScanRange, ShotSummary };
export type WorkerResponse =
  | { kind: 'progress'; id: number; value: number }
  | { kind: 'scan'; id: number; ranges: ScanRange[] }
  | { kind: 'eval'; id: number; prob: number; angleDeg: number; verified: boolean; summary: ShotSummary };

const post = (m: WorkerResponse) => (self as unknown as Worker).postMessage(m);
const FINE = 0.2; // 정밀 탐색 간격(°)
const BINS = Math.round(360 / FINE);

const preciseScore = (layout: Layout, shot: Shot) =>
  simulate(layout, shot, { dt: 0.0005, maxTime: 14, record: false, stopWhenDecided: true }).outcome.scored;

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
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
  post({ kind: 'scan', id, ranges: findRanges(ok, FINE) });
};
