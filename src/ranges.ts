export interface ScanRange { angleDeg: number; width: number }

// 연속 성공 각도 구간 → 후보 (구간이 넓을수록 실수에 관대). 360°→0° 이어지는 구간도 하나로 합침
export function findRanges(ok: ArrayLike<number>, step: number): ScanRange[] {
  const n = ok.length;
  const ranges: ScanRange[] = [];
  if (!n) return ranges;
  let start = 0;
  if (ok[0] && ok[n - 1]) { while (start < n && ok[start]) start++; if (start === n) return [{ angleDeg: 0, width: 360 }]; }
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    if (!ok[i]) continue;
    let len = 1;
    while (k + len < n && ok[(start + k + len) % n]) len++;
    ranges.push({ angleDeg: (((i + (len - 1) / 2) * step) % 360), width: len * step });
    k += len - 1;
  }
  return ranges;
}
