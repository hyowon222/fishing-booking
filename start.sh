#!/bin/sh
set -e

export NODE_ENV=production
export BACKEND_PORT="${BACKEND_PORT:-5001}"
export BASE_PATH="${BASE_PATH:-/}"

# API 서버는 내부 포트에서만 열고 외부에 노출하지 않음
PORT="$BACKEND_PORT" pnpm --filter @workspace/api-server run start &

# 빌드된 정적 파일을 가벼운 프리뷰 서버로 서빙, /api는 위 백엔드로 프록시
pnpm --filter @workspace/boat-fishing-lookup run serve
