# MiriQ — 에이전트 안내

작업을 시작하기 전에 **`HANDOFF.md`를 먼저 읽으세요.** (구조, 로직, 배포, 사용자와 일하는 방식, 다음 할 일)

핵심 규칙 요약:
- 사용자와는 한국어로. 변경은 구현 → 확인(휴대폰 375×812 포함) → 커밋 → `main` 푸시(Vercel 자동 배포) → 배포 확인까지.
- git 작업은 이 폴더(`~/Aidit/MiriQ`) 안에서만. 상위 `~/Aidit`도 별도 저장소이니 건드리지 말 것.
- 커밋 메시지 끝: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- 비밀값(토큰·비밀번호)은 직접 입력하지 말고 사용자에게 안내.
- 빌드: `npm run build` / 로컬: `PORT=5174 npx vite --strictPort --host 127.0.0.1`
