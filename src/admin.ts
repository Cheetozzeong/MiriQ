// 미리Q 관리자: 사용자 피드백(👎·내 샷 제안·실패 이유 등) 목록/상세 + AI 반영 여부 검토
import './admin.css';
import { DIAMOND, KO, TABLE, BALL, simulate, type BallId, type Layout, type Pos, type Shot } from './physics';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const R = BALL.R;
const COLORS: Record<BallId, string> = { white: '#f7f7f2', yellow: '#f4c430', red: '#d9262c' };
const KIND_KO: Record<string, string> = {
  dispute: '내 샷 제안', card_dislike: '추천 👎', override: '추천 대신 내 샷', miss_reason: '실패 이유', rest_mismatch: '멈춤 위치 차이', record: '결과 기록',
};
const REASON_KO: Record<string, string> = {
  physics: '예측이 실제와 다름', hard: '치기 어려움', better: '더 좋은 길이 있음', wrong_path: '이 길 아님', other: '기타',
};
const STATUS_KO: Record<string, string> = { pending: '미검토', approved: 'AI 반영', hold: '보류', rejected: '제외' };
const RESULT_KO: Record<string, string> = { scored: '득점', missed: '실패', untested: '안 쳐봄' };
const SOURCE_KO: Record<string, string> = { button: '이의제기 버튼', nudge: '"마음에 드는 추천 없음" 배너', dislike: '추천 👎 후', miss: '실패 후', card: '카드에서' };

// ───────── 인증 ─────────
const TOKEN_KEY = 'miriq.adminToken';
const getToken = () => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } };
const setToken = (t: string) => { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* 무시 */ } };
async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`/api/feedback${path}`, { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${getToken()}`, 'content-type': 'application/json' } });
  const body = await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }));
  if (res.status === 401) { showLogin('비밀번호가 맞지 않습니다'); throw new Error('unauthorized'); }
  if (res.status === 503 && body.error === 'admin_token_not_configured') { showLogin('서버에 관리자 비밀번호(FEEDBACK_ADMIN_TOKEN)가 아직 등록되지 않았습니다'); throw new Error('no_token'); }
  if (!body.ok) throw new Error(body.error || 'error');
  return body;
}
function showLogin(msg = '') {
  $('login').classList.remove('hidden'); $('app').classList.add('hidden');
  $('loginMsg').textContent = msg;
}
$('loginForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  setToken(($('tokenIn') as HTMLInputElement).value.trim());
  start();
});
$('logoutBtn').addEventListener('click', () => { setToken(''); showLogin(); });

// ───────── 기기 정보 (User-Agent 해석) ─────────
function device(ua: string | null) {
  if (!ua) return { short: '알 수 없음', long: '' };
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '기타';
  const app = /Android/.test(ua) && /; wv\)/.test(ua) ? '미리Q 앱' : null;
  const br = app ?? (/SamsungBrowser/.test(ua) ? '삼성 인터넷' : /CriOS|Chrome\//.test(ua) && !/Edg\//.test(ua) ? 'Chrome' : /Edg\//.test(ua) ? 'Edge' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : '브라우저');
  const ver = ua.match(/(?:iPhone OS|Android) ([\d_.]+)/)?.[1]?.replace(/_/g, '.');
  return { short: `${os} · ${br}`, long: `${os}${ver ? ` ${ver}` : ''} · ${br}` };
}
const ago = (iso: string) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return '방금'; if (s < 3600) return `${Math.floor(s / 60)}분 전`; if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return new Date(iso).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
};
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

// ───────── 목록 ─────────
const state = { status: 'pending', kind: '', offset: 0, limit: 30, rows: [] as any[], total: 0, current: 0 };
async function loadList() {
  const p = new URLSearchParams({ limit: String(state.limit), offset: String(state.offset) });
  if (state.status) p.set('status', state.status);
  if (state.kind) p.set('kind', state.kind);
  const body = await api(`?${p}`);
  state.rows = body.rows; state.total = body.total;
  // 상태별 개수 (선택한 종류 기준)
  const cnt: Record<string, number> = { pending: 0, approved: 0, hold: 0, rejected: 0, '': 0 };
  for (const c of body.counts) if (!state.kind || c.kind === state.kind) { cnt[c.review_status] += c.n; cnt[''] += c.n; }
  $('statusSel').querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
    b.classList.toggle('on', b.dataset.v === state.status);
    b.dataset.n = String(cnt[b.dataset.v!] ?? 0);
  });
  $('listInfo').textContent = state.total ? `${state.total}건 중 ${state.offset + 1}–${Math.min(state.offset + state.limit, state.total)}` : '해당하는 기록이 없습니다';
  $('pageInfo').textContent = `${Math.floor(state.offset / state.limit) + 1} / ${Math.max(1, Math.ceil(state.total / state.limit))}`;
  ($('prevPage') as HTMLButtonElement).disabled = state.offset === 0;
  ($('nextPage') as HTMLButtonElement).disabled = state.offset + state.limit >= state.total;
  setTimeout(syncBulk, 0);
  $('rows').innerHTML = state.rows.map((r) => {
    const d = device(r.user_agent);
    return `<li data-id="${r.id}" class="${r.id === state.current ? 'on' : ''}${selected.has(r.id) ? ' sel' : ''}">
      <input type="checkbox" class="ck" data-check="${r.id}"${selected.has(r.id) ? ' checked' : ''} aria-label="#${r.id} 선택" />
      <div class="r1"><b>#${r.id}</b><span class="kind k-${r.kind}">${KIND_KO[r.kind] ?? r.kind}</span><span class="st st-${r.review_status}">${STATUS_KO[r.review_status]}</span><span class="t">${ago(r.created_at)}</span></div>
      <div class="r2">${r.reason ? esc(REASON_KO[r.reason] ?? r.reason) : r.result ? esc(RESULT_KO[r.result] ?? r.result) : '—'}${r.comment ? ` · “${esc(r.comment).slice(0, 40)}”` : ''}</div>
      <div class="r3">${esc(d.short)}${r.source ? ` · ${esc(SOURCE_KO[r.source] ?? r.source)}` : ''}</div>
    </li>`;
  }).join('');
}
$('rows').addEventListener('click', (ev) => {
  const t = ev.target as HTMLElement;
  const ck = t.closest<HTMLInputElement>('[data-check]');
  if (ck) { // 체크박스: 선택만 (상세는 열지 않음)
    const id = Number(ck.dataset.check);
    if (ck.checked) selected.add(id); else selected.delete(id);
    ck.closest('li')!.classList.toggle('sel', ck.checked);
    syncBulk();
    return;
  }
  const li = t.closest<HTMLElement>('li[data-id]');
  if (li) loadDetail(Number(li.dataset.id));
});

// ───────── 여러 개 한 번에 상태 지정 ─────────
const selected = new Set<number>();
function syncBulk() {
  const n = selected.size;
  $('bulkN').textContent = `선택 ${n}개`;
  $('bulkBar').querySelectorAll<HTMLButtonElement>('[data-bulk]').forEach((b) => { b.disabled = n === 0; });
  const all = state.rows.length > 0 && state.rows.every((r) => selected.has(r.id));
  ($('checkAll') as HTMLInputElement).checked = all;
}
$('checkAll').addEventListener('change', () => {
  const on = ($('checkAll') as HTMLInputElement).checked;
  for (const r of state.rows) { if (on) selected.add(r.id); else selected.delete(r.id); }
  $('rows').querySelectorAll<HTMLInputElement>('[data-check]').forEach((c) => { c.checked = on; c.closest('li')!.classList.toggle('sel', on); });
  syncBulk();
});
$('bulkBar').querySelectorAll<HTMLButtonElement>('[data-bulk]').forEach((b) => b.addEventListener('click', async () => {
  if (!selected.size) return;
  const st = b.dataset.bulk!;
  if (!confirmBulk(st)) return;
  b.disabled = true;
  const body = await api('', { method: 'PATCH', body: JSON.stringify({ ids: [...selected], status: st }) });
  selected.clear();
  await loadList();
  syncBulk();
  toastAdmin(`${body.updated}개를 '${STATUS_KO[st]}'(으)로 바꿨어요`);
  if (state.current && !state.rows.some((r) => r.id === state.current)) {
    if (state.rows.length) loadDetail(state.rows[0].id);
    else $('detail').innerHTML = '<p class="note a-empty">이 목록의 기록을 모두 처리했어요 👍</p>';
  }
}));
// 브라우저 기본 확인창 대신 같은 버튼을 한 번 더 누르면 실행 (실수 방지)
let armed: string | null = null, armTimer = 0;
function confirmBulk(st: string) {
  if (armed === st) { armed = null; clearTimeout(armTimer); return true; }
  armed = st;
  toastAdmin(`선택한 ${selected.size}개를 '${STATUS_KO[st]}'(으)로 바꾸려면 한 번 더 누르세요`);
  clearTimeout(armTimer); armTimer = window.setTimeout(() => { armed = null; }, 3000);
  return false;
}
function toastAdmin(msg: string) {
  const t = document.createElement('div');
  t.className = 'a-toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}
$('statusSel').addEventListener('click', (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('button');
  if (!b) return;
  state.status = b.dataset.v!; state.offset = 0; loadList();
});
$('kindSel').addEventListener('change', () => { state.kind = ($('kindSel') as HTMLSelectElement).value; state.offset = 0; loadList(); });
$('prevPage').addEventListener('click', () => { state.offset = Math.max(0, state.offset - state.limit); loadList(); });
$('nextPage').addEventListener('click', () => { state.offset += state.limit; loadList(); });

// ───────── 상세 ─────────
type ShotLike = Pick<Shot, 'angleDeg' | 'speed' | 'tipX' | 'tipY'>;
function shotText(s: ShotLike | null | undefined) {
  if (!s) return '—';
  const tip = Math.hypot(s.tipX, s.tipY) < 0.04 ? '중앙' : `좌우 ${(s.tipX / 0.2).toFixed(1)}팁 · 상하 ${(s.tipY / 0.2).toFixed(1)}팁`;
  return `${s.angleDeg.toFixed(1)}° · 힘 ${s.speed.toFixed(2)} · ${tip}`;
}
function drawTable(cv: HTMLCanvasElement, layout: Layout, paths: { pts: Pos[]; color: string; dash?: number[]; width?: number }[], ghosts: { layout: Layout; alpha: number }[] = []) {
  const W = cv.parentElement!.clientWidth, rail = 0.12;
  const S = W / (TABLE.L + 2 * rail), H = (TABLE.W + 2 * rail) * S, dpr = devicePixelRatio || 1;
  cv.width = W * dpr; cv.height = H * dpr; cv.style.width = `${W}px`; cv.style.height = `${H}px`;
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const px = (p: Pos): [number, number] => [(rail + p.x) * S, (rail + TABLE.W - p.y) * S];
  ctx.fillStyle = '#4a2f1b'; ctx.beginPath(); ctx.roundRect(0, 0, W, H, 10); ctx.fill();
  ctx.fillStyle = '#1f62ad'; ctx.fillRect(rail * S, rail * S, TABLE.L * S, TABLE.W * S);
  ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.lineWidth = 1;
  for (let i = 1; i < 8; i++) { const [x] = px({ x: i * DIAMOND, y: 0 }); ctx.beginPath(); ctx.moveTo(x, rail * S); ctx.lineTo(x, (rail + TABLE.W) * S); ctx.stroke(); }
  for (let j = 1; j < 4; j++) { const [, y] = px({ x: 0, y: j * DIAMOND }); ctx.beginPath(); ctx.moveTo(rail * S, y); ctx.lineTo((rail + TABLE.L) * S, y); ctx.stroke(); }
  for (const p of paths) {
    ctx.strokeStyle = p.color; ctx.lineWidth = p.width ?? 2; ctx.setLineDash(p.dash ?? []);
    ctx.beginPath(); p.pts.forEach((q, i) => { const [x, y] = px(q); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
  }
  ctx.setLineDash([]);
  const ball = (p: Pos, id: BallId, alpha: number) => {
    const [x, y] = px(p); ctx.globalAlpha = alpha; ctx.fillStyle = COLORS[id];
    ctx.beginPath(); ctx.arc(x, y, Math.max(R * S, 4), 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.stroke(); ctx.globalAlpha = 1;
  };
  for (const g of ghosts) for (const id of Object.keys(g.layout) as BallId[]) ball(g.layout[id], id, g.alpha);
  for (const id of Object.keys(layout) as BallId[]) ball(layout[id], id, 1);
}
const sim = (r: any, s: ShotLike) => simulate(r.layout, { cue: r.cue, ...s, firstBall: r.settings?.firstBall ?? undefined, opening: !!r.settings?.opening }, { dt: 0.001, maxTime: 20 });

async function loadDetail(id: number) {
  state.current = id;
  $('rows').querySelectorAll('li').forEach((li) => li.classList.toggle('on', Number((li as HTMLElement).dataset.id) === id));
  $('detail').innerHTML = '<p class="note">불러오는 중…</p>';
  const { row: r, linked } = await api(`?id=${id}`);
  const d = device(r.user_agent);
  const recShot: ShotLike | null = r.data?.recShot ?? (r.rank >= 0 && r.recommended?.[r.rank]) ?? null;
  const userShot: ShotLike | null = r.shot ?? null;
  const paths: Parameters<typeof drawTable>[2] = [];
  const lines: string[] = [];
  let ghosts: Parameters<typeof drawTable>[3] = [];
  let drawLayout: Layout = r.layout;
  // 나눠 보기용: 각 샷의 수구 경로(진하게) + 적구 경로(옅게)
  const fullPaths = (sr: ReturnType<typeof sim>, color: string, dash?: number[]) => [
    ...(['white', 'yellow', 'red'] as BallId[]).filter((b) => b !== r.cue).map((b) => ({ pts: sr.paths[b], color: COLORS[b] + '99', dash: [4, 4], width: 1.2 })),
    { pts: sr.paths[r.cue as BallId], color, dash, width: 2.5 },
  ];
  let recSim: ReturnType<typeof sim> | null = null, userSim: ReturnType<typeof sim> | null = null;
  if (r.kind === 'rest_mismatch') {
    // 예상 멈춤 위치(반투명) vs 사용자가 맞춘 실제 위치
    drawLayout = r.data.actual;
    ghosts = [{ layout: r.data.predicted, alpha: 0.35 }];
    const err = r.data.errorM ?? {};
    lines.push(`예상과 실제 차이: ${(['white', 'yellow', 'red'] as BallId[]).map((b) => `${KO[b]} ${((err[b] ?? 0) * 100).toFixed(1)}cm`).join(' · ')}`);
    for (const b of ['white', 'yellow', 'red'] as BallId[]) paths.push({ pts: [r.data.predicted[b], r.data.actual[b]], color: '#f5b942', dash: [3, 3], width: 1.5 });
  } else {
    const showRec = recShot && (!userShot || Math.abs(recShot.angleDeg - userShot.angleDeg) > 0.05 || recShot.speed !== userShot.speed || recShot.tipX !== userShot.tipX);
    if (showRec) {
      const sr = sim(r, recShot!);
      recSim = sr;
      paths.push({ pts: sr.paths[r.cue as BallId], color: '#3fa7ff', dash: [6, 4] });
      lines.push(`<span class="lg lg-rec"></span>추천 샷: ${shotText(recShot)} → <b>${sr.outcome.scored ? '득점' : '실패'}</b> 예상`);
    }
    if (userShot) {
      const su = sim(r, userShot);
      userSim = su;
      paths.push({ pts: su.paths[r.cue as BallId], color: '#ff8a3d', width: 2.5 });
      lines.push(`<span class="lg lg-user"></span>${r.kind === 'record' || r.kind === 'miss_reason' ? '친 샷' : '사용자 샷'}: ${shotText(userShot)} → <b>${su.outcome.scored ? '득점' : '실패'}</b> 예상 <span class="note">(${esc(su.outcome.reason)})</span>`);
    }
  }
  const linkedHtml = linked.length
    ? linked.map((l: any) => `<button class="link" data-goto="${l.id}">#${l.id} ${KIND_KO[l.kind]}${l.reason ? ` · ${REASON_KO[l.reason] ?? l.reason}` : ''} (${STATUS_KO[l.review_status]})</button>`).join(' ')
    : '없음';
  const recs = (r.recommended ?? []) as any[];
  $('detail').innerHTML = `
    <div class="d-head">
      <h2>#${r.id} <span class="kind k-${r.kind}">${KIND_KO[r.kind] ?? r.kind}</span> <span class="st st-${r.review_status}">${STATUS_KO[r.review_status]}</span></h2>
      <span class="note">${new Date(r.created_at).toLocaleString('ko-KR')}</span>
    </div>
    ${recSim && userSim ? `<div class="d-view"><div class="seg" id="viewSel">
        <button data-v="split">나눠 보기</button><button data-v="rec">추천 경로</button><button data-v="user">유저 경로</button><button data-v="overlay">겹쳐 보기</button>
      </div></div>` : ''}
    <div class="d-tables" id="dTables"></div>
    <div class="d-lines">${lines.map((l) => `<div>${l}</div>`).join('')}</div>
    <dl class="d-kv">
      <dt>사유</dt><dd>${r.reason ? esc(REASON_KO[r.reason] ?? r.reason) : '—'}${r.data?.linkedReason ? ` <span class="note">(👎 원래 이유: ${esc(REASON_KO[r.data.linkedReason] ?? r.data.linkedReason)})</span>` : ''}</dd>
      <dt>결과</dt><dd>${r.result ? esc(RESULT_KO[r.result] ?? r.result) : '—'}</dd>
      <dt>메모</dt><dd>${r.comment ? esc(r.comment) : '—'}</dd>
      <dt>시작 위치</dt><dd>${r.data?.source ? esc(SOURCE_KO[r.data.source] ?? r.data.source) : '—'}</dd>
      <dt>추천 순위</dt><dd>${r.rank !== null && r.rank !== undefined && r.rank >= 0 ? `${r.rank + 1}번째 추천` : '—'}</dd>
      <dt>수구 · 1적구</dt><dd>${KO[r.cue as BallId] ?? r.cue}${r.settings?.opening ? ' · 초구 규칙' : r.settings?.firstBall ? ` · 1적구 ${KO[r.settings.firstBall as BallId]}` : ''}</dd>
      <dt>설정</dt><dd>${r.settings ? esc(`실력 ${r.settings.skill ?? '-'} · 테이블 ${r.settings.table ?? '-'} · 기준 ${r.settings.priority ?? '-'} · 탐색 ${r.settings.recMode ?? '-'}`) : '—'}</dd>
      <dt>기기</dt><dd>${esc(d.long)} <span class="note">· 앱 버전 ${esc(r.app_version ?? '-')} · 사용자 ${esc((r.client_id ?? '').slice(0, 8))}</span></dd>
      <dt>연결된 기록</dt><dd>${linkedHtml}</dd>
    </dl>
    ${recs.length ? `<details class="d-recs"><summary>그때 보여준 추천 ${recs.length}개</summary><ol>${recs.map((c, i) => `<li${i === r.rank ? ' class="hl"' : ''}>${shotText(c)} · 득점 ${Math.round((c.prob ?? 0) * 100)}%${c.position !== null && c.position !== undefined ? ` · 후구 ${Math.round(c.position * 100)}%` : ''}${c.level ? ` · ${esc(c.level)}` : ''}${c.pattern ? ` · ${esc(c.pattern)}` : ''}</li>`).join('')}</ol></details>` : ''}
    <details class="d-raw"><summary>원본 데이터</summary><pre>${esc(JSON.stringify({ ...r, physics: undefined }, null, 2))}</pre></details>
    <div class="d-review">
      <h3>AI 학습에 반영할까요?</h3>
      <textarea id="revNote" rows="2" maxlength="1000" placeholder="(선택) 검토 메모 — 예: 실제로는 쿠션 반발이 더 약함">${esc(r.review_note ?? '')}</textarea>
      <div class="rev-btns">
        <button data-st="approved" class="ok">✓ AI 반영</button>
        <button data-st="hold">보류</button>
        <button data-st="rejected" class="bad">✗ 제외</button>
        <button data-st="pending" class="ghost">미검토로</button>
      </div>
      <p class="note">저장하면 목록의 다음 기록으로 넘어갑니다${r.reviewed_at ? ` · 마지막 검토 ${new Date(r.reviewed_at).toLocaleString('ko-KR')}` : ''}</p>
    </div>`;
  // 경로 보기: 추천 vs 유저 (선택은 기억)
  const userLabel = r.kind === 'record' || r.kind === 'miss_reason' ? '실제로 친 샷' : '유저가 제안한 경로';
  const renderView = (v: string) => {
    const box = $('dTables');
    const fig = (id: string, cap: string) => `<figure><figcaption>${cap}</figcaption><canvas id="${id}"></canvas></figure>`;
    if (recSim && userSim && v !== 'overlay') {
      const capR = `<span class="lg lg-rec"></span><b>추천 경로</b> · ${recSim.outcome.scored ? '득점' : '실패'} 예상`;
      const capU = `<span class="lg lg-user"></span><b>${userLabel}</b> · ${userSim.outcome.scored ? '득점' : '실패'} 예상`;
      box.className = `d-tables${v === 'split' ? ' split' : ''}`;
      box.innerHTML = v === 'split' ? fig('cRec', capR) + fig('cUser', capU) : v === 'rec' ? fig('cRec', capR) : fig('cUser', capU);
      if (v !== 'user') drawTable($<HTMLCanvasElement>('cRec'), drawLayout, fullPaths(recSim, '#3fa7ff', [6, 4]));
      if (v !== 'rec') drawTable($<HTMLCanvasElement>('cUser'), drawLayout, fullPaths(userSim, '#ff8a3d'));
    } else {
      box.className = 'd-tables';
      box.innerHTML = fig('cAll', recSim && userSim ? '<b>겹쳐 보기</b> · 파랑 점선 = 추천, 주황 = 유저' : '');
      drawTable($<HTMLCanvasElement>('cAll'), drawLayout, paths, ghosts);
    }
    $('detail').querySelectorAll<HTMLButtonElement>('#viewSel button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  };
  const savedView = (() => { try { return localStorage.getItem('miriq.adminView') || 'split'; } catch { return 'split'; } })();
  renderView(savedView);
  $('detail').querySelector('#viewSel')?.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!b) return;
    try { localStorage.setItem('miriq.adminView', b.dataset.v!); } catch { /* 무시 */ }
    renderView(b.dataset.v!);
  });
  $('detail').querySelectorAll<HTMLElement>('[data-goto]').forEach((b) => b.addEventListener('click', () => loadDetail(Number(b.dataset.goto))));
  $('detail').querySelectorAll<HTMLButtonElement>('[data-st]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    await api('', { method: 'PATCH', body: JSON.stringify({ id: r.id, status: b.dataset.st, note: ($('revNote') as HTMLTextAreaElement).value.trim() }) });
    const idx = state.rows.findIndex((x) => x.id === r.id);
    const next = state.rows[idx + 1]?.id;
    await loadList();
    if (next) loadDetail(next);
    else if (state.rows.length) loadDetail(state.rows[0].id);
    else $('detail').innerHTML = '<p class="note a-empty">검토할 기록을 모두 확인했어요 👍</p>';
  }));
}

// ───────── 내보내기 (AI 반영) ─────────
$('exportBtn').addEventListener('click', async () => {
  const body = await api('?export=approved');
  const blob = new Blob([JSON.stringify(body.rows, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `miriq-approved-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

async function start() {
  if (!getToken()) { showLogin(); return; }
  try {
    await loadList();
    $('login').classList.add('hidden'); $('app').classList.remove('hidden');
    if (state.rows.length) loadDetail(state.rows[0].id);
  } catch { /* showLogin 에서 처리 */ }
}
start();
