# 미리Q (MiriQ) 인수인계 문서

> 3쿠션 당구 샷 예측·추천 웹앱. 실제 공 배치를 앱에 옮기면 득점 가능한 샷을 추천하고, 시뮬레이션으로 경로를 보여주며, 사용자 피드백을 모아 예측을 개선하는 것이 목표.
> 마지막 업데이트: 2026-10-06 (이전 대화 세션에서 작성)

---

## 0. 바로 알아야 할 것

| 항목 | 값 |
|---|---|
| 운영 주소 | https://miri-q.vercel.app |
| 관리자 페이지 | https://miri-q.vercel.app/admin (비밀번호 = Vercel 환경 변수 `FEEDBACK_ADMIN_TOKEN`, 사용자가 직접 등록함) |
| GitHub | `Cheetozzeong/MiriQ` (개인 저장소), 기본 브랜치 `main` |
| 배포 | Vercel 프로젝트 `miri-q` (팀 `cheetozzeong's projects`, Hobby). **`main`에 푸시하면 자동 배포** (보통 20~40초) |
| DB | Neon Postgres `miriq-db` (Vercel Storage로 연결, Free, iad1). `DATABASE_URL` 자동 주입 |
| 로컬 폴더 | `~/Aidit/MiriQ` (주의: 상위 `~/Aidit`도 별도 git 저장소이고 무관한 변경이 있음 → **MiriQ 안에서만 git 작업**) |
| 안드로이드 앱 | WebView 앱 "미리Q" (`android/`), 최신 1.1.0 (versionCode 2). APK는 `release/` (git 제외) |

---

## 1. 사용자와 일하는 방식 (중요)

- **한국어**로 대화. 결과 보고는 간결하게, 무엇을 바꿨고 무엇을 확인했는지/못했는지 정직하게.
- 요청을 받으면 **구현 → 확인 → 커밋 → 푸시(=배포) → 배포 확인**까지 한 번에 진행하는 것을 선호. ("바로 배포까지")
- 사용자가 직접 **QC**함. 모바일(특히 iPhone Safari 세로 + 큰 화면 모드) 사용성에 민감 → UI 변경은 반드시 휴대폰 크기(375×812)로 확인.
- 대화 중에 추가 요청을 연달아 보내는 편. 진행 중인 작업과 묶어서 처리하고 끝에 한꺼번에 정리해 보고.
- 커밋 메시지: 영어 제목 + 본문 요약, 마지막 줄 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **비밀값(토큰·비밀번호)은 에이전트가 직접 입력하지 않음.** 사용자가 Vercel 등에 직접 넣도록 안내. (Neon 약관 동의는 사용자 승인 후 진행했었음)
- 외부 서비스 계정 생성/OAuth 동의/결제는 사용자가 직접.

---

## 2. 기술 스택 / 명령어

- Vite 5 + TypeScript (프레임워크 없음, 바닐라 DOM). 멀티 페이지: `index.html`(앱), `admin.html`(관리자).
- 서버: Vercel 함수 `api/feedback.ts` (Web 표준 `GET/POST/PATCH(Request)` export), Neon HTTP 드라이버 `@neondatabase/serverless`.
- `vercel.json`: `{ "cleanUrls": true }` → `/admin`이 `admin.html`로.

```bash
npm install
npm run build                 # tsc --noEmit && vite build (index + admin)
PORT=5174 npx vite --strictPort --host 127.0.0.1   # 로컬 개발 서버 (vite.config가 PORT 환경 변수 사용)
# API 타입 검사 (src 밖이라 별도)
npx tsc --noEmit --strict --module esnext --moduleResolution bundler --target es2022 --lib es2022,dom --types node --skipLibCheck api/feedback.ts
```

- 로컬에는 `/api`가 없음 (Vercel CLI 미설치, 로그인 필요) → 피드백은 기기 큐(localStorage)에 쌓임. API는 배포 후 운영에서 `curl`로 확인.
- 배포 확인 패턴: 새 번들 JS/CSS에 이번 변경의 고유 문자열이 들어갔는지 `curl`로 반복 확인.
- 개발 모드 전용 디버그 훅: 브라우저 콘솔에서 `window.__state()` → `{ layout, shot, candidates }`.

---

## 3. 파일 지도

| 파일 | 역할 |
|---|---|
| `src/physics.ts` | 물리 엔진. 미끄럼/구름/회전 마찰, 쿠션 반발(접점 높이·회전 영향), 공-공 충돌(스로우), 스쿼트. **충돌 시점(TOI) 보정**, 에너지 가지치기, 3쿠션 판정, 초구/1적구 규칙, 실력별 오차 모델(`SKILL`), 테이블 상태(`TABLE_SPEED`), `scanShot`/`quickScore`/`robustness`/`layoutEase`/`perturb` |
| `src/analysis.ts` | 샷 요약(`summarize`: 두께·맞는 쪽·빈쿠션 1쿠션 지점·이동거리), 난이도 점수/배지, 경로 형태 라벨(돌리기/대회전/빈쿠션/더블/리버스/가로지르기), 실전 표기(`howTo`: 두께·당점 시계·힘 1~5) |
| `src/jobs.ts` | 계산 작업 (워커/메인 공용): `scan`(각도 탐색), `eval`(확률+정밀 검증+요약), `pos`(후구·수비). `bestNextShot`(후구용 축소 추천 엔진) |
| `src/worker.ts` | 워커 진입점 (jobs.ts 호출만) |
| `src/ranges.ts` | 연속 득점 각도 구간 찾기 |
| `src/systems.ts` | 다이아몬드 시스템 (거울 반사 기하 + 파이브앤하프 환산 + 물리 보정) |
| `src/photo.ts` | 사진으로 배치 입력: 촬영 가이드, 카메라, 코너 4점 → 호모그래피, 초점거리/자세 추정, 공 중심 높이(z=R) 평면 정사영, 색 기반 공 인식, 위에서 본 화면에서 수정 |
| `src/main.ts` | **앱 UI 전부** (~1900줄): 캔버스 렌더, 입력/드래그/돋보기, 레이아웃 모드, 추천 흐름·카드, 안내 카드, 결과 기록, 피드백 5지점, 이의제기, 워커 풀 등 |
| `src/style.css` | 앱 스타일 (데스크톱/세로 시트/와이드 모드) |
| `src/admin.ts`, `src/admin.css`, `admin.html` | 관리자 검토 페이지 |
| `api/feedback.ts` | 피드백 저장/조회/검토 API |
| `index.html` | 앱 마크업 |
| `android/` | WebView 앱 (`MainActivity.java`: 전체화면, 화면 꺼짐 방지, 방향 브리지, 카메라·파일 선택 권한) |
| `vite.config.ts` | PORT, `__APP_VERSION__`(Vercel 커밋 해시), 멀티 페이지 입력 |

> 기술 부채: `main.ts`가 너무 큼. 다음 큰 작업 전에 모듈 분리(렌더러 / 추천 / 피드백 / 레이아웃) 권장.

---

## 4. 핵심 로직 요약

### 4-1. 물리/판정 (`physics.ts`)
- 좌표: 미터, 원점 왼쪽 아래, x=장축(0~2.84), y=단축(0~1.42). 다이아몬드 1개 = 0.355m. 공 반지름 R=0.03075.
- 표시용 시뮬레이션 dt=0.5ms, 탐색용 `QUICK_DT`=1.5ms (+TOI 보정, 가지치기). 득점 판정 일치율 확인 후 정한 값.
- **3쿠션 쿠션 인정 규칙**: 초속 3cm 미만 스침 제외 / 같은 쿠션 0.12초 내 재접촉(레일 타기)은 1회 / 공과 부딪힌 직후 10ms·2cm 이내 쿠션 접촉 제외 / 한 스텝 안 접촉은 시간순 처리. 이벤트에 `counted` 플래그.
- **1적구 지정** `shot.firstBall`: 다른 공 먼저 맞히면 실패.
- **초구 규칙** `shot.opening`: main.ts `isOpeningLayout()`이 배치로 자동 판정(빨간공 풋스팟, 상대공 헤드스팟, 수구 헤드스트링 ±15.24cm). 빨간공을 **쿠션 없이 직접** 먼저 맞혀야 함. 공을 움직이면 자동 해제(1적구도 자동으로 '자동' 복귀).
- 물리 계수 `PHYS`는 **추정치(실측 보정 안 됨)**. 보정은 관리자에서 "AI 반영"으로 표시한 피드백으로 할 예정.

### 4-2. 추천 파이프라인 (`main.ts recommend()` + `jobs.ts`)
1. `MODES.fast`(힘·당점 6종) / `fine`(18종)마다 `scan`: 1° 간격 훑기 → 득점(±0.8°)/아깝게 빗나감(±0.4°) 주변 0.2° 정밀 → 구간 + 직접/빈쿠션 1차 분류. 결과 오는 대로 임시 카드 표시.
2. `eval`: 허용폭 상위 (직접 12 + 빈쿠션 6)개를 실력 오차 30회로 확률, **정밀 시뮬레이션(0.5ms)으로 득점 재확인**(안 되면 ±폭 내 각도 보정, 끝내 안 되면 제외).
3. 순위: `score = w득점·확률 + w후구·후구 + w수비·수비 − w난이도·난이도` (`PRIO` 기준: 득점/후구/수비/균형, '쉬운 샷 우선'이면 난이도 가중↑). **직접 샷 먼저, 빈쿠션 나중**, 확률 5% 미만은 맨 뒤. 경로 형태별 대표 우선.
4. `pos`(상위 4개만): 후구 = 득점 후 멈춘 배치에서 **같은 수구의 다음 샷 최고 성공확률**(`bestNextShot`), 수비 = 실패 샘플 2개 배치에서 상대 수구의 `layoutEase`(득점 경로 수 기반, 아직 구 방식) 역수.
5. 워커 풀 `runPool`: 코어 수만큼 워커, 오류/40초 무응답 시 재시도 → 그래도 실패면 **메인 스레드 폴백**(0%에서 멈추던 버그 대책).
- 주의: 뒤에서 끝나는 계산이 이의제기 중이거나 사용자가 고친 샷을 덮어쓰지 않도록 가드 있음.

### 4-3. 화면 모드 (`applyMode`)
- 데스크톱(>960px): 페이지 스크롤 없음, 오른쪽 탭 패널.
- 세로 휴대폰 `body.portrait`: 테이블 + 오른쪽 아이콘 레일 + **하단 시트 3단계**(min/mid/full, 조정 탭은 half). 재생하면 min으로 접힘.
- 큰 화면 `body.wide`: 휴대폰 기본값(`prefs.bigMode`). 세로 고정 기기에서는 `body.rotated`로 CSS 90° 회전(뒤집기 `rotated-ccw`), 실제 가로면 회전 없음. 오른쪽 레일 + 덮는 서랍. **터치 좌표는 `localXY()`로 회전 역변환** (offsetX는 신뢰 불가).
- 사진 입력 화면은 회전하지 않음(세로 전체화면). 안드로이드 앱은 촬영 중 `setOrientation('portrait')`.
- 추천 탭: 위 = 1적구 선택 + 카드, 아래 = 고정 하단 바(상태 / 기준·⚙·👎이의제기 / ⟳ 추천 받기).
- 모바일 카드: 순위·난이도·득점%·후구·수비·👎만. 설명은 "🎯 이걸로 칠게요" 안내 카드(두께 그림 포함)에서.
- 탐색 중: 테이블에 공만, HUD 숨김, 로딩은 테이블 위쪽.

### 4-4. 사용 흐름
추천 → (◀▶/카드로 비교) → **🎯 이걸로 칠게요** → 안내 카드(겨냥·두께 그림·당점·힘) → **치러 가기**(배너 접힘, "쳤나요? 결과 기록" 표시) → 결과 카드: 득점·비슷함(→ 예상 멈춤 배치로 **뒷공 추천**) / 득점·배치 다름(→ 배치 수정) / 실패(→ 이유 묻기, 상대 차례/다시).

### 4-5. 피드백 수집 (Neon `feedback` 테이블)
| kind | 언제 | 비고 |
|---|---|---|
| `record` | 결과 기록(득점/실패) | |
| `miss_reason` | 실패 후 "왜 빗나갔을까요?" | physics/hard/better |
| `rest_mismatch` | "득점·배치 달라요" 후 공을 맞추면 4초 뒤 자동 | 예상 vs 실제 위치, 공별 오차(m) |
| `override` | 추천 적용 후 직접 바꾼 샷으로 "칠게요" | 이유 칩 선택 가능 |
| `card_dislike` | 카드 👎 + 이유 | **바로 `dispute`(내 샷 제안)로 이어짐** |
| `dispute` | 내 샷 제안 (배치 고정, 방향·힘·당점만) | `data.source`, `linkedId`, `linkedFid`, `recShot` |

- 모든 레코드: layout, cue, shot, recommended(그때 추천 목록 요약), rank, settings(실력/테이블/기준/1적구/초구), physics, app_version, user_agent, `data.fid`(기기 생성 ID, 오프라인 큐 후에도 연결 유지).
- 같은 배치에서 같은 질문은 1번만. 전송 실패 시 localStorage 큐 → 다음 접속 시 재전송.
- 검토 컬럼: `review_status`(pending/approved/hold/rejected), `review_note`, `reviewed_at`.
- DB에 QA 테스트 레코드 1건 존재 (`client_id='qa-claude-test'`, id 1) → 관리자에서 '제외' 처리 권장.

### 4-6. API (`api/feedback.ts`)
- `POST /api/feedback` 저장 (검증 후, 예전 형식 이의제기 자동 변환).
- `GET` (관리자, `Authorization: Bearer $FEEDBACK_ADMIN_TOKEN`): 목록 `?status=&kind=&limit=&offset=` / 상세 `?id=`(+연결 기록) / `?export=approved`.
- `PATCH` (관리자): `{ id | ids[], status, note }` (여러 건 최대 200).
- 테이블/컬럼은 첫 요청 때 `create table if not exists` / `alter ... add column if not exists`로 생성.

### 4-7. 관리자 (`/admin`)
- 목록(상태/종류 필터, 개수, 페이지, **체크박스 일괄 상태 변경 — 같은 버튼 2번 눌러 확정**), 상세(**추천 경로 | 유저 경로 나눠 보기/각각/겹쳐 보기**, 사유·메모·기기·설정·연결 기록·원본), 검토 버튼(저장 후 다음 기록으로), "반영 데이터 내보내기"(JSON).

---

## 5. 안드로이드 앱

- 구조: `https://miri-q.vercel.app/?app=android`를 띄우는 WebView. 웹만 배포하면 앱에도 반영 (네이티브 변경 시에만 재빌드).
- JS 브리지 `window.MiriQApp.setOrientation('landscape' | 'portrait' | 'auto')`.
- 빌드 (이 맥 기준):
  ```bash
  cd android
  export JAVA_HOME=/Library/Java/JavaVirtualMachines/zulu-21.jdk/Contents/Home
  # local.properties: sdk.dir=/opt/homebrew/share/android-commandlinetools  (gitignore됨, 없으면 생성)
  ./gradlew assembleRelease
  cp app/build/outputs/apk/release/app-release.apk ../release/MiriQ-<버전>.apk
  ```
- 서명: 별도 키 없이 **디버그 키**(이 맥의 `~/.android/debug.keystore`). 다른 PC에서 빌드하면 업데이트 설치가 안 됨(서명 불일치) — 사용자는 업데이트 필요 없다고 함.
- 버전 올릴 때 `app/build.gradle.kts`의 `versionCode`/`versionName`.
- iOS 앱은 없음. iOS Safari는 웹에서 화면 방향 고정 불가 → 사용자에게 "화면 세로 고정 + 큰 화면 모드(+뒤집기)" 안내.

---

## 6. 검증 방법 / 도구 팁

- UI 확인: 앱 내장 브라우저(Claude Browser)로 `http://127.0.0.1:5174` → `resize_window`로 mobile(375×812)/1280×800 확인. **이 창은 백그라운드라 rAF/워커가 크게 느려짐** → 속도 수치는 신뢰하지 말고 Node로 측정.
- 사용자 Chrome 확인이 필요하면 Claude in Chrome(새 탭 그룹). 사용자가 열어둔 탭은 직접 못 잡음.
- 물리/엔진 벤치: `esbuild`로 `src/*.ts`를 번들해 Node에서 실행 (스크래치 폴더에 스크립트 작성).
- 사진 인식 검증: 알려진 카메라로 렌더한 합성 이미지로 오차 측정 (이전 결과 1~4cm).
- 관리자 UI: 로컬엔 API가 없으니 `window.fetch`를 가짜 응답으로 바꿔 흐름 확인.

---

## 7. 알려진 한계 / 기술 부채

- 물리 계수 미보정 → 실제와 다를 수 있음 (피드백으로 보정 예정).
- 탐색 속도: Node 기준 조합당 0.3~0.4초, 실제 휴대폰 체감은 미측정. 근본 개선은 **이벤트 기반 물리 엔진**(다음 충돌 시각을 해석적으로 계산) 또는 WASM.
- 수비 지표는 아직 구 방식(`layoutEase`, 득점 경로 수). 후구처럼 `bestNextShot`으로 바꾸면 정확해지나 계산 2배.
- 두께 그림은 접촉 순간 각도 기준 (회전에 의한 휨 미반영).
- 사진 인식은 합성 이미지로만 검증, 실사진 조명/반사 미검증.
- `main.ts` 거대, 일부 잔재 코드(`dSubmit` 안의 `void payload` 등).
- 이전 작업 폴더 `~/Aidit/three-cushion-predictor`(구버전 복사본) 남아 있음 — 사용자 확인 후 삭제 가능.

---

## 8. 다음 할 일 (사용자와 합의된 방향)

1. **회원 기능 + 에버리지 입력** → 실력 단계 자동 설정. 로그인 방식 미정(구글/카카오/이메일 중 사용자 결정 필요). Neon Auth 옵션이 켜져 있음(`VITE_NEON_AUTH_URL` 환경 변수 존재).
2. 관리자에서 "AI 반영"한 데이터로 **물리 계수·순위 가중치 반자동 보정** (후보 계수 계산 → 기존 데이터 적중률 비교 → 승인 → 적용/롤백).
3. 결과 기록·피드백 통계 대시보드(관리자).
4. 성능: 이벤트 기반 엔진, 수비 지표 고도화.
5. 테스트 레코드(id 1) 정리.
