import { defineConfig } from 'vite';

// PORT 환경 변수가 있으면 그 포트로 개발 서버 실행 (기본 5173)
export default defineConfig({
  server: { port: Number(process.env.PORT) || 5173 },
});
