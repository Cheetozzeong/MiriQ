// 계산 워커: 메인 스레드가 여러 개를 띄워 작업을 나눠 처리한다 (UI 끊김 방지 + 멀티코어 활용)
import { runJob, type WorkerRequest, type WorkerResponse } from './jobs';

export type { ScanRange, ShotSummary, WorkerRequest, WorkerResponse } from './jobs';
self.onmessage = (ev: MessageEvent<WorkerRequest>) => runJob(ev.data, (m: WorkerResponse) => (self as unknown as Worker).postMessage(m));
