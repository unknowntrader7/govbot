# GovBot 실행 계획서 (PLAN.md)

> 최종 수정: 2026-03-02
> v2 — 3채널 확장 (지원사업 + 공모사업 + 입찰/조달)

---

## 1. 프로젝트 방향

### 1.1 한 줄 요약

정부 지원사업·공모사업·입찰/조달 공고를 매일 자동 수집하여 Cloudflare Pages 보드에 3탭으로 표시하고, AI 요약은 사용자 API 키로 온디맨드 실행한다.

### 1.2 3개 채널

| 채널 | 성격 | 데이터 소스 | 규모 |
|------|------|-------------|------|
| **지원사업** | 보조금/지원금 지급 | 기업마당 + 보조금24 | 수백만~수천만 |
| **공모사업** | 사업계획 제출→선정→위탁수행 | NTIS + 기업마당 공모분류 | 수천만~수십억 |
| **입찰/조달** | 정부가 필요한 것을 구매 | 나라장터(G2B) | 수천만~수백억 |

### 1.3 핵심 설계 원칙

- **비용 $0:** 서버 없음. GitHub Actions + Cloudflare Pages + JSON 파일. AI 요약은 사용자 자기 API 키 사용
- **채널 독립:** 각 채널이 별도 스크립트·데이터·seen_ids. 하나 죽어도 나머지 영향 없음
- **공통 모듈:** 지역필터, D-day, API retry 등은 common.py에서 공유

---

## 2. 시스템 아키텍처

### 2.1 전체 흐름도

```
[매일 아침 - GitHub Actions cron (평일만, 공휴일 제외)]
         │
    ┌────┼────┐
    ▼    ▼    ▼
 [지원사업] [공모사업] [입찰/조달]
 collect_  collect_  collect_
 support   grants    bids
    │        │        │
    ▼        ▼        ▼
 support  grants    bids
 .json    .json     .json
    │        │        │
    └────┬───┘────────┘
         ▼
    git push → Cloudflare Pages 자동 배포
         │
         ▼
    사용자가 보드에서 탭 전환 → 해당 JSON 로드
    공고 클릭 → AI 요약 (사용자 API 키, 온디맨드)
```

### 2.2 기술 스택

| 레이어 | 기술 | 비용 |
|--------|------|------|
| 스케줄러 | GitHub Actions (cron: 평일 09:00 KST) | 무료 |
| 수집 스크립트 | Python 3.11 + requests | 무료 |
| 데이터 소스 | 기업마당 + 보조금24 + 나라장터 + NTIS | 무료 (공공 API) |
| 데이터 저장 | JSON 파일 × 3 (채널별 분리) | 무료 |
| 프론트엔드 | 바닐라 HTML/CSS/JS (정적 사이트) | 무료 |
| 호스팅 | Cloudflare Pages (GitHub 연동) | 무료 |
| AI 요약 | Gemini / ChatGPT / Claude (사용자 브라우저에서 직접 호출) | 사용자 부담 |

### 2.3 레포지토리 구조

```
govbot/
├── .github/workflows/
│   └── collect.yml              # GitHub Actions (3개 스크립트 순차 실행)
├── scripts/
│   ├── common.py                # 공통 유틸리티 모듈
│   ├── config.json              # 채널별 설정
│   ├── collect_support.py       # 지원사업 수집 (기업마당 + 보조금24)
│   ├── collect_grants.py        # 공모사업 수집 (NTIS + 기업마당 공모분류)
│   ├── collect_bids.py          # 입찰/조달 수집 (나라장터 G2B)
│   └── requirements.txt
├── site/                        # Cloudflare Pages 빌드 대상
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   └── data/
│       ├── support.json         # 지원사업 데이터
│       ├── grants.json          # 공모사업 데이터
│       └── bids.json            # 입찰/조달 데이터
├── seen_ids/
│   ├── support.json
│   ├── grants.json
│   └── bids.json
├── CLAUDE.md
└── PLAN.md
```

---

## 3. 채널별 상세

### 3.1 지원사업 (기존, 리팩토링)

**소스:** 기업마당 API + 보조금24 API
**출력:** `site/data/support.json`

스키마 (현행 유지):
```json
{
  "id": "PBLN_000000000111729",
  "title": "사업명",
  "category": "기술",
  "organization": "소관기관",
  "executor": "수행기관",
  "startDate": "2026-02-01",
  "endDate": "2026-03-15",
  "registDate": "2026-01-28",
  "detailUrl": "https://...",
  "dDay": 14,
  "summary": null,
  "source": "bizinfo"
}
```

필터:
- 지역: config에서 설정 (현재 "서울")
- 중앙부처 판별: `is_central_government()` (패턴 + 화이트리스트)
- 제외 기관: config의 `exclude_organizations`

### 3.2 입찰/조달 (신규)

**소스:** 나라장터(G2B) 입찰공고 API (data.go.kr)
**출력:** `site/data/bids.json`

스키마 (추가 필드):
```json
{
  "id": "bid_20260301001",
  "title": "XX시스템 구축 용역",
  "category": "용역",
  "organization": "수요기관",
  "budget": 150000000,
  "bidType": "일반경쟁",
  "industry": "소프트웨어개발",
  "startDate": "2026-03-01",
  "endDate": "2026-03-15",
  "registDate": "2026-03-01",
  "detailUrl": "https://...",
  "dDay": 14,
  "source": "g2b"
}
```

필터: 업종, 최소금액, 지역

### 3.3 공모사업 (신규)

**소스:**
- NTIS 과제공모 API (국가 R&D)
- 기업마당 데이터 중 공모 성격 분류 (제목에 "공모", "모집", "선정", "참여기업" 포함)

**출력:** `site/data/grants.json`

스키마 (추가 필드):
```json
{
  "id": "ntis_202603001",
  "title": "2026년 AI 융합 혁신사업 공모",
  "category": "R&D",
  "organization": "과학기술정보통신부",
  "budget": 500000000,
  "selectionCount": 10,
  "startDate": "2026-03-01",
  "endDate": "2026-04-15",
  "registDate": "2026-03-01",
  "detailUrl": "https://...",
  "dDay": 44,
  "source": "ntis"
}
```

---

## 4. config.json 구조

```json
{
  "common": {
    "regions": ["서울"],
    "include_organizations": []
  },
  "support": {
    "enabled": true,
    "keywords": [],
    "categories": [],
    "exclude_organizations": [
      "국방부", "방위사업청", "병무청", "외교부", "대검찰청",
      "법무부", "국세청", "관세청", "조달청", "인사혁신처",
      "통일부", "국방전직교육원"
    ]
  },
  "bids": {
    "enabled": true,
    "industries": ["SW", "용역", "정보통신"],
    "min_budget": 10000000
  },
  "grants": {
    "enabled": true,
    "keywords": ["AI", "콘텐츠", "디지털", "SW"]
  }
}
```

---

## 5. 프론트엔드 UI

```
┌──────────────────────────────────────────┐
│  GovBot                          🌙  ⚙️  │
│                                          │
│  ┌──────┐ ┌──────┐ ┌────────┐            │
│  │지원사업│ │공모사업│ │입찰/조달│  ← 메인 탭  │
│  └──────┘ └──────┘ └────────┘            │
│                                          │
│  [카테고리 필터]  [검색]  [정렬]            │
│                                          │
│  ■ 마감 임박 (D-3 이하)                    │
│  ┌────────────────────────────┐          │
│  │ 카드 리스트 (탭별 레이아웃)    │          │
│  │ · 입찰: 예정가격 표시         │          │
│  │ · 공모: 지원규모/선정수 표시   │          │
│  └────────────────────────────┘          │
│                                          │
│  설정: 관심 키워드, AI 요약 (Gemini/GPT/  │
│        Claude — 사용자 API 키, localStorage)│
└──────────────────────────────────────────┘
```

- 탭 클릭 시 해당 채널 JSON만 lazy load
- 카테고리 필터는 탭별로 다른 옵션
- 다크모드, 관심 키워드 하이라이트, 모바일 반응형 유지

---

## 6. 구현 로드맵

### Phase 1 — MVP + 지원사업 (완료)

| 작업 | 상태 |
|------|------|
| 기업마당 + 보조금24 수집 스크립트 | ✅ |
| GitHub Actions 워크플로우 (평일, 공휴일 제외) | ✅ |
| 지역 필터 (시/도 매칭 + 중앙부처 판별) | ✅ |
| 제외 기관 필터 | ✅ |
| Fix 보드 UI (카드, 필터, 검색, 정렬) | ✅ |
| 다크모드, D-day 긴급 섹션, 관심 키워드 하이라이트 | ✅ |
| AI 요약 설정 UI (Gemini/ChatGPT/Claude 탭, API 키 입력) | ✅ |
| 모바일 반응형 | ✅ |
| Cloudflare Pages 연결 | ⬜ |

### Phase 2 — 아키텍처 리팩토링

| 작업 | 상태 |
|------|------|
| collect.py → common.py + collect_support.py 분리 | ⬜ |
| config.json 구조 개편 (채널별 설정) | ⬜ |
| seen_ids 디렉토리 분리 | ⬜ |
| announcements.json → support.json 이름 변경 | ⬜ |
| GitHub Actions workflow 업데이트 | ⬜ |

### Phase 3 — 입찰/조달 채널 추가

| 작업 | 상태 |
|------|------|
| 나라장터 API 키 발급 (data.go.kr) | ⬜ |
| collect_bids.py 구현 | ⬜ |
| 프론트엔드 탭 UI 추가 | ⬜ |
| 입찰 카드 레이아웃 (예정가격, 업종 표시) | ⬜ |

### Phase 4 — 공모사업 채널 추가

| 작업 | 상태 |
|------|------|
| NTIS API 조사 + 키 발급 | ⬜ |
| collect_grants.py 구현 | ⬜ |
| 기업마당 공모 분류 로직 | ⬜ |
| 공모 카드 레이아웃 (지원규모, 선정수 표시) | ⬜ |

### Phase 5 — 고도화

| 작업 | 상태 |
|------|------|
| AI 요약 실제 연동 (프론트엔드 API 호출) | ⬜ |
| 지원사업 필터 강화 (키워드/카테고리 축소) | ⬜ |
| 알림 연동 (Discord Webhook, 선택) | ⬜ |

---

## 7. API 정보

### 기업마당 API (지원사업)
- URL: `https://www.bizinfo.go.kr/uss/rss/bizinfoApi.do`
- 인증: `crtfcKey` 파라미터
- Secrets: `BIZINFO_API_KEY`

### 보조금24 API (지원사업)
- URL: `https://api.odcloud.kr/api/gov24/v3/serviceList`
- 인증: `serviceKey` 파라미터
- Secrets: `GOV24_API_KEY`

### 나라장터 API (입찰/조달)
- URL: data.go.kr 입찰공고정보서비스
- 인증: `serviceKey` 파라미터
- Secrets: `G2B_API_KEY` (발급 필요)

### NTIS API (공모사업)
- URL: `https://www.ntis.go.kr/openapi`
- 인증: API 키
- Secrets: `NTIS_API_KEY` (발급 필요)

---

## 8. 비용 요약

| 항목 | 비용 |
|------|------|
| 모든 공공 API | 무료 |
| GitHub Actions | 무료 |
| Cloudflare Pages | 무료 |
| AI 요약 (Gemini/GPT/Claude) | 사용자 자기 키 사용, 운영비 $0 |
| **총 월 운영비** | **$0** |

---

## 9. 리스크 & 대응

| 리스크 | 대응 |
|--------|------|
| 특정 API 일시 장애 | 채널별 독립 실행으로 격리. 3회 재시도 후 실패 시 이전 데이터 유지 |
| 나라장터 API 응답 형식 변경 | 방어 코드 + 필드 누락 시 skip |
| NTIS API 접근 제한 | 기업마당 공모 분류로 대체 가능 |
| Cloudflare 무료 한도 | 하루 1회 빌드, 한도의 1% 미만 사용 |
