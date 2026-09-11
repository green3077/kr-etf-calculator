#!/bin/bash
# 루트의 웹 소스 파일들을 www/로 동기화하고 android/의 실제 빌드 자산까지 반영한다.
# GitHub Pages는 이 저장소 루트를 그대로 서빙하므로, 웹 코드는 항상 루트 파일을 고쳐야 하고
# (index.html/app.js/style.css/stocks.js), 이 스크립트가 그 결과를 www/에 복사한 뒤
# 'cap copy'로 android/app/src/main/assets/public까지 반영한다 - 이 마지막 단계를 건너뛰면
# gradle이 예전 www/ 내용 그대로 APK를 만들어버린다.
set -e
cd "$(dirname "$0")"

cp index.html style.css app.js stocks.js www/

npx cap copy android

echo "www/ synced for Android build, and copied into android/app/src/main/assets/public via 'cap copy'."
