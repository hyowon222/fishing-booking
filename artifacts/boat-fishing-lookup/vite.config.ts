import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error(
    'PORT environment variable is required but was not provided.',
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error(
    'BASE_PATH environment variable is required but was not provided.',
  );
}

// The API server runs as a separate process inside the same Render service,
// listening on an internal port (see the Start Command). The dev/preview
// server proxies /api/* to it so the frontend and backend can share the
// single public PORT Render exposes.
const backendPort = Number(process.env.BACKEND_PORT ?? 5001);

// vite preview(실제로 외부에 노출되는 서버)와 vite dev 서버 둘 다에,
// SITE_AUTH_USER / SITE_AUTH_PASSWORD 환경변수가 설정돼 있으면 HTTP Basic
// 인증을 강제하는 미들웨어를 가장 먼저 끼워넣는다. Vite는 플러그인의
// configureServer / configurePreviewServer 훅 안에서 동기적으로
// server.middlewares.use(...)를 호출하면, Vite 자체의 정적 파일 서빙/프록시
// 미들웨어보다 먼저 실행되도록 등록해준다 — 그래서 인증 없이는 화면도 API
// 프록시도 전혀 통과할 수 없다. 두 환경변수가 없으면(로컬 개발 등) 인증을
// 강제하지 않는다.
function basicAuthPlugin(): Plugin {
  const expectedUser = process.env.SITE_AUTH_USER;
  const expectedPassword = process.env.SITE_AUTH_PASSWORD;

  const middleware = (
    req: import('http').IncomingMessage,
    res: import('http').ServerResponse,
    next: () => void,
  ) => {
    if (!expectedUser || !expectedPassword) {
      next();
      return;
    }

    const header = req.headers['authorization'];
    if (header?.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const separatorIndex = decoded.indexOf(':');
      const providedUser = decoded.slice(0, separatorIndex);
      const providedPassword = decoded.slice(separatorIndex + 1);
      if (providedUser === expectedUser && providedPassword === expectedPassword) {
        next();
        return;
      }
    }

    res.statusCode = 401;
    res.setHeader('WWW-Authenticate', 'Basic realm="fishing-booking"');
    res.end('인증이 필요합니다.');
  };

  return {
    name: 'site-basic-auth',
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
    configureServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig({
  base: basePath,
  plugins: [
    basicAuthPlugin(),
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== 'production' &&
    process.env.REPL_ID !== undefined
      ? [
          await import('@replit/vite-plugin-cartographer').then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, '..'),
            }),
          ),
          await import('@replit/vite-plugin-dev-banner').then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    fs: {
      strict: true,
    },
    proxy: {
      '/api': {
        target: `http://localhost:${backendPort}`,
        changeOrigin: true,
      },
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      '/api': {
        target: `http://localhost:${backendPort}`,
        changeOrigin: true,
      },
    },
  },
});
