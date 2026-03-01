# GovBot — 정부 사업 공고 수집 & AI 요약 보드

## 프로젝트 개요

정부 지원사업·공모사업·입찰/조달 공고를 매일 자동 수집하여 Cloudflare Pages 보드에 3탭으로 표시. AI 요약은 사용자 API 키로 온디맨드 실행.

## 3개 채널

| 채널 | 소스 | 데이터 파일 | 수집 스크립트 |
|------|------|-------------|---------------|
| 지원사업 | 기업마당 + 보조금24 | `support.json` | `collect_support.py` |
| 공모사업 | NTIS + 기업마당 공모분류 | `grants.json` | `collect_grants.py` |
| 입찰/조달 | 나라장터(G2B) | `bids.json` | `collect_bids.py` |

## 기술 스택

- **스케줄러:** GitHub Actions (평일 09:00 KST, 공휴일 제외)
- **수집:** Python 3.11 + requests
- **데이터:** JSON 파일 × 3 (채널별 분리, DB 없음)
- **프론트엔드:** 바닐라 HTML/CSS/JS (프레임워크 없음)
- **호스팅:** Cloudflare Pages (GitHub 연동)
- **AI 요약:** Gemini / ChatGPT / Claude — 사용자 브라우저에서 직접 호출 (사용자 API 키, localStorage)

## 레포지토리 구조

```
govbot/
├── .github/workflows/
│   └── collect.yml              # 3개 수집 스크립트 순차 실행
├── scripts/
│   ├── common.py                # 공통 유틸 (API호출, 지역필터, D-day, JSON I/O)
│   ├── config.json              # 채널별 설정
│   ├── collect_support.py       # 지원사업 (기업마당 + 보조금24)
│   ├── collect_bids.py          # 입찰/조달 (나라장터)
│   ├── collect_grants.py        # 공모사업 (NTIS + 기업마당 공모)
│   └── requirements.txt
├── site/
│   ├── index.html               # 3탭 UI (지원사업/공모사업/입찰조달)
│   ├── style.css                # 다크모드 지원 (CSS 변수)
│   ├── app.js                   # 프론트엔드 로직
│   └── data/
│       ├── support.json
│       ├── grants.json
│       └── bids.json
├── seen_ids/
│   ├── support.json
│   ├── grants.json
│   └── bids.json
├── CLAUDE.md
└── PLAN.md
```

## 현재 구현 상태

- ✅ Phase 1: 기업마당 + 보조금24 수집 (collect_support.py)
- ✅ 지역 필터 (시/도 매칭 + 중앙부처 판별 `is_central_government()`)
- ✅ 제외 기관 필터 (`exclude_organizations`)
- ✅ 보드 UI (카드, 카테고리 필터, 검색, 정렬)
- ✅ 다크모드, D-day 긴급 섹션 (D-3 핀), 관심 키워드 하이라이트
- ✅ AI 요약 설정 UI (Gemini/ChatGPT/Claude 탭, API 키 입력, localStorage)
- ✅ 모바일 반응형
- ✅ Phase 2: 리팩토링 완료 (common.py + collect_support.py 분리)
- ✅ Phase 3: 나라장터 입찰/조달 수집 (collect_bids.py) — API 키 등록 대기
- ⬜ Phase 4: 공모사업 수집 (collect_grants.py)
- ⬜ Phase 5: 프론트엔드 3탭 UI
- ⬜ Cloudflare Pages 연결

## 핵심 필터 로직 (common.py)

### 지역 필터 (`filter_by_region`)
- 시/도 이름 매칭 (전체이름 + 약칭): "경상남도"→"경남", "서울특별시"→"서울" 등
- 매칭되면: config의 regions 목록에 있는 지역만 통과
- 매칭 안 되면: `is_central_government()` 판별 → 중앙부처/전국기관이면 통과, 아니면 제외

### 중앙부처 판별 (`is_central_government`)
- 법인 접두어 제거: (재), (주), 재단법인, 학교법인 등
- 패턴 1: 접미사 "부"/"처"/"청" (3글자 이상)
- 패턴 2: 접두어 "한국"/"대한"/"국립"/"국가"/"국민"/"국무"
- 패턴 3: 명시적 전국기관 키워드 리스트 (기술보증기금, 중소벤처기업진흥공단, 금융위원회 등)
- config의 `include_organizations`로 사용자 화이트리스트 추가 가능

### 기관 제외 (`filter_by_organization`)
- config의 `exclude_organizations` 목록에 있는 기관의 공고를 제외
- 현재: 국방부, 외교부, 법무부, 국세청, 관세청, 조달청 등 12개

## 프론트엔드 주요 기능

### AI 요약 설정
- 3개 탭: Gemini / ChatGPT / Claude
- 각 탭에서 API 키 + 모델 선택
- 선택된 탭 = 활성 AI 프로바이더 (`activeSettingsTab`)
- API 키는 localStorage에 저장 (`govbot_settings`)
- CORS 주의: Claude API는 브라우저 직접 호출 시 제한 있을 수 있음

### 다크모드
- CSS 변수 기반 (`[data-theme="dark"]`)
- 시스템 설정 감지 + localStorage 저장
- 토글 버튼: 🌙 / ☀️

### 관심 키워드
- 설정에서 입력 (콤마 구분)
- 매칭된 카드에 `.highlight` 클래스 → 좌측 골드 보더

## API 키 (GitHub Secrets)

| 시크릿 | 용도 | 상태 |
|--------|------|------|
| `BIZINFO_API_KEY` | 기업마당 API | ✅ 등록됨 |
| `GOV24_API_KEY` | 보조금24 API | ✅ 등록됨 |
| `G2B_API_KEY` | 나라장터 API | ⬜ GitHub Secrets 등록 대기 |
| `NTIS_API_KEY` | NTIS API | ⬜ 발급 필요 |

## 코딩 규칙

- Python 3.11, `requests` 라이브러리
- 프론트엔드: 바닐라 HTML/CSS/JS (프레임워크 없음)
- JSON 파일 기반 (DB 사용 안 함)
- API 키: GitHub Secrets / localStorage. 코드에 하드코딩 금지
- 공공 API: robots.txt 준수, 요청 간격 1~2초
- Git: 자동 커밋은 GitHub Actions에서만. 로컬에서는 사용자가 명시적으로 요청할 때만 커밋
- 한국어 출력 시 Windows 콘솔 인코딩 주의 (`sys.stdout.reconfigure(encoding='utf-8')` 또는 `-X utf8`)
