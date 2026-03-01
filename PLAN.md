# GovBot 실행 계획서 (PLAN.md)

> 작성일: 2026-03-01
> 기반 문서: 정부지원사업_봇_리서치.md

---

## 1. 확정된 프로젝트 방향

### 1.1 한 줄 요약

매일 아침 1회 정부 지원사업 공고를 자동 수집하여 Cloudflare Pages 기반 Fix 보드에 적재하고, 마감된 공고는 자동 삭제하며, AI 요약은 사용자가 개별 공고를 선택했을 때만 온디맨드로 실행한다.

### 1.2 핵심 설계 원칙

- **비용 최소화:** AI 요약을 자동 실행하지 않음. 보드에는 메타정보만 적재하고, 요약은 사용자가 요청할 때만 호출하여 API 비용을 사실상 0에 가깝게 유지.
- **단순한 파이프라인:** GitHub Actions → JSON 파일 갱신 → Cloudflare Pages 자동 배포. 별도 서버, DB 없음.
- **자동 정리:** 마감일이 지난 공고는 스케줄러가 자동으로 삭제하여 보드를 항상 유효한 공고만으로 유지.

---

## 2. 시스템 아키텍처

### 2.1 전체 흐름도

```
[매일 아침 1회 - GitHub Actions cron]
         │
         ▼
[1] 기업마당 API 호출
    → 지원사업 공고 목록 수신 (JSON)
         │
         ▼
[2] 데이터 처리 (Python)
    → 신규 공고 필터링 (기존 데이터와 비교)
    → 마감일 지난 공고 삭제
    → announcements.json 갱신
         │
         ▼
[3] GitHub에 push
    → announcements.json 커밋
         │
         ▼
[4] Cloudflare Pages 자동 빌드 & 배포
    → Fix 보드 UI 갱신 (정적 사이트)
         │
         ▼
[5] 사용자가 보드에서 공고 클릭
    → "AI 요약" 버튼 클릭 시에만 Claude API 호출
    → 요약 결과를 UI에 표시
```

### 2.2 기술 스택

| 레이어 | 기술 | 비용 |
|--------|------|------|
| 스케줄러 | GitHub Actions (cron: 매일 오전 9시 KST) | 무료 |
| 수집 스크립트 | Python 3.11 + requests | 무료 |
| 데이터 소스 | 기업마당 API (bizinfo.go.kr) | 무료 |
| 데이터 저장 | JSON 파일 (GitHub repo 내) | 무료 |
| 프론트엔드 | HTML/CSS/JS (정적 사이트) | 무료 |
| 호스팅 | Cloudflare Pages (GitHub 연동) | 무료 |
| AI 요약 | Claude API (온디맨드) | 건당 ~$0.002 |

### 2.3 레포지토리 구조

```
govbot/
├── .github/
│   └── workflows/
│       └── collect.yml          # GitHub Actions 워크플로우
├── scripts/
│   ├── collect.py               # 메인 수집 스크립트
│   ├── config.json              # 필터 설정 (키워드, 분야, 지역)
│   └── requirements.txt         # Python 의존성
├── site/                        # Cloudflare Pages 빌드 대상
│   ├── index.html               # Fix 보드 메인 UI
│   ├── style.css                # 스타일
│   ├── app.js                   # 프론트엔드 로직 (필터, 요약 호출 등)
│   └── data/
│       └── announcements.json   # 수집된 공고 데이터
├── seen_ids.json                # 중복 체크용 (이미 수집한 공고 ID)
└── README.md
```

---

## 3. 모듈별 상세 계획

### 3.1 수집 모듈 (collect.py)

**실행 주기:** 매일 1회 (KST 오전 9시 = UTC 0시)

**처리 순서:**

1. 기업마당 API 호출 → 전체 공고 목록 수신
2. `seen_ids.json` 로드 → 이미 수집한 공고 ID와 비교
3. 신규 공고만 추출
4. 기존 `announcements.json` 로드
5. 마감일(`신청종료일자`)이 오늘 이전인 공고 삭제
6. 신규 공고를 기존 데이터에 추가
7. `announcements.json` 저장 (site/data/ 경로)
8. `seen_ids.json` 갱신

**각 공고에 저장하는 필드:**

```json
{
  "id": "PBLN_000000000111729",
  "title": "2026년 AI 응용제품 신속 상용화 지원사업",
  "category": "기술",
  "organization": "과학기술정보통신부",
  "executor": "정보통신산업진흥원",
  "startDate": "2026-02-01",
  "endDate": "2026-03-15",
  "registDate": "2026-01-28",
  "detailUrl": "https://www.bizinfo.go.kr/web/lay1/bbs/...",
  "dDay": 14,
  "summary": null
}
```

- `summary`는 초기값 null → 사용자가 요약 요청 시에만 채워짐
- `dDay`는 스크립트 실행 시점 기준으로 매번 재계산

### 3.2 마감 공고 자동 삭제 로직

```python
from datetime import datetime

def cleanup_expired(announcements):
    today = datetime.now().strftime("%Y-%m-%d")
    return [a for a in announcements if a["endDate"] >= today]
```

매 실행 시마다 마감일이 지난 공고를 제거하여 Fix 보드에는 항상 유효한(접수 가능한) 공고만 남긴다.

### 3.3 Fix 보드 UI (Cloudflare Pages)

**핵심 화면 구성:**

```
┌─────────────────────────────────────────────┐
│  GovBot — 정부 지원사업 Fix 보드             │
│                                             │
│  [전체] [금융] [기술] [창업] [경영] ...  필터  │
│  [키워드 검색 _______________]               │
│                                             │
│  ┌─────────────────────────────────────┐    │
│  │ 🔴 D-3  AI 응용제품 상용화 지원사업    │    │
│  │ 과학기술정보통신부 | ~03.15          │    │
│  │ [상세보기] [AI 요약]                 │    │
│  └─────────────────────────────────────┘    │
│  ┌─────────────────────────────────────┐    │
│  │ 🟡 D-14 청년창업사관학교 글로벌과정    │    │
│  │ 중소벤처기업부 | ~03.26             │    │
│  │ [상세보기] [AI 요약]                 │    │
│  └─────────────────────────────────────┘    │
│  ┌─────────────────────────────────────┐    │
│  │ 🟢 D-30 콘텐츠 창작자 지원사업        │    │
│  │ 문화체육관광부 | ~04.11             │    │
│  │ [상세보기] [AI 요약]                 │    │
│  └─────────────────────────────────────┘    │
│                                             │
│  마지막 업데이트: 2026-03-01 09:00 KST      │
└─────────────────────────────────────────────┘
```

**UI 기능:**

- **카드 리스트:** 각 공고를 카드 형태로 표시 (사업명, 소관기관, 마감일, D-day)
- **D-day 색상:** D-3 이하 빨강, D-7 이하 노랑, 그 외 초록
- **분야 필터 탭:** 전체/금융/기술/인력/수출/내수/창업/경영/기타
- **키워드 검색:** 클라이언트 사이드 필터링 (JS)
- **정렬:** 마감일순 (기본), 등록일순
- **[상세보기] 버튼:** 기업마당 원문 공고 페이지로 링크 (새 탭)
- **[AI 요약] 버튼:** 클릭 시 Claude API 호출 → 요약 결과를 카드 하단에 펼침

### 3.4 AI 요약 (온디맨드)

**호출 방식:** 프론트엔드에서 직접 Claude API를 호출하는 것은 API 키 노출 문제가 있으므로, 두 가지 접근법 중 선택.

**방식 A: Cloudflare Workers (추천)**

Cloudflare Pages와 같은 생태계 내에서 서버리스 함수를 만들어 API 키를 안전하게 관리.

```
사용자 클릭 → Cloudflare Worker (프록시) → Claude API → 요약 반환
```

- Cloudflare Workers 무료 플랜: 일 10만 요청, 충분
- API 키를 Workers 환경 변수에 저장 → 프론트에 노출 안 됨

**방식 B: 상세 페이지 크롤링 + 요약을 수집 시점에 미리 처리**

수집 스크립트에서 상세URL 크롤링 → 요약까지 한 번에 처리하고 JSON에 저장. 단, 모든 공고를 요약하면 비용 발생하므로 필터 매칭된 공고만 처리.

**방식 A를 기본으로 채택.** 방식 B는 비용 부담 없이 특정 분야만 자동 요약하고 싶을 때 Phase 3에서 추가 고려.

### 3.5 GitHub Actions 워크플로우

```yaml
name: GovBot Collector
on:
  schedule:
    - cron: '0 0 * * *'     # 매일 UTC 0시 = KST 오전 9시
  workflow_dispatch:          # 수동 실행 가능

jobs:
  collect:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - name: Install dependencies
        run: pip install -r scripts/requirements.txt

      - name: Run collector
        env:
          BIZINFO_API_KEY: ${{ secrets.BIZINFO_API_KEY }}
        run: python scripts/collect.py

      - name: Commit & push updated data
        run: |
          git config user.name 'govbot'
          git config user.email 'govbot@github.com'
          git add site/data/announcements.json seen_ids.json
          git diff --cached --quiet || (git commit -m "📋 공고 업데이트 $(date +%Y-%m-%d)" && git push)
```

push가 발생하면 Cloudflare Pages가 자동으로 빌드 & 배포.

---

## 4. 구현 로드맵

### Phase 1: 파이프라인 MVP (Week 1)

수집 → 보드 표시까지의 최소 동작 파이프라인 완성.

| 작업 | 상세 | 산출물 |
|------|------|--------|
| 사전 준비 | 기업마당 API 키 발급, GitHub repo 생성 | API 키, 레포지토리 |
| 수집 스크립트 | API 호출 → JSON 파싱 → 신규 필터링 → 마감 삭제 → JSON 저장 | `collect.py` |
| GitHub Actions | cron 워크플로우 설정, Secrets 등록 | `collect.yml` |
| Fix 보드 UI | 정적 HTML/JS — JSON 읽어서 카드 리스트 렌더링 | `index.html`, `app.js` |
| Cloudflare Pages | GitHub 연동, 빌드 설정 (site/ 디렉토리) | 배포 URL |
| 테스트 | 수동 실행(workflow_dispatch)으로 전체 파이프라인 확인 | 동작하는 보드 |

**Phase 1 완료 기준:** 매일 아침 자동으로 공고가 수집되어 Cloudflare Pages 보드에 표시되고, 마감 지난 공고는 사라진다.

### Phase 2: 필터 & AI 요약 (Week 2~3)

보드의 실용성을 높이는 기능 추가.

| 작업 | 상세 | 산출물 |
|------|------|--------|
| 분야 필터 | 카테고리 탭 (금융/기술/창업 등) | UI 필터 탭 |
| 키워드 검색 | 클라이언트 사이드 텍스트 검색 | 검색 입력창 |
| 정렬 옵션 | 마감일순, 등록일순 토글 | 정렬 버튼 |
| Cloudflare Worker | Claude API 프록시 함수 배포 | Worker 스크립트 |
| AI 요약 버튼 | 공고별 "AI 요약" 클릭 → Worker 호출 → 결과 표시 | 요약 UI 컴포넌트 |
| 상세 크롤링 | Worker 내에서 상세URL 본문 추출 → Claude에 전달 | 크롤링 로직 |

**Phase 2 완료 기준:** 보드에서 분야별 필터링/검색이 가능하고, 관심 공고를 클릭하면 AI가 요약해준다.

### Phase 3: 고도화 (Week 4~)

| 작업 | 상세 |
|------|------|
| 매칭 필터 | config.json 기반 관심 키워드/분야 사전 필터링 → 매칭된 공고 하이라이트 표시 |
| D-day 강조 | 마감 임박 공고(D-3 이하) 상단 고정 + 시각적 강조 |
| 보조금24 연동 | 2차 데이터 소스 추가, 중복 제거 로직 포함 |
| 디자인 개선 | 모바일 반응형, 다크모드 등 |
| 알림 연동 (선택) | Discord Webhook으로 신규 공고 건수 요약 알림 (일 1회) |

---

## 5. 비용 요약 (확정)

| 항목 | 비용 | 비고 |
|------|------|------|
| 기업마당 API | 무료 | 공공데이터 |
| GitHub Actions | 무료 | 하루 1회, 수 분 소요 |
| Cloudflare Pages | 무료 | 무료 플랜 (월 500회 빌드) |
| Cloudflare Workers | 무료 | 무료 플랜 (일 10만 요청) |
| Claude API (요약) | 월 $0~1 | 온디맨드만, 하루 0~5건 예상 |
| **총 운영비** | **월 $0~1** | |

리서치 시점의 예상(월 $3~10)에서 크게 절감. 보드에 메타정보만 적재하고 AI 요약을 온디맨드로 전환한 것이 핵심.

---

## 6. 사전 준비 체크리스트

| # | 항목 | 소요 | 상태 |
|---|------|------|------|
| 1 | 기업마당 API 인증키 발급 (bizinfo.go.kr → 정책정보 개방 → 사용신청) | 1~2시간 | ⬜ |
| 2 | Anthropic Claude API 키 발급 (console.anthropic.com) | 10분 | ⬜ |
| 3 | GitHub 저장소 생성 (`govbot`) | 5분 | ⬜ |
| 4 | GitHub Secrets 등록 (`BIZINFO_API_KEY`) | 5분 | ⬜ |
| 5 | Cloudflare 계정 생성 & Pages 프로젝트 연결 | 15분 | ⬜ |
| 6 | Cloudflare Workers 환경 변수에 Claude API 키 등록 (Phase 2) | 10분 | ⬜ |

---

## 7. 리스크 & 대응

| 리스크 | 영향도 | 대응 |
|--------|--------|------|
| 기업마당 API 일시 장애 | 중 | retry 로직 (3회 재시도, 5초 간격). 실패 시 이전 데이터 유지 |
| API 응답 형식 변경 | 중 | JSON 파싱에 방어 코드 추가. 필드 누락 시 skip 처리 |
| GitHub Actions cron 지연 | 저 | 하루 1회라 5~15분 지연은 무의미. workflow_dispatch로 수동 보완 가능 |
| 상세 크롤링 차단 | 저 | Phase 2에서만 해당. User-Agent 설정, 요청 간격 준수. 차단 시 요약 없이 원문 링크만 제공 |
| Cloudflare 무료 한도 초과 | 극저 | 하루 1회 빌드, 요약 요청 수건. 한도의 1%도 안 씀 |

---

## 8. 의사결정 로그

리서치 이후 확정된 사항 기록.

| 항목 | 리서치 시점 | 확정 |
|------|------------|------|
| 수집 빈도 | 하루 2회 | **하루 1회** (아침) |
| 알림 방식 | Discord/Telegram 실시간 알림 | **Cloudflare Pages Fix 보드** |
| AI 요약 시점 | 수집 시 자동 요약 | **온디맨드** (사용자 클릭 시) |
| 마감 공고 처리 | 별도 언급 없음 | **자동 삭제** |
| 월 예상 비용 | $3~10 | **$0~1** |

---

## 9. 다음 액션

Phase 1 시작을 위해, 아래 순서로 진행:

1. **기업마당 API 키 발급** ← 승인 대기 시간이 있으므로 가장 먼저
2. **GitHub repo 생성 & 기본 구조 세팅**
3. **collect.py 작성 & 로컬 테스트**
4. **Fix 보드 UI 제작**
5. **GitHub Actions 워크플로우 설정**
6. **Cloudflare Pages 연결 & 배포**
