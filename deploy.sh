#!/bin/bash

APP_NAME="next-app"

echo "🛑 메모리 확보를 위해 기존 서버를 중단합니다."
pm2 stop $APP_NAME || true

# 1. 소스 업데이트
git pull origin main

# 2. 빌드 (가장 메모리를 많이 먹는 구간)
echo "🏗️ 빌드 시작 (메모리 집중 사용)..."
# 팁: 빌드 속도를 위해 .next 폴더를 비우고 시작할 수도 있습니다.
npm run build

# 3. 서버 다시 시작
echo "🚀 서버를 다시 시작합니다."
pm2 start npm --name "$APP_NAME" -- start

echo "✅ 배포 완료!"
pm2 list