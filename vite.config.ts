import { defineConfig } from 'vite';

export default defineConfig({
  // PORT 환경 변수가 있으면 그 포트로 개발 서버 실행 (기본 5173)
  server: { port: Number(process.env.PORT) || 5173 },
  // 이의제기 데이터에 어떤 버전(물리 계수)으로 계산했는지 남기기 위한 커밋 해시
  define: { __APP_VERSION__: JSON.stringify((process.env.VERCEL_GIT_COMMIT_SHA || 'dev').slice(0, 7)) },
});
