# AWS EC2 Docker 배포 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** VoicePrep 서비스를 AWS EC2(서울 리전) + Docker Compose + nginx + Cloudflare로 프로덕션 배포한다.

**Architecture:** EC2 t3.small(서울)에서 Docker Compose로 nginx, Next.js, FastAPI 3개 컨테이너를 운영한다. Cloudflare가 DNS + SSL을 처리하고, nginx는 HTTP로 리버스 프록시만 담당한다. GitHub Actions가 main push 시 Docker 이미지를 빌드하고 EC2에 SSH로 배포한다.

**Tech Stack:** AWS EC2, Docker, Docker Compose, nginx, GitHub Actions, Cloudflare

**현재 상태:**
- `frontend/Dockerfile` — 멀티스테이지 빌드 (development/builder/production) 이미 존재
- `backend/Dockerfile` — Python 3.12 + Node.js(토큰 디코딩용) 이미 존재
- `docker-compose.yml` — 개발용 (nginx 없음, frontend는 development target)
- `.github/workflows/ci.yml` — 프론트엔드 lint/type-check/build만 수행
- Next.js rewrite: `/api/*` (auth 제외) → FastAPI 프록시

**인프라 구성도:**
```
[사용자] ──HTTPS──> [Cloudflare] ──HTTP──> [EC2 t3.small 서울]
                                              │
                                        docker compose
                                              │
                                     ┌────────┼────────┐
                                     │        │        │
                                   nginx    frontend  backend
                                   (:80)    (:3000)   (:8000)
                                     │
                              ┌──────┼──────┐
                              │             │
                        /api/auth/*    /api/*        /*
                           │             │            │
                        frontend      backend     frontend
```

**예상 비용:** ~$11.4/월 (EC2 $10.4 + EBS $1)

---

## Task 1: nginx 설정 파일 생성

**Files:**
- Create: `nginx/nginx.conf`
- Create: `nginx/Dockerfile`

- [ ] **Step 1: nginx Dockerfile 생성**

```dockerfile
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/nginx.conf
EXPOSE 80
```

- [ ] **Step 2: nginx.conf 생성**

```nginx
worker_processes auto;

events {
    worker_connections 1024;
}

http {
    # 기본 설정
    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;
    types_hash_max_size 2048;
    client_max_body_size 20M;

    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    # 로그
    access_log /var/log/nginx/access.log;
    error_log /var/log/nginx/error.log;

    # Gzip 압축
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript image/svg+xml;

    # Rate limiting
    limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;

    # Upstream 정의
    upstream frontend {
        server frontend:3000;
    }

    upstream backend {
        server backend:8000;
    }

    server {
        listen 80;
        server_name reseeall.com www.reseeall.com;

        # Cloudflare에서만 접근 허용을 위한 헤더 확인 (선택적)
        # real_ip_header CF-Connecting-IP;

        # Health check
        location /nginx-health {
            access_log off;
            return 200 "ok";
        }

        # NextAuth API — frontend로 프록시
        location /api/auth {
            proxy_pass http://frontend;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }

        # 나머지 API — backend(FastAPI)로 프록시
        location /api/ {
            limit_req zone=api burst=20 nodelay;
            proxy_pass http://backend;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;

            # SSE 지원 (면접 스트리밍)
            proxy_http_version 1.1;
            proxy_set_header Connection '';
            proxy_buffering off;
            proxy_cache off;
            proxy_read_timeout 300s;
        }

        # 정적 파일 캐싱 (Next.js _next/static)
        location /_next/static {
            proxy_pass http://frontend;
            proxy_cache_valid 200 365d;
            add_header Cache-Control "public, max-age=31536000, immutable";
        }

        # 나머지 전부 — frontend로 프록시
        location / {
            proxy_pass http://frontend;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;

            # WebSocket 지원 (Next.js HMR — 프로덕션에선 불필요하지만 무해)
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
        }
    }
}
```

- [ ] **Step 3: 커밋**

```bash
git add nginx/
git commit -m "feat(infra): nginx 리버스 프록시 설정 추가"
```

---

## Task 2: 프로덕션 Docker Compose 작성

**Files:**
- Create: `docker-compose.prod.yml`
- Modify: `frontend/Dockerfile` (standalone output 설정 확인)

- [ ] **Step 1: frontend next.config.ts에 standalone output 확인**

`frontend/next.config.ts`에 `output: 'standalone'`가 없으면 추가 필요. 기존 Dockerfile의 production 스테이지가 `standalone` 디렉토리를 복사하므로 반드시 필요.

```typescript
const nextConfig: NextConfig = {
  output: 'standalone',
  // ... 기존 설정
};
```

- [ ] **Step 2: docker-compose.prod.yml 생성**

```yaml
services:
  nginx:
    build:
      context: ./nginx
    ports:
      - "80:80"
    depends_on:
      frontend:
        condition: service_started
      backend:
        condition: service_started
    restart: unless-stopped
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

  frontend:
    build:
      context: ./frontend
      target: production
    expose:
      - "3000"
    env_file:
      - ./frontend/.env.production
    environment:
      - NODE_ENV=production
      - BACKEND_URL=http://backend:8000
    restart: unless-stopped
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

  backend:
    build:
      context: ./backend
    expose:
      - "8000"
    env_file:
      - ./backend/.env.production
    environment:
      - ENVIRONMENT=production
    restart: unless-stopped
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

- [ ] **Step 3: .env.production 예제 파일 생성**

`frontend/.env.production.example`:
```env
DATABASE_URL=
DIRECT_URL=
NEXTAUTH_SECRET=
NEXTAUTH_URL=https://reseeall.com
AUTH_TRUST_HOST=true
AUTH_GOOGLE_ID=
AUTH_GOOGLE_SECRET=
NEXT_PUBLIC_TOSS_CLIENT_KEY=
TOSS_SECRET_KEY=
BACKEND_URL=http://backend:8000
```

`backend/.env.production.example`:
```env
DATABASE_URL=
NEXTAUTH_SECRET=
ANTHROPIC_API_KEY=
ENVIRONMENT=production
TAVILY_API_KEY=
OPENAI_API_KEY=
TOSS_SECRET_KEY=
NEXT_PUBLIC_TOSS_CLIENT_KEY=
ADMIN_EMAILS=
```

- [ ] **Step 4: .gitignore에 .env.production 추가**

```
# Production env
frontend/.env.production
backend/.env.production
```

- [ ] **Step 5: 로컬에서 프로덕션 빌드 테스트**

```bash
docker compose -f docker-compose.prod.yml build
```

빌드가 성공하는지 확인. 실행은 .env.production 없이 안 되므로 빌드만 확인.

- [ ] **Step 6: 커밋**

```bash
git add docker-compose.prod.yml frontend/.env.production.example backend/.env.production.example frontend/next.config.ts .gitignore
git commit -m "feat(infra): 프로덕션 docker-compose + env 예제 추가"
```

---

## Task 3: EC2 서버 초기 세팅 스크립트

**Files:**
- Create: `scripts/ec2-init.sh`

- [ ] **Step 1: EC2 초기 설정 스크립트 생성**

EC2 Ubuntu 인스턴스를 처음 세팅할 때 1회 실행하는 스크립트.

```bash
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
# swappiness 낮게 (RAM 우선 사용)
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
```

- [ ] **Step 2: 커밋**

```bash
chmod +x scripts/ec2-init.sh
git add scripts/ec2-init.sh
git commit -m "feat(infra): EC2 초기 세팅 스크립트 추가"
```

---

## Task 4: GitHub Actions 배포 워크플로우

**Files:**
- Create: `.github/workflows/deploy.yml`

- [ ] **Step 1: 배포 워크플로우 생성**

main push 시 EC2에 SSH로 접속해서 pull + 빌드 + 재시작하는 워크플로우.

```yaml
name: Deploy to EC2

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    if: github.event_name == 'workflow_dispatch' || github.event_name == 'push'

    steps:
      - name: Deploy to EC2
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.EC2_HOST }}
          username: ${{ secrets.EC2_USERNAME }}
          key: ${{ secrets.EC2_SSH_KEY }}
          script: |
            cd /opt/voiceprep

            # 최신 코드 pull
            git pull origin main

            # 이미지 빌드 + 무중단 재시작
            docker compose -f docker-compose.prod.yml build
            docker compose -f docker-compose.prod.yml up -d

            # 미사용 이미지 정리
            docker image prune -f

            echo "Deploy complete: $(date)"
```

- [ ] **Step 2: GitHub Secrets 설정 가이드**

GitHub 리포 → Settings → Secrets → Actions에 다음 3개 추가:

| Secret 이름 | 값 |
|---|---|
| `EC2_HOST` | EC2 퍼블릭 IP 또는 도메인 |
| `EC2_USERNAME` | `ubuntu` (Ubuntu AMI 기본) |
| `EC2_SSH_KEY` | EC2 키 페어의 private key (PEM 전체 내용) |

- [ ] **Step 3: 커밋**

```bash
git add .github/workflows/deploy.yml
git commit -m "feat(ci): GitHub Actions EC2 배포 워크플로우 추가"
```

---

## Task 5: Cloudflare DNS 설정 가이드

이 태스크는 코드 변경이 아닌 수동 설정 가이드.

- [ ] **Step 1: Cloudflare에 도메인 추가**

1. Cloudflare 대시보드 → Add Site → `reseeall.com`
2. Free 플랜 선택
3. 도메인 등록기관(현재 사용 중인 곳)에서 네임서버를 Cloudflare가 제공하는 NS로 변경

- [ ] **Step 2: DNS 레코드 추가**

| Type | Name | Content | Proxy |
|------|------|---------|-------|
| A | `@` | EC2 퍼블릭 IP | Proxied (주황 구름) |
| A | `www` | EC2 퍼블릭 IP | Proxied (주황 구름) |

- [ ] **Step 3: SSL 설정**

Cloudflare → SSL/TLS → Overview:
- 모드: **Flexible** (Cloudflare↔EC2는 HTTP)
- Edge Certificates → Always Use HTTPS: **On**
- Automatic HTTPS Rewrites: **On**

- [ ] **Step 4: 캐싱 설정 (선택)**

Cloudflare → Caching:
- Browser Cache TTL: **4 hours**
- Page Rule: `reseeall.com/api/*` → Cache Level: **Bypass** (API는 캐싱 안 함)

---

## Task 6: EC2 인스턴스 생성 가이드

수동 설정 가이드. AWS 콘솔에서 진행.

- [ ] **Step 1: EC2 인스턴스 생성**

1. AWS 콘솔 → EC2 → Launch Instance
2. 설정:
   - **Name:** voiceprep-prod
   - **AMI:** Ubuntu 24.04 LTS (arm64 또는 x86_64)
   - **Instance type:** t3.small
   - **Key pair:** 새로 생성하거나 기존 것 선택 (SSH 접속용)
   - **Network:** 기본 VPC
   - **Storage:** 8GB gp3

- [ ] **Step 2: 보안 그룹 설정**

| Type | Port | Source | 용도 |
|------|------|--------|------|
| SSH | 22 | My IP | SSH 접속 |
| HTTP | 80 | 0.0.0.0/0 | Cloudflare → nginx |

HTTPS(443)는 Cloudflare가 처리하므로 EC2에서 열 필요 없음.

- [ ] **Step 3: Elastic IP 할당**

EC2 → Elastic IPs → Allocate → Associate to instance
- 인스턴스 재시작해도 IP 고정
- 할당 후 반드시 인스턴스에 연결 (미연결 시 $0.005/시간 과금)

- [ ] **Step 4: 서버 초기화**

```bash
ssh -i your-key.pem ubuntu@<EC2_IP>
# ec2-init.sh 스크립트 실행 (Task 3에서 생성한 것)
```

- [ ] **Step 5: 프로젝트 배포**

```bash
# 재접속 (docker 그룹 적용)
ssh -i your-key.pem ubuntu@<EC2_IP>

# 코드 clone
git clone https://github.com/<your-repo>.git /opt/voiceprep
cd /opt/voiceprep

# 환경 변수 설정
cp frontend/.env.production.example frontend/.env.production
cp backend/.env.production.example backend/.env.production
# 실제 값 채우기
nano frontend/.env.production
nano backend/.env.production

# 서비스 시작
docker compose -f docker-compose.prod.yml up -d

# 상태 확인
docker compose -f docker-compose.prod.yml ps
curl http://localhost/nginx-health
```

---

## Task 7: Supabase 자동 정지 방지 (cron ping)

**Files:**
- Create: `.github/workflows/keep-alive.yml`

- [ ] **Step 1: Supabase ping 워크플로우 생성**

Supabase Free는 1주 미사용 시 자동 정지. 6일마다 API 호출로 방지.

```yaml
name: Supabase Keep Alive

on:
  schedule:
    - cron: '0 0 */5 * *'  # 5일마다 자정(UTC)
  workflow_dispatch:

jobs:
  ping:
    runs-on: ubuntu-latest
    steps:
      - name: Ping Supabase
        run: |
          curl -sf "${{ secrets.SUPABASE_HEALTH_URL }}" > /dev/null
          echo "Supabase pinged at $(date)"
        env:
          SUPABASE_HEALTH_URL: ${{ secrets.SUPABASE_HEALTH_URL }}
```

- [ ] **Step 2: GitHub Secret 추가**

| Secret 이름 | 값 |
|---|---|
| `SUPABASE_HEALTH_URL` | Supabase 프로젝트의 REST URL (예: `https://<ref>.supabase.co/rest/v1/?apikey=<anon_key>`) |

- [ ] **Step 3: 커밋**

```bash
git add .github/workflows/keep-alive.yml
git commit -m "feat(ci): Supabase 자동 정지 방지 cron 추가"
```

---

## 실행 순서 요약

```
코드 작업 (Task 1~4, 7):
  1. nginx 설정 생성
  2. docker-compose.prod.yml + env 예제
  3. EC2 초기 세팅 스크립트
  4. GitHub Actions 배포 워크플로우
  7. Supabase keep-alive cron

수동 설정 (Task 5~6):
  6. AWS EC2 인스턴스 생성 + 보안 그룹 + Elastic IP
  6. SSH 접속 → ec2-init.sh 실행 → 프로젝트 배포
  5. Cloudflare DNS + SSL 설정

검증:
  - curl http://<EC2_IP>/nginx-health → "ok"
  - curl https://reseeall.com → 페이지 로드
  - curl https://reseeall.com/api/health → FastAPI 응답
```

## 필요한 GitHub Secrets 전체 목록

| Secret | 용도 |
|--------|------|
| `EC2_HOST` | EC2 퍼블릭 IP |
| `EC2_USERNAME` | `ubuntu` |
| `EC2_SSH_KEY` | SSH private key (PEM) |
| `SUPABASE_HEALTH_URL` | Supabase REST URL + anon key |
