# GovBot - 정부 지원사업 자동 수집 & AI 요약 보드

## 프로젝트 개요

정부 지원사업 공고를 매일 자동 수집하여 Cloudflare Pages 기반 Fix 보드에 표시하고, AI 요약은 사용자가 개별 공고를 클릭할 때만 온디맨드로 실행하는 스케줄러 기반 봇.

## 핵심 설계 원칙

- **비용 최소화:** AI 요약은 자동 실행하지 않음. 온디맨드 방식으로 월 $0~1 유지
- **단순한 파이프라인:** GitHub Actions → JSON 갱신 → Cloudflare Pages 자동 배포. 별도 서버/DB 없음
- **자동 정리:** 마감일 지난 공고는 스케줄러가 자동 삭제

## 기술 스택

| 레이어 | 기술 |
|--------|------|
| 스케줄러 | GitHub Actions (cron: 매일 오전 9시 KST = UTC 0시) |
| 수집 스크립트 | Python 3.11 + requests |
| 데이터 소스 | 기업마당 API (`bizinfo.go.kr`) + 보조금24 API (`api.odcloud.kr`) |
| 데이터 저장 | JSON 파일 (repo 내 `site/data/announcements.json`) |
| 프론트엔드 | HTML/CSS/JS 정적 사이트 |
| 호스팅 | Cloudflare Pages (GitHub 연동, 자동 빌드) |
| AI 요약 | Claude API — Cloudflare Workers 프록시 경유 (Phase 2) |

## 레포지토리 구조

```
govbot/
├── .github/workflows/
│   └── collect.yml          # GitHub Actions 워크플로우
├── scripts/
│   ├── collect.py           # 메인 수집 스크립트
│   ├── config.json          # 필터 설정 (키워드, 분야, 지역)
│   └── requirements.txt     # Python 의존성
├── site/                    # Cloudflare Pages 빌드 대상
│   ├── index.html           # Fix 보드 메인 UI
│   ├── style.css
│   ├── app.js               # 프론트엔드 로직
│   └── data/
│       └── announcements.json
├── seen_ids.json            # 중복 체크용
├── CLAUDE.md
├── PLAN.md
└── README.md
```

## 데이터 파이프라인

```
GitHub Actions cron → 기업마당 API + 보조금24 API 호출 → 신규 공고 필터링 → 중복 제거 → 마감 공고 삭제 → announcements.json 갱신 → git push → Cloudflare Pages 자동 배포
```

## 공고 데이터 스키마 (announcements.json)

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
  "detailUrl": "https://www.bizinfo.go.kr/...",
  "dDay": 14,
  "summary": null,
  "source": "bizinfo"
}
```

- `summary`는 초기값 null → 사용자가 AI 요약 요청 시에만 채워짐 (보조금24는 서비스목적요약이 있으면 자동 채움)
- `dDay`는 스크립트 실행 시점 기준 매번 재계산
- `source`는 `"bizinfo"` 또는 `"gov24"` — 데이터 출처 구분 및 중복 제거에 사용

## API 정보

### 기업마당 API
- URL: `https://www.bizinfo.go.kr/uss/rss/bizinfoApi.do`
- 방식: GET, 응답: JSON/XML
- 인증: `crtfcKey` 파라미터 (API 키 필수)
- 필터: 키워드, 해시태그(금융/기술/인력/수출/내수/창업/경영/기타), 지역(17개 시도)

### 보조금24 API
- Base URL: `https://api.odcloud.kr/api`
- 목록 조회: `GET /gov24/v3/serviceList`
- 상세 조회: `GET /gov24/v3/serviceDetail`
- 지원 조건: `GET /gov24/v3/supportConditions`
- 인증: `serviceKey` 파라미터 (API 키 필수)
- 필터: `cond[소관기관유형::LIKE]`, `cond[서비스분야::LIKE]`, `cond[서비스명::LIKE]` 등
- 중복 제거: 사업명 + 소관기관 조합으로 기업마당과의 중복 제거

## Fix 보드 UI 요구사항

- 카드 리스트: 사업명, 소관기관, 마감일, D-day 표시
- D-day 색상: D-3 이하 빨강, D-7 이하 노랑, 그 외 초록
- 분야 필터 탭: 전체/금융/기술/인력/수출/내수/창업/경영/기타
- 키워드 검색: 클라이언트 사이드 필터링
- 정렬: 마감일순(기본), 등록일순
- [상세보기]: 기업마당 원문 링크 (새 탭)
- [AI 요약]: 클릭 시 Cloudflare Worker → Claude API 호출 → 결과 표시

## 구현 로드맵

- **Phase 1 (Week 1):** 기업마당 + 보조금24 수집 스크립트 + Fix 보드 UI + GitHub Actions + Cloudflare Pages 배포 (AI 요약 없이)
- **Phase 2 (Week 2~3):** 분야 필터, 키워드 검색, 정렬, Cloudflare Worker + Claude API 온디맨드 요약
- **Phase 3 (Week 4~):** 매칭 필터 하이라이트, D-day 상단 고정, 모바일 반응형

## 코딩 규칙

- Python: 3.11, requests + BeautifulSoup4 사용
- 프론트엔드: 바닐라 HTML/CSS/JS (프레임워크 없음, 정적 사이트)
- 데이터: JSON 파일 기반 (DB 사용하지 않음)
- API 키는 GitHub Secrets / Cloudflare Workers 환경 변수에 저장. 코드에 하드코딩 금지
- 공공 API 크롤링 시 robots.txt 준수, 요청 간격 1~2초, User-Agent 명시
