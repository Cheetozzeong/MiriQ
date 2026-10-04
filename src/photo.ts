// 사진으로 배치 입력
//  1) 촬영 가이드 → 카메라(실시간 틀 표시) 또는 사진 불러오기
//  2) 코너 4곳 맞추기 → 원근 변환(호모그래피) + 카메라 자세 추정
//  3) 공 높이(반지름 3cm) 평면으로 위에서 본 모습 생성 → 색으로 공 3개 자동 인식 → 사용자가 미세 조정
//  4) 배치 적용
import { BALL, BALL_IDS, DIAMOND, KO, TABLE, type BallId, type Layout, type Pos } from './physics';

const R = BALL.R, L = TABLE.L, W = TABLE.W;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const COLORS: Record<BallId, string> = { white: '#f7f7f2', yellow: '#f4c430', red: '#d9262c' };
type M3 = number[]; // 3x3 행렬 (행 우선)

// ───────── 선형대수 ─────────
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}
// 평면 좌표(X,Y) → 이미지 좌표(x,y) 호모그래피
function homography(src: Pos[], dst: Pos[]): M3 {
  const A: number[][] = [], b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x: X, y: Y } = src[i], { x, y } = dst[i];
    A.push([X, Y, 1, 0, 0, 0, -X * x, -Y * x]); b.push(x);
    A.push([0, 0, 0, X, Y, 1, -X * y, -Y * y]); b.push(y);
  }
  return [...solve(A, b), 1];
}
const apply = (H: M3, X: number, Y: number): Pos => {
  const w = H[6] * X + H[7] * Y + H[8];
  return { x: (H[0] * X + H[1] * Y + H[2]) / w, y: (H[3] * X + H[4] * Y + H[5]) / w };
};
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: number[]) => Math.hypot(a[0], a[1], a[2]);

// 카메라 자세 추정 → 공 중심 높이(z = R) 평면용 호모그래피 + 촬영 각도
function cameraModel(H: M3, w: number, h: number) {
  const cx = w / 2, cy = h / 2, maxDim = Math.max(w, h);
  const c1 = [H[0] - cx * H[6], H[3] - cy * H[6], H[6]];
  const c2 = [H[1] - cx * H[7], H[4] - cy * H[7], H[7]];
  // 초점거리: 회전 행렬 열의 직교 조건 / 크기 조건에서 추정, 실패하면 일반 휴대폰 화각(약 68°) 가정
  const ests: number[] = [];
  const f2a = -(c1[0] * c2[0] + c1[1] * c2[1]) / (c1[2] * c2[2]);
  const f2b = (c2[0] ** 2 + c2[1] ** 2 - c1[0] ** 2 - c1[1] ** 2) / (c1[2] ** 2 - c2[2] ** 2);
  for (const f2 of [f2a, f2b]) {
    if (Number.isFinite(f2) && f2 > 0) { const f = Math.sqrt(f2); if (f > 0.45 * maxDim && f < 2.5 * maxDim) ests.push(f); }
  }
  const estimated = ests.length > 0;
  const f = estimated ? ests.reduce((a, b) => a + b, 0) / ests.length : 0.75 * maxDim;
  const kinv = (c: number[]) => [c[0] / f, c[1] / f, c[2]];
  const b1 = kinv(c1), b2 = kinv(c2), b3 = kinv([H[2] - cx * H[8], H[5] - cy * H[8], H[8]]);
  let lam = 2 / (norm(b1) + norm(b2));
  if (b3[2] * lam < 0) lam = -lam; // 카메라 앞쪽
  const r1 = b1.map((v) => v * lam), r2 = b2.map((v) => v * lam), t = b3.map((v) => v * lam);
  let r3 = cross(r1, r2);
  const C = [-dot(r1, t), -dot(r2, t), -dot(r3, t)];
  if (C[2] < 0) { r3 = r3.map((v) => -v); C[2] = -C[2]; } // 카메라는 테이블 위쪽
  const tR = [t[0] + R * r3[0], t[1] + R * r3[1], t[2] + R * r3[2]];
  // K·[r1 r2 tR] — 공 중심 높이 평면 → 이미지
  const K = (v: number[]) => [f * v[0] + cx * v[2], f * v[1] + cy * v[2], v[2]];
  const k1 = K(r1), k2 = K(r2), k3 = K(tR);
  const HR: M3 = [k1[0], k2[0], k3[0], k1[1], k2[1], k3[1], k1[2], k2[2], k3[2]];
  const elev = (Math.atan2(C[2], Math.hypot(C[0] - L / 2, C[1] - W / 2)) * 180) / Math.PI;
  return { HR, elev, cam: { x: C[0], y: C[1], z: C[2] }, focalEstimated: estimated };
}

// ───────── 색 분류 + 공 찾기 ─────────
function hsv(r: number, g: number, b: number) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: mx ? d / mx : 0, v: mx / 255 };
}
interface Detect { pos: Pos; found: boolean }
function detectBalls(img: ImageData, k: number, cam: { x: number; y: number }, elev: number): Record<BallId, Detect> {
  const { width: w, height: h, data } = img;
  const lab = new Uint8Array(w * h);
  // 천 밝기 기준 (흰공 판별을 조명에 맞게)
  const vs: number[] = [];
  for (let i = 0; i < w * h; i += 97) vs.push(hsv(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]).v);
  vs.sort((a, b) => a - b);
  const clothV = vs[Math.floor(vs.length / 2)];
  for (let i = 0; i < w * h; i++) {
    const { h: H, s, v } = hsv(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    if (s < 0.28 && v > Math.max(0.5, clothV * 0.85)) lab[i] = 1; // 흰공 (천은 채도가 높아 저채도·밝음으로 구분)
    else if (H >= 35 && H <= 75 && s > 0.35 && v > 0.4) lab[i] = 2; // 노란공
    else if ((H <= 18 || H >= 330) && s > 0.42 && v > 0.25) lab[i] = 3; // 빨간공
  }
  const expected = Math.PI * (R * k) ** 2;
  const maxArea = expected * Math.min(10, 2.5 / Math.sin((Math.max(elev, 8) * Math.PI) / 180));
  const best: { area: number; sx: number; sy: number }[] = [{ area: 0, sx: 0, sy: 0 }, { area: 0, sx: 0, sy: 0 }, { area: 0, sx: 0, sy: 0 }];
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!lab[i] || seen[i]) continue;
    const c = lab[i];
    let area = 0, sx = 0, sy = 0;
    stack.push(i); seen[i] = 1;
    while (stack.length) {
      const j = stack.pop()!;
      const x = j % w, y = (j / w) | 0;
      area++; sx += x; sy += y;
      for (const n of [j - 1, j + 1, j - w, j + w]) {
        if (n < 0 || n >= w * h || seen[n] || lab[n] !== c) continue;
        if ((n === j - 1 && x === 0) || (n === j + 1 && x === w - 1)) continue;
        seen[n] = 1; stack.push(n);
      }
    }
    // 낮은 각도에서 찍으면 공이 길게 늘어나 보이므로 허용 범위를 각도에 맞춰 넓힘
    if (area < 0.2 * expected || area > maxArea) continue;
    if (area > best[c - 1].area) best[c - 1] = { area, sx, sy };
  }
  const out = {} as Record<BallId, Detect>;
  // 밝은 윗면 쪽으로 치우친 무게중심을 카메라 쪽으로 약간 보정
  const shift = Math.min(R, (0.25 * R) / Math.tan((Math.max(elev, 10) * Math.PI) / 180));
  BALL_IDS.forEach((id, i) => {
    const b = best[i];
    if (!b.area) { out[id] = { pos: { x: L * (0.3 + i * 0.2), y: W / 2 }, found: false }; return; }
    let x = (b.sx / b.area + 0.5) / k, y = W - (b.sy / b.area + 0.5) / k;
    const dx = cam.x - x, dy = cam.y - y, d = Math.hypot(dx, dy) || 1;
    x += (dx / d) * shift; y += (dy / d) * shift;
    out[id] = { pos: { x: Math.min(L - R, Math.max(R, x)), y: Math.min(W - R, Math.max(R, y)) }, found: true };
  });
  return out;
}

// ───────── 화면 흐름 ─────────
export function initPhoto(onApply: (l: Layout) => void, hooks: { onOpen?: () => void; onClose?: () => void } = {}) {
  const root = $('photo');
  const steps = root.querySelectorAll<HTMLElement>('[data-step]');
  const show = (name: string) => steps.forEach((s) => s.classList.toggle('hidden', s.dataset.step !== name));
  let stream: MediaStream | null = null;
  let src: HTMLCanvasElement | null = null; // 처리용 원본 (긴 변 1600px)
  let corners: Pos[] = []; // 이미지 좌표, 순서: 내쪽 왼쪽, 내쪽 오른쪽, 먼쪽 오른쪽, 먼쪽 왼쪽
  let model: ReturnType<typeof cameraModel> | null = null;
  let top: HTMLCanvasElement | null = null; // 위에서 본 이미지
  let balls: Record<BallId, Detect> | null = null;
  const K = 300; // 위에서 본 이미지 해상도 (px/m)

  const stopCam = () => { stream?.getTracks().forEach((t) => t.stop()); stream = null; };
  const close = () => { stopCam(); root.classList.add('hidden'); document.body.classList.remove('photo-open'); hooks.onClose?.(); };
  $('phClose').addEventListener('click', close);
  $('photoBtn').addEventListener('click', () => {
    root.classList.remove('hidden'); document.body.classList.add('photo-open'); show('guide');
    hooks.onOpen?.();
  });

  // 촬영 위치: 단쿠션 쪽 / 장쿠션 쪽 → 코너 ↔ 테이블 좌표 대응 (오른손 좌표계 유지)
  const tablePts = (): Pos[] => (root.querySelector<HTMLInputElement>('input[name=phSide]:checked')!.value === 'short'
    ? [{ x: 0, y: W }, { x: 0, y: 0 }, { x: L, y: 0 }, { x: L, y: W }]
    : [{ x: 0, y: 0 }, { x: L, y: 0 }, { x: L, y: W }, { x: 0, y: W }]);

  function loadImage(el: CanvasImageSource, w: number, h: number) {
    const s = Math.min(1, 1600 / Math.max(w, h));
    src = document.createElement('canvas');
    src.width = Math.round(w * s); src.height = Math.round(h * s);
    src.getContext('2d')!.drawImage(el, 0, 0, src.width, src.height);
    const W0 = src.width, H0 = src.height;
    corners = [{ x: W0 * 0.08, y: H0 * 0.88 }, { x: W0 * 0.92, y: H0 * 0.88 }, { x: W0 * 0.74, y: H0 * 0.3 }, { x: W0 * 0.26, y: H0 * 0.3 }];
    show('corners');
    requestAnimationFrame(drawCorners);
  }

  // 카메라 (실시간 미리보기 + 맞춤 틀)
  $('phCamera').addEventListener('click', async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      const v = root.querySelector('video')!;
      v.srcObject = stream;
      await v.play();
      show('camera');
    } catch {
      // 카메라 권한이 없거나 지원하지 않으면 기본 촬영 앱으로
      $<HTMLInputElement>('phCapture').click();
    }
  });
  $('phShoot').addEventListener('click', () => {
    const v = root.querySelector('video')!;
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    stopCam();
    loadImage(c, c.width, c.height);
  });
  const onFile = (inp: HTMLInputElement) => inp.addEventListener('change', () => {
    const f = inp.files?.[0];
    if (!f) return;
    const img = new Image();
    img.onload = () => { loadImage(img, img.naturalWidth, img.naturalHeight); URL.revokeObjectURL(img.src); };
    img.src = URL.createObjectURL(f);
    inp.value = '';
  });
  onFile($('phFile')); onFile($('phCapture'));

  // ── 코너 맞추기 ──
  const cc = $<HTMLCanvasElement>('phCanvas');
  const cctx = cc.getContext('2d')!;
  let view = { s: 1, ox: 0, oy: 0 }; // 원본 → 화면
  let dragI = -1, dragFrom: Pos = { x: 0, y: 0 }, dragP0: Pos = { x: 0, y: 0 };
  const LABELS = ['① 내 쪽 왼쪽', '② 내 쪽 오른쪽', '③ 먼 쪽 오른쪽', '④ 먼 쪽 왼쪽'];
  function fitCanvas(c: HTMLCanvasElement, w: number, h: number) {
    const box = c.parentElement!;
    const s = Math.min(box.clientWidth / w, (box.clientHeight || innerHeight * 0.6) / h);
    const dpr = devicePixelRatio || 1;
    c.style.width = `${w * s}px`; c.style.height = `${h * s}px`;
    c.width = Math.round(w * s * dpr); c.height = Math.round(h * s * dpr);
    c.getContext('2d')!.setTransform(dpr, 0, 0, dpr, 0, 0);
    return s;
  }
  function drawCorners() {
    if (!src) return;
    view.s = fitCanvas(cc, src.width, src.height);
    const s = view.s;
    cctx.drawImage(src, 0, 0, src.width * s, src.height * s);
    cctx.strokeStyle = '#3fa7ff'; cctx.lineWidth = 2;
    cctx.beginPath();
    corners.forEach((p, i) => (i ? cctx.lineTo(p.x * s, p.y * s) : cctx.moveTo(p.x * s, p.y * s)));
    cctx.closePath(); cctx.stroke();
    corners.forEach((p, i) => {
      cctx.fillStyle = i === dragI ? 'rgba(245,185,66,.35)' : 'rgba(63,167,255,.25)';
      cctx.beginPath(); cctx.arc(p.x * s, p.y * s, 16, 0, Math.PI * 2); cctx.fill();
      cctx.strokeStyle = i === dragI ? '#f5b942' : '#fff'; cctx.lineWidth = 2; cctx.stroke();
      cctx.beginPath(); cctx.arc(p.x * s, p.y * s, 2, 0, Math.PI * 2); cctx.fillStyle = '#fff'; cctx.fill();
      cctx.font = 'bold 12px sans-serif'; cctx.textAlign = 'center';
      // 이름표가 화면 밖으로 잘리지 않게 안쪽으로 붙임
      const ty = Math.min(cc.clientHeight - 6, Math.max(14, i < 2 ? p.y * s - 22 : p.y * s + 30));
      const tx = Math.min(cc.clientWidth - 47, Math.max(47, p.x * s));
      cctx.fillStyle = 'rgba(0,0,0,.7)'; cctx.fillRect(tx - 46, ty - 12, 92, 17);
      cctx.fillStyle = '#fff'; cctx.fillText(LABELS[i], tx, ty);
    });
    if (dragI >= 0) {
      // 돋보기: 원본 이미지를 3배로
      const p = corners[dragI], r = 56, z = 3;
      const cxp = p.x * s < cc.clientWidth / 2 ? cc.clientWidth - r - 8 : r + 8, cyp = r + 8;
      cctx.save(); cctx.beginPath(); cctx.arc(cxp, cyp, r, 0, Math.PI * 2); cctx.clip();
      const sr = r / (z * s);
      cctx.drawImage(src, p.x - sr, p.y - sr, 2 * sr, 2 * sr, cxp - r, cyp - r, 2 * r, 2 * r);
      cctx.strokeStyle = '#f5b942'; cctx.lineWidth = 1;
      cctx.beginPath(); cctx.moveTo(cxp - 12, cyp); cctx.lineTo(cxp + 12, cyp); cctx.moveTo(cxp, cyp - 12); cctx.lineTo(cxp, cyp + 12); cctx.stroke();
      cctx.restore();
      cctx.strokeStyle = '#fff'; cctx.lineWidth = 2; cctx.beginPath(); cctx.arc(cxp, cyp, r, 0, Math.PI * 2); cctx.stroke();
    }
  }
  // 포인터 → 캔버스 좌표 (사진 입력 화면은 회전하지 않으므로 그대로)
  const local = (c: HTMLCanvasElement, ev: PointerEvent): Pos => {
    const r = c.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };
  cc.addEventListener('pointerdown', (ev) => {
    const p = local(cc, ev);
    let best = -1, bd = 44;
    corners.forEach((c, i) => { const d = Math.hypot(c.x * view.s - p.x, c.y * view.s - p.y); if (d < bd) { bd = d; best = i; } });
    if (best < 0) return;
    dragI = best; dragFrom = { ...corners[best] }; dragP0 = p;
    cc.setPointerCapture(ev.pointerId);
    drawCorners();
  });
  cc.addEventListener('pointermove', (ev) => {
    if (dragI < 0 || !src) return;
    const p = local(cc, ev);
    // 손가락보다 천천히 움직여 정밀하게 (0.5배)
    corners[dragI] = {
      x: Math.min(src.width, Math.max(0, dragFrom.x + ((p.x - dragP0.x) / view.s) * 0.5)),
      y: Math.min(src.height, Math.max(0, dragFrom.y + ((p.y - dragP0.y) / view.s) * 0.5)),
    };
    drawCorners();
  });
  const endCorner = () => { dragI = -1; drawCorners(); };
  cc.addEventListener('pointerup', endCorner);
  cc.addEventListener('pointercancel', endCorner);

  // ── 위에서 본 모습 + 공 인식 ──
  const tc = $<HTMLCanvasElement>('phTop');
  const tctx = tc.getContext('2d')!;
  let tScale = 1, vert = false, bDrag: { id: BallId; from: Pos; p0: Pos } | null = null;
  // 위에서 본 화면 좌표: 세로 화면에서는 테이블을 세워서(장축이 위쪽) 크게 표시
  const toScreen = (p: Pos): [number, number] => {
    const k = K * tScale;
    return vert ? [(W - p.y) * k, (L - p.x) * k] : [p.x * k, (W - p.y) * k];
  };
  $('phCornersOk').addEventListener('click', () => {
    if (!src) return;
    const H = homography(tablePts(), corners);
    model = cameraModel(H, src.width, src.height);
    const sw = src.width, sh = src.height;
    const sdata = src.getContext('2d')!.getImageData(0, 0, sw, sh).data;
    top = document.createElement('canvas');
    top.width = Math.round(L * K); top.height = Math.round(W * K);
    const tctx2 = top.getContext('2d')!;
    const out = tctx2.createImageData(top.width, top.height);
    for (let v = 0; v < top.height; v++) for (let u = 0; u < top.width; u++) {
      const q = apply(model.HR, (u + 0.5) / K, W - (v + 0.5) / K);
      const x = Math.round(q.x), y = Math.round(q.y), o = (v * top.width + u) * 4;
      if (x < 0 || y < 0 || x >= sw || y >= sh) { out.data[o + 3] = 255; continue; }
      const i = (y * sw + x) * 4;
      out.data[o] = sdata[i]; out.data[o + 1] = sdata[i + 1]; out.data[o + 2] = sdata[i + 2]; out.data[o + 3] = 255;
    }
    tctx2.putImageData(out, 0, 0);
    balls = detectBalls(out, K, model.cam, model.elev);
    const miss = BALL_IDS.filter((id) => !balls![id].found);
    const tips: string[] = [];
    if (model.elev < 22) tips.push(`촬영 각도가 낮습니다(${model.elev.toFixed(0)}°). 더 높이 들고 찍으면 정확해집니다`);
    if (miss.length) tips.push(`${miss.map((id) => KO[id]).join(', ')}을(를) 찾지 못했습니다 — 표시를 끌어서 맞춰 주세요`);
    $('phQuality').innerHTML = tips.length
      ? tips.map((t) => `<span style="color:var(--warn)">• ${t}</span>`).join('<br>')
      : `<span style="color:var(--ok)">공 3개를 모두 찾았습니다 (촬영 각도 ${model.elev.toFixed(0)}°)</span> — 위치가 다르면 끌어서 맞춰 주세요`;
    show('balls');
    requestAnimationFrame(drawTop);
  });
  function drawTop() {
    if (!top || !balls) return;
    const box = tc.parentElement!;
    vert = box.clientHeight > box.clientWidth * 1.1;
    tScale = vert ? fitCanvas(tc, top.height, top.width) : fitCanvas(tc, top.width, top.height);
    const s = tScale;
    tctx.save();
    if (vert) { tctx.translate(0, top.width * s); tctx.rotate(-Math.PI / 2); }
    tctx.drawImage(top, 0, 0, top.width * s, top.height * s);
    tctx.strokeStyle = 'rgba(255,255,255,.25)'; tctx.lineWidth = 1;
    for (let i = 1; i < 8; i++) { const x = i * DIAMOND * K * s; tctx.beginPath(); tctx.moveTo(x, 0); tctx.lineTo(x, top.height * s); tctx.stroke(); }
    for (let j = 1; j < 4; j++) { const y = j * DIAMOND * K * s; tctx.beginPath(); tctx.moveTo(0, y); tctx.lineTo(top.width * s, y); tctx.stroke(); }
    tctx.restore();
    for (const id of BALL_IDS) {
      const b = balls[id];
      const [x, y] = toScreen(b.pos), r = Math.max(R * K * s, 7);
      tctx.lineWidth = 3; tctx.strokeStyle = '#000'; tctx.beginPath(); tctx.arc(x, y, r + 2, 0, Math.PI * 2); tctx.stroke();
      tctx.lineWidth = 2.5; tctx.strokeStyle = COLORS[id]; tctx.setLineDash(b.found ? [] : [4, 3]);
      tctx.beginPath(); tctx.arc(x, y, r + 2, 0, Math.PI * 2); tctx.stroke(); tctx.setLineDash([]);
      tctx.fillStyle = COLORS[id]; tctx.font = 'bold 11px sans-serif'; tctx.textAlign = 'center';
      tctx.fillText(KO[id], x, y - r - 7);
    }
  }
  tc.addEventListener('pointerdown', (ev) => {
    if (!balls) return;
    const p = local(tc, ev);
    let best: BallId | null = null, bd = 40;
    for (const id of BALL_IDS) {
      const [bx, by] = toScreen(balls[id].pos);
      const d = Math.hypot(bx - p.x, by - p.y);
      if (d < bd) { bd = d; best = id; }
    }
    if (!best) return;
    bDrag = { id: best, from: { ...balls[best].pos }, p0: p };
    tc.setPointerCapture(ev.pointerId);
  });
  tc.addEventListener('pointermove', (ev) => {
    if (!bDrag || !balls) return;
    const p = local(tc, ev);
    const k = K * tScale;
    const dx = p.x - bDrag.p0.x, dy = p.y - bDrag.p0.y;
    const mx = vert ? -dy / k : dx / k, my = vert ? -dx / k : -dy / k;
    balls[bDrag.id] = {
      found: true,
      pos: {
        x: Math.min(L - R, Math.max(R, bDrag.from.x + mx)),
        y: Math.min(W - R, Math.max(R, bDrag.from.y + my)),
      },
    };
    drawTop();
  });
  tc.addEventListener('pointerup', () => { bDrag = null; });
  $('phBack').addEventListener('click', () => { show('corners'); requestAnimationFrame(drawCorners); });
  $('phApply').addEventListener('click', () => {
    if (!balls) return;
    onApply({ white: balls.white.pos, yellow: balls.yellow.pos, red: balls.red.pos });
    close();
  });
  addEventListener('resize', () => { if (!root.classList.contains('hidden')) { drawCorners(); drawTop(); } });
}

// 테스트용 내부 함수 노출
export const _test = { homography, cameraModel, detectBalls, apply };
