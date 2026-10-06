// 피드백 수집 API — Vercel 서버리스 함수 (저장소: Neon Postgres, DATABASE_URL 자동 주입)
//  POST /api/feedback : 피드백 1건 저장
//  GET  /api/feedback : 수집 데이터 내보내기 (Authorization: Bearer $FEEDBACK_ADMIN_TOKEN)
//
// kind (피드백 종류)
//  record        : 실제로 친 결과 (득점/실패)
//  miss_reason   : 실패 후 "왜 빗나갔을까요?" 응답
//  rest_mismatch : 득점 후 예상 멈춤 위치 vs 사용자가 맞춘 실제 위치
//  override      : 추천을 적용한 뒤 직접 바꾼 샷으로 "이걸로 칠게요"
//  card_dislike  : 추천 카드 👎 와 이유
//  dispute       : "내 샷 제안하기" (배치 고정, 방향·힘·당점만 바꿔 제안)
import { neon } from '@neondatabase/serverless';

const MAX_BODY = 48_000;
const BALLS = ['white', 'yellow', 'red'];
const KINDS = ['record', 'miss_reason', 'rest_mismatch', 'override', 'card_dislike', 'dispute'];
const REASONS = ['physics', 'hard', 'better', 'wrong_path', 'other'];
const RESULTS = ['scored', 'missed', 'untested'];
const L = 2.84, W = 1.42;

const db = () => (process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null);

let ready = false;
async function ensureTable(sql: NonNullable<ReturnType<typeof db>>) {
  if (ready) return;
  await sql`create table if not exists feedback (
    id bigserial primary key,
    created_at timestamptz not null default now(),
    kind text not null,
    client_id text,
    app_version text,
    layout jsonb not null,
    cue text not null,
    shot jsonb,
    recommended jsonb,
    rank int,
    reason text,
    result text,
    comment text,
    data jsonb,
    settings jsonb,
    physics jsonb,
    user_agent text
  )`;
  await sql`create index if not exists feedback_kind_created on feedback (kind, created_at desc)`;
  ready = true;
}

const num = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const str = (v: unknown, max: number) => v === undefined || v === null || (typeof v === 'string' && v.length <= max);
const validShot = (s: any) => s && num(s.angleDeg, 0, 360) && num(s.speed, 0.1, 10) && num(s.tipX, -1, 1) && num(s.tipY, -1, 1);
const validLayout = (l: any) => l && BALLS.every((id) => num(l[id]?.x, 0, L) && num(l[id]?.y, 0, W));

// 예전 형식(기기에 보관돼 있던 이의제기)을 새 형식으로
function normalize(b: any) {
  if (b && b.userShot && !b.shot) {
    b.shot = b.userShot; b.result = b.actualResult; b.rank = b.disputedRank;
    b.data = { ...(b.data ?? {}), userSim: b.userSim };
    b.settings = { ...(b.settings ?? {}), recMode: b.recMode };
    if (b.reason === 'other' || REASONS.includes(b.reason)) { /* 그대로 */ } else b.reason = 'other';
  }
  return b;
}

function validate(b: any): string | null {
  if (!b || typeof b !== 'object') return 'body';
  if (!KINDS.includes(b.kind)) return 'kind';
  if (!validLayout(b.layout)) return 'layout';
  if (!BALLS.includes(b.cue)) return 'cue';
  if (b.shot !== undefined && b.shot !== null && !validShot(b.shot)) return 'shot';
  if (['record', 'override', 'dispute', 'miss_reason'].includes(b.kind) && !validShot(b.shot)) return 'shot';
  if (b.reason !== undefined && b.reason !== null && !REASONS.includes(b.reason)) return 'reason';
  if (['miss_reason', 'card_dislike', 'dispute'].includes(b.kind) && !b.reason) return 'reason';
  if (b.result !== undefined && b.result !== null && !RESULTS.includes(b.result)) return 'result';
  if (b.kind === 'record' && !b.result) return 'result';
  if (b.kind === 'rest_mismatch' && (!validLayout(b.data?.predicted) || !validLayout(b.data?.actual))) return 'data';
  if (!str(b.comment, 500) || !str(b.clientId, 64) || !str(b.appVersion, 40)) return 'text';
  if (b.recommended !== undefined && b.recommended !== null && (!Array.isArray(b.recommended) || b.recommended.length > 10)) return 'recommended';
  if (b.rank !== undefined && b.rank !== null && !num(b.rank, -1, 20)) return 'rank';
  return null;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

export async function POST(req: Request) {
  const sql = db();
  if (!sql) return json({ ok: false, error: 'storage_not_configured' }, 503);
  const text = await req.text();
  if (text.length > MAX_BODY) return json({ ok: false, error: 'too_large' }, 413);
  let b: any;
  try { b = normalize(JSON.parse(text)); } catch { return json({ ok: false, error: 'invalid_json' }, 400); }
  const bad = validate(b);
  if (bad) return json({ ok: false, error: `invalid_${bad}` }, 400);
  await ensureTable(sql);
  const j = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));
  const rows = await sql`insert into feedback
    (kind, client_id, app_version, layout, cue, shot, recommended, rank, reason, result, comment, data, settings, physics, user_agent)
    values (${b.kind}, ${b.clientId ?? null}, ${b.appVersion ?? null}, ${j(b.layout)}::jsonb, ${b.cue},
     ${j(b.shot)}::jsonb, ${j(b.recommended)}::jsonb, ${b.rank ?? null}, ${b.reason ?? null}, ${b.result ?? null},
     ${b.comment || null}, ${j(b.data)}::jsonb, ${j(b.settings)}::jsonb, ${j(b.physics)}::jsonb,
     ${(req.headers.get('user-agent') ?? '').slice(0, 200)})
    returning id`;
  return json({ ok: true, id: rows[0].id });
}

export async function GET(req: Request) {
  const token = process.env.FEEDBACK_ADMIN_TOKEN;
  if (!token || req.headers.get('authorization') !== `Bearer ${token}`) return json({ ok: false, error: 'unauthorized' }, 401);
  const sql = db();
  if (!sql) return json({ ok: false, error: 'storage_not_configured' }, 503);
  await ensureTable(sql);
  const kind = new URL(req.url).searchParams.get('kind');
  const rows = kind
    ? await sql`select * from feedback where kind = ${kind} order by id desc limit 5000`
    : await sql`select * from feedback order by id desc limit 5000`;
  return json({ ok: true, count: rows.length, rows });
}
