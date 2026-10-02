// 계산 워커: 추천 샷 탐색 + 성공 확률 계산 (UI 끊김 방지)
import { quickScore, robustness, type Layout, type Shot } from './physics';

export type WorkerRequest =
  | { kind: 'search'; id: number; layout: Layout; shot: Shot; wide: boolean }
  | { kind: 'prob'; id: number; layout: Layout; shot: Shot };
export interface Candidate { angleDeg: number; width: number; tipX: number; tipY: number; speed: number; prob: number }
export type WorkerResponse =
  | { kind: 'progress'; id: number; value: number }
  | { kind: 'search'; id: number; candidates: Candidate[] }
  | { kind: 'prob'; id: number; value: number };

const STEP = 0.4;
const post = (m: WorkerResponse) => (self as unknown as Worker).postMessage(m);

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  if (req.kind === 'prob') {
    post({ kind: 'prob', id: req.id, value: robustness(req.layout, req.shot, 40) });
    return;
  }
  const { layout, shot, wide, id } = req;
  const variants: Pick<Shot, 'tipX' | 'tipY' | 'speed'>[] = wide
    ? [-0.4, -0.2, 0, 0.2, 0.4].flatMap((tx) => [0.85, 1.2].map((sf) => ({ tipX: tx, tipY: shot.tipY, speed: shot.speed * sf })))
    : [{ tipX: shot.tipX, tipY: shot.tipY, speed: shot.speed }];
  const n = Math.round(360 / STEP);
  const total = variants.length * n;
  const ranges: Candidate[] = [];
  let done = 0;
  for (const v of variants) {
    const ok: boolean[] = [];
    for (let i = 0; i < n; i++) {
      ok.push(quickScore(layout, { ...shot, ...v, angleDeg: i * STEP }));
      if (++done % 60 === 0) post({ kind: 'progress', id, value: done / total });
    }
    // 연속 성공 각도 구간 → 후보 하나 (구간이 넓을수록 실수에 관대)
    let i = 0;
    while (i < n) {
      if (!ok[i]) { i++; continue; }
      let j = i;
      while (j + 1 < n && ok[j + 1]) j++;
      ranges.push({ angleDeg: ((i + j) / 2) * STEP, width: (j - i + 1) * STEP, ...v, prob: 0 });
      i = j + 1;
    }
  }
  ranges.sort((a, b) => b.width - a.width);
  const top = ranges.slice(0, 8);
  for (const c of top) c.prob = robustness(layout, { ...shot, ...c }, 30);
  top.sort((a, b) => b.prob - a.prob || b.width - a.width);
  post({ kind: 'search', id, candidates: top });
};
