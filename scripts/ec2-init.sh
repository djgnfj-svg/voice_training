#!/bin/bash
set -euo pipefail

echo "=== VoicePrep EC2 초기 설정 ==="

# 1. 시스템 업데이트
sudo apt-get update && sudo apt-get upgrade -y

# 2. Swap 메모리 설정 (2GB)
echo "--- Swap 설정 ---"
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p

# 3. Docker 설치
echo "--- Docker 설치 ---"
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# 4. 현재 사용자를 docker 그룹에 추가
sudo usermod -aG docker $USER

# 5. 프로젝트 디렉토리 생성
sudo mkdir -p /opt/voiceprep
sudo chown $USER:$USER /opt/voiceprep

# 6. Docker 로그 용량 제한 (전역)
sudo tee /etc/docker/daemon.json > /dev/null <<EOF
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
EOF
sudo systemctl restart docker

echo ""
echo "=== 초기 설정 완료 ==="
echo "1. 로그아웃 후 재접속하세요 (docker 그룹 적용)"
echo "2. /opt/voiceprep 에 프로젝트를 clone하세요"
echo "   git clone https://github.com/<your-repo>.git /opt/voiceprep"
echo "3. .env.production 파일을 생성하세요"
echo "4. docker compose -f docker-compose.prod.yml up -d 로 시작"
