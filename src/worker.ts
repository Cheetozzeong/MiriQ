// 계산 워커: 메인 스레드가 여러 개를 띄워 작업을 나눠 처리한다 (UI 끊김 방지 + 멀티코어 활용)
//  - scan: 한 가지 힘·당점 조합으로 360° 전 방향을 시뮬레이션해 득점 각도 구간을 찾는다
//  - eval: 한 샷의 성공 확률(스트로크 오차 반영)과 경로 요약을 계산한다
import type { ScanRange } from './ranges';
import { BALL, quickScore, robustness, simulate, type BallId, type Layout, type Shot, type Wall } from './physics';

export type WorkerRequest =
  | { kind: 'scan'; id: number; layout: Layout; shot: Shot; step: number; from: number; to: number }
  | { kind: 'eval'; id: number; layout: Layout; shot: Shot; n: number };

export interface ShotSummary {
  scored: boolean;
  firstHit?: BallId;
  secondHit?: BallId;
  cushions: Wall[]; // 2적구 전까지 수구가 맞은 쿠션
  thickness?: number; // 1적구 두께 (0~1, 1 = 정면). 쿠션 먼저 맞는 샷이면 없음
  kiss: boolean;
}
export type { ScanRange };
export type WorkerResponse =
  | { kind: 'progress'; id: number; value: number }
  | { kind: 'scan'; id: number; ok: Uint8Array }
  | { kind: 'eval'; id: number; prob: number; summary: ShotSummary };

const post = (m: WorkerResponse) => (self as unknown as Worker).postMessage(m);

export function summarize(layout: Layout, shot: Shot): ShotSummary {
  const r = simulate(layout, shot, { dt: 0.0005, maxTime: 14, record: false, stopWhenDecided: true });
  const o = r.outcome;
  let thickness: number | undefined;
  const first = r.events.find((e) => e.ball === shot.cue || e.other === shot.cue);
  if (first?.type === 'ball') {
    const obj = first.ball === shot.cue ? first.other! : first.ball;
    const a = (shot.angleDeg * Math.PI) / 180;
    const c = layout[shot.cue], b = layout[obj];
    const d = Math.abs(Math.cos(a) * (b.y - c.y) - Math.sin(a) * (b.x - c.x));
    thickness = Math.max(0, Math.min(1, 1 - d / (2 * BALL.R)));
  }
  return { scored: o.scored, firstHit: o.firstHit, secondHit: o.secondHit, cushions: o.cueCushions, thickness, kiss: o.kiss };
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  if (req.kind === 'eval') {
    post({ kind: 'eval', id: req.id, prob: robustness(req.layout, req.shot, req.n), summary: summarize(req.layout, req.shot) });
    return;
  }
  // 각도 인덱스 [from, to) 구간만 계산 → 메인에서 이어 붙여 연속 구간을 찾는다
  const { layout, shot, step, id, from, to } = req;
  const ok = new Uint8Array(to - from);
  for (let i = from; i < to; i++) {
    ok[i - from] = quickScore(layout, { ...shot, angleDeg: i * step }) ? 1 : 0;
    if ((i - from) % 30 === 29) post({ kind: 'progress', id, value: (i - from) / (to - from) });
  }
  post({ kind: 'scan', id, ok });
};
