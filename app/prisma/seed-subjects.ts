import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SYSTEM_SUBJECTS = [
  {
    slug: 'cs-basics',
    name: 'CS 기초',
    nameEn: 'CS Basics',
    description: '운영체제, 네트워크, 자료구조, 알고리즘 등 컴퓨터 과학 기초',
    icon: 'Cpu',
    topics: [
      { name: '운영체제', difficulty: 'INTERMEDIATE', keyPoints: ['프로세스 vs 스레드', '메모리 관리', '스케줄링', '동기화'] },
      { name: '네트워크', difficulty: 'INTERMEDIATE', keyPoints: ['TCP/UDP', 'HTTP/HTTPS', 'DNS', 'OSI 7계층'] },
      { name: '자료구조', difficulty: 'BEGINNER', keyPoints: ['배열 vs 연결리스트', '스택/큐', '트리', '해시테이블'] },
      { name: '알고리즘', difficulty: 'INTERMEDIATE', keyPoints: ['시간복잡도', '정렬', '탐색', 'DP', '그래프'] },
      { name: '데이터베이스 기초', difficulty: 'INTERMEDIATE', keyPoints: ['SQL', '인덱스', '정규화', '트랜잭션', 'ACID'] },
    ],
  },
  {
    slug: 'javascript',
    name: 'JavaScript',
    nameEn: 'JavaScript',
    description: 'JavaScript 핵심 개념과 고급 패턴',
    icon: 'Code',
    topics: [
      { name: '실행 컨텍스트와 클로저', difficulty: 'INTERMEDIATE', keyPoints: ['스코프 체인', '렉시컬 환경', '클로저 활용', 'this 바인딩'] },
      { name: '프로토타입과 상속', difficulty: 'INTERMEDIATE', keyPoints: ['프로토타입 체인', 'Object.create', 'class 문법', '상속 패턴'] },
      { name: '비동기 처리', difficulty: 'INTERMEDIATE', keyPoints: ['Promise', 'async/await', '이벤트 루프', '마이크로태스크'] },
      { name: 'ES6+ 문법', difficulty: 'BEGINNER', keyPoints: ['구조분해', '스프레드', '모듈 시스템', '옵셔널 체이닝'] },
      { name: '이벤트 루프', difficulty: 'ADVANCED', keyPoints: ['콜 스택', '태스크 큐', '마이크로태스크 큐', '렌더링 타이밍'] },
      { name: '타입과 형변환', difficulty: 'INTERMEDIATE', keyPoints: ['원시 타입', '참조 타입', '암묵적 변환', '동등 비교'] },
    ],
  },
  {
    slug: 'react',
    name: 'React',
    nameEn: 'React',
    description: 'React 라이브러리 핵심 개념과 패턴',
    icon: 'Atom',
    topics: [
      { name: 'React Hooks', difficulty: 'INTERMEDIATE', keyPoints: ['useState', 'useEffect', 'useRef', 'useCallback', 'useMemo'] },
      { name: '상태 관리', difficulty: 'INTERMEDIATE', keyPoints: ['Context API', 'Redux', 'Zustand', '서버 상태 vs 클라이언트 상태'] },
      { name: '렌더링 최적화', difficulty: 'ADVANCED', keyPoints: ['React.memo', 'useMemo', 'useCallback', '리렌더링 조건', 'Profiler'] },
      { name: 'Virtual DOM', difficulty: 'INTERMEDIATE', keyPoints: ['diffing 알고리즘', 'reconciliation', 'key prop', 'fiber'] },
      { name: '컴포넌트 패턴', difficulty: 'INTERMEDIATE', keyPoints: ['HOC', 'render props', '합성 컴포넌트', '제어/비제어 컴포넌트'] },
      { name: 'React 생명주기', difficulty: 'BEGINNER', keyPoints: ['마운트/업데이트/언마운트', 'useEffect 클린업', 'Strict Mode'] },
    ],
  },
  {
    slug: 'nextjs',
    name: 'Next.js',
    nameEn: 'Next.js',
    description: 'Next.js 프레임워크 핵심 개념',
    icon: 'Globe',
    topics: [
      { name: 'App Router', difficulty: 'INTERMEDIATE', keyPoints: ['라우팅 규칙', 'layout/page/loading', '병렬 라우트', '인터셉트 라우트'] },
      { name: 'SSR/SSG/ISR', difficulty: 'INTERMEDIATE', keyPoints: ['서버 컴포넌트', '클라이언트 컴포넌트', '정적 생성', '증분 재생성'] },
      { name: '서버 컴포넌트', difficulty: 'ADVANCED', keyPoints: ['서버/클라이언트 경계', '직렬화 제약', 'use client', '스트리밍'] },
      { name: '데이터 페칭', difficulty: 'INTERMEDIATE', keyPoints: ['fetch 캐싱', 'revalidate', 'Server Actions', 'Route Handlers'] },
      { name: '미들웨어와 인증', difficulty: 'INTERMEDIATE', keyPoints: ['미들웨어 실행 위치', '쿠키/세션', 'NextAuth 통합'] },
    ],
  },
  {
    slug: 'typescript-advanced',
    name: 'TypeScript 심화',
    nameEn: 'TypeScript Advanced',
    description: 'TypeScript 고급 타입 시스템과 패턴',
    icon: 'FileCode',
    topics: [
      { name: '제네릭', difficulty: 'INTERMEDIATE', keyPoints: ['타입 매개변수', '제약 조건', '조건부 타입', 'infer'] },
      { name: '유틸리티 타입', difficulty: 'INTERMEDIATE', keyPoints: ['Partial', 'Pick', 'Omit', 'Record', 'Exclude'] },
      { name: '타입 가드', difficulty: 'INTERMEDIATE', keyPoints: ['typeof', 'instanceof', 'in', '사용자 정의 타입 가드'] },
      { name: '고급 타입', difficulty: 'ADVANCED', keyPoints: ['매핑된 타입', '템플릿 리터럴', '재귀 타입', 'branded 타입'] },
      { name: '타입 추론', difficulty: 'INTERMEDIATE', keyPoints: ['as const', 'satisfies', '타입 좁히기', '분별 유니온'] },
    ],
  },
  {
    slug: 'database-advanced',
    name: '데이터베이스 심화',
    nameEn: 'Database Advanced',
    description: 'DB 설계, 쿼리 최적화, 분산 시스템',
    icon: 'Database',
    topics: [
      { name: '인덱스 설계', difficulty: 'INTERMEDIATE', keyPoints: ['B-Tree', '복합 인덱스', '커버링 인덱스', '인덱스 스캔 종류'] },
      { name: '쿼리 최적화', difficulty: 'ADVANCED', keyPoints: ['EXPLAIN', '실행 계획', '조인 전략', 'N+1 문제'] },
      { name: '트랜잭션과 격리', difficulty: 'INTERMEDIATE', keyPoints: ['ACID', '격리 수준', '데드락', 'MVCC'] },
      { name: '정규화와 모델링', difficulty: 'INTERMEDIATE', keyPoints: ['정규형', '반정규화', 'ERD', '다대다 관계'] },
      { name: 'NoSQL', difficulty: 'INTERMEDIATE', keyPoints: ['문서형', '키-값', 'CAP 정리', 'eventual consistency'] },
    ],
  },
  {
    slug: 'devops',
    name: 'DevOps',
    nameEn: 'DevOps',
    description: 'Docker, CI/CD, 클라우드, 인프라',
    icon: 'Container',
    topics: [
      { name: 'Docker', difficulty: 'INTERMEDIATE', keyPoints: ['이미지 vs 컨테이너', 'Dockerfile', '레이어 캐싱', 'docker-compose'] },
      { name: 'CI/CD', difficulty: 'INTERMEDIATE', keyPoints: ['파이프라인', 'GitHub Actions', '자동 테스트', '블루-그린 배포'] },
      { name: 'Cloud', difficulty: 'INTERMEDIATE', keyPoints: ['AWS/GCP 핵심 서비스', 'VPC', 'IAM', '오토스케일링'] },
      { name: '모니터링과 로깅', difficulty: 'INTERMEDIATE', keyPoints: ['메트릭', '로그 수집', '알람', 'APM'] },
      { name: 'Kubernetes', difficulty: 'ADVANCED', keyPoints: ['Pod/Service/Deployment', '오케스트레이션', 'Helm', 'Ingress'] },
    ],
  },
];

async function seed() {
  console.log('Seeding subjects and topics...');

  for (const subjectData of SYSTEM_SUBJECTS) {
    const existing = await prisma.subject.findUnique({ where: { slug: subjectData.slug } });
    if (existing) {
      console.log(`  Skip: ${subjectData.name} (already exists)`);
      continue;
    }

    const subject = await prisma.subject.create({
      data: {
        slug: subjectData.slug,
        name: subjectData.name,
        nameEn: subjectData.nameEn,
        description: subjectData.description,
        icon: subjectData.icon,
        isSystem: true,
      },
    });

    await prisma.topic.createMany({
      data: subjectData.topics.map(t => ({
        subjectId: subject.id,
        name: t.name,
        difficulty: t.difficulty as 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED',
        keyPoints: t.keyPoints,
      })),
    });

    console.log(`  Created: ${subjectData.name} (${subjectData.topics.length} topics)`);
  }

  console.log('Done!');
}

seed()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
