// 이의제기(피드백) 수집 API — Vercel 서버리스 함수
//  POST /api/feedback : 이의제기 1건 저장
//  GET  /api/feedback : 수집 데이터 내보내기 (Authorization: Bearer $FEEDBACK_ADMIN_TOKEN)
// 저장소: Postgres (Vercel Marketplace 의 Neon 연결 시 DATABASE_URL 자동 주입)
import { neon } from '@neondatabase/serverless';

const MAX_BODY = 32_000;
const BALLS = ['white', 'yellow', 'red'];
const REASONS = ['better', 'hard', 'physics', 'other'];
const RESULTS = ['untested', 'scored', 'missed'];
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
    recommended jsonb,
    disputed_rank int,
    rec_mode text,
    user_shot jsonb not null,
    user_sim jsonb,
    reason text not null,
    actual_result text not null,
    comment text,
    physics jsonb,
    user_agent text
  )`;
  ready = true;
}

const num = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const str = (v: unknown, max: number) => v === undefined || v === null || (typeof v === 'string' && v.length <= max);

function validate(b: any): string | null {
  if (!b || typeof b !== 'object') return 'body';
  if (b.kind !== 'dispute') return 'kind';
  if (!b.layout || !BALLS.every((id) => num(b.layout[id]?.x, 0, L) && num(b.layout[id]?.y, 0, W))) return 'layout';
  if (!BALLS.includes(b.cue)) return 'cue';
  const s = b.userShot;
  if (!s || !num(s.angleDeg, 0, 360) || !num(s.speed, 0.1, 10) || !num(s.tipX, -1, 1) || !num(s.tipY, -1, 1)) return 'userShot';
  if (!REASONS.includes(b.reason)) return 'reason';
  if (!RESULTS.includes(b.actualResult)) return 'actualResult';
  if (!str(b.comment, 500) || !str(b.clientId, 64) || !str(b.appVersion, 40) || !str(b.recMode, 10)) return 'text';
  if (b.recommended !== undefined && (!Array.isArray(b.recommended) || b.recommended.length > 10)) return 'recommended';
  if (b.disputedRank !== undefined && b.disputedRank !== null && !num(b.disputedRank, -1, 10)) return 'disputedRank';
  return null;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

export async function POST(req: Request) {
  const sql = db();
  if (!sql) return json({ ok: false, error: 'storage_not_configured' }, 503);
  const text = await req.text();
  if (text.length > MAX_BODY) return json({ ok: false, error: 'too_large' }, 413);
  let b: any;
  try { b = JSON.parse(text); } catch { return json({ ok: false, error: 'invalid_json' }, 400); }
  const bad = validate(b);
  if (bad) return json({ ok: false, error: `invalid_${bad}` }, 400);
  await ensureTable(sql);
  const j = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
  const rows = await sql`insert into feedback
    (kind, client_id, app_version, layout, cue, recommended, disputed_rank, rec_mode, user_shot, user_sim,
     reason, actual_result, comment, physics, user_agent)
    values (${b.kind}, ${b.clientId ?? null}, ${b.appVersion ?? null}, ${j(b.layout)}::jsonb, ${b.cue},
     ${j(b.recommended)}::jsonb, ${b.disputedRank ?? null}, ${b.recMode ?? null}, ${j(b.userShot)}::jsonb,
     ${j(b.userSim)}::jsonb, ${b.reason}, ${b.actualResult}, ${b.comment || null}, ${j(b.physics)}::jsonb,
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
  const rows = await sql`select * from feedback order by id desc limit 5000`;
  return json({ ok: true, count: rows.length, rows });
}
