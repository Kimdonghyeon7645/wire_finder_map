#!/bin/bash

# 1. 환경 변수 설정
APP_NAME="next-app"
LOG_FILE="./deploy.log"

echo "🚀 배포를 시작합니다: $(date)" | tee -a $LOG_FILE

# 2. 최신 코드 가져오기
echo "📥 Git Pull 실행 중..."
git pull origin main | tee -a $LOG_FILE

# 3. 의존성 설치 (패키지 변경이 있을 때만 실행해도 되지만, 안전을 위해 실행)
echo "📦 npm 패키지 설치 중..."
npm install | tee -a $LOG_FILE

# 4. Next.js 빌드 (이 과정에서 메모리 부족 시 중단될 수 있음)
echo "🏗️ Next.js 빌드 시작..."
npm run build | tee -a $LOG_FILE

# 5. PM2 프로세스 확인 및 무중단 재시작 (reload)
# 이미 실행 중이면 reload, 없으면 새로 start
pm2 describe $APP_NAME > /dev/null
if [ $? -eq 0 ]; then
  echo "♻️ 기존 프로세스를 무중단 재시작(reload)합니다."
  pm2 reload $APP_NAME
else
  echo "🟢 새 프로세스를 시작합니다."
  pm2 start npm --name "$APP_NAME" -- start
fi

# 6. 결과 확인
echo "✅ 배포가 완료되었습니다!"
pm2 list