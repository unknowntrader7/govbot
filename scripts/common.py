"""
GovBot 공통 유틸리티 모듈
각 수집 스크립트(collect_support, collect_bids, collect_grants)에서 공유한다.
"""

import json
import os
import sys
import time
from datetime import datetime

import requests

# ──────────────────────────────────────
# 경로 상수
# ──────────────────────────────────────

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
CONFIG_PATH = os.path.join(SCRIPT_DIR, "config.json")
DATA_DIR = os.path.join(ROOT_DIR, "site", "data")
SEEN_IDS_DIR = os.path.join(ROOT_DIR, "seen_ids")

# ──────────────────────────────────────
# 공휴일 (매년 초에 업데이트 필요)
# ──────────────────────────────────────

HOLIDAYS_2026 = {
    "2026-01-01",  # 신정
    "2026-02-16",  # 설날 연휴
    "2026-02-17",  # 설날
    "2026-02-18",  # 설날 연휴
    "2026-03-01",  # 삼일절
    "2026-05-05",  # 어린이날
    "2026-05-24",  # 부처님오신날
    "2026-06-06",  # 현충일
    "2026-08-15",  # 광복절
    "2026-10-03",  # 개천절
    "2026-10-04",  # 추석 연휴
    "2026-10-05",  # 추석
    "2026-10-06",  # 추석 연휴
    "2026-10-09",  # 한글날
    "2026-12-25",  # 크리스마스
}


def is_holiday():
    """오늘이 공휴일이면 True를 반환한다."""
    today = datetime.now().strftime("%Y-%m-%d")
    return today in HOLIDAYS_2026


# ──────────────────────────────────────
# JSON I/O
# ──────────────────────────────────────

def load_json(filepath, default):
    """JSON 파일을 로드한다. 파일이 없으면 default 반환."""
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(filepath, data):
    """JSON 파일로 저장한다."""
    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def load_config():
    """config.json을 로드하여 반환한다."""
    return load_json(CONFIG_PATH, {})


# ──────────────────────────────────────
# 날짜 유틸
# ──────────────────────────────────────

def calculate_dday(end_date_str):
    """마감일까지 남은 일수를 계산한다."""
    if not end_date_str:
        return 999
    try:
        end_date = datetime.strptime(end_date_str, "%Y-%m-%d")
        today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        return (end_date - today).days
    except ValueError:
        return 999


def extract_date(text):
    """텍스트에서 날짜(YYYY-MM-DD)를 추출한다."""
    if not text:
        return ""
    import re
    match = re.search(r"(\d{4}-\d{2}-\d{2})", text)
    if match:
        return match.group(1)
    match = re.search(r"(\d{4})\.(\d{2})\.(\d{2})", text)
    if match:
        return f"{match.group(1)}-{match.group(2)}-{match.group(3)}"
    return ""


# ──────────────────────────────────────
# API 유틸
# ──────────────────────────────────────

def api_call_with_retry(url, params, headers=None, retries=3, delay=5):
    """API를 호출하고 실패 시 재시도한다."""
    for attempt in range(retries):
        try:
            response = requests.get(url, params=params, headers=headers, timeout=30)
            response.raise_for_status()
            return response.json()
        except (requests.RequestException, json.JSONDecodeError) as e:
            print(f"  [오류] API 호출 실패 (시도 {attempt + 1}/{retries}): {e}")
            if attempt < retries - 1:
                time.sleep(delay)
    return None


# ──────────────────────────────────────
# 지역 & 기관 필터
# ──────────────────────────────────────

def is_central_government(org, include_orgs=None):
    """소관기관이 중앙정부(부/처/청/위원회) 또는 전국 단위 공공기관인지 판별한다.

    지역 필터에서 시·도 이름이 없는 기관 중 중앙부처/전국기관만 통과시키기 위해 사용.
    False를 반환하면 해당 기관의 공고는 지역 필터에서 제외된다.
    """
    if not org:
        return True  # 기관명이 비어 있으면 안전하게 통과

    # 사용자 화이트리스트 (config.json의 include_organizations)
    if include_orgs:
        for inc in include_orgs:
            if inc in org:
                return True

    # 법인 형태 접두어 제거 후 판별 (재단법인OO → OO 기준으로 판별)
    stripped = org
    for prefix in ("(재)", "(주)", "(사)", "재단법인", "사단법인", "학교법인", "주식회사"):
        if stripped.startswith(prefix):
            stripped = stripped[len(prefix):]
            break
    stripped = stripped.strip()

    # ── 1. 중앙행정기관 접미사 패턴 (부·처·청) ──
    if len(stripped) >= 2 and (stripped.endswith("부") or stripped.endswith("처") or stripped.endswith("청")):
        return True

    # ── 2. 전국 단위 기관 접두어 ──
    if stripped.startswith(("한국", "대한", "국립", "국가", "국민", "국무")):
        return True

    # ── 3. 전국 단위 공공기관 키워드 (패턴에 안 잡히는 기관) ──
    national_keywords = [
        # 헌법기관
        "감사원", "대통령", "헌법재판소",
        # 금융·보증
        "기술보증기금", "신용보증기금", "신용보증재단중앙회",
        "서민금융진흥원", "예금보험공사", "주택금융공사",
        "자산관리공사", "무역보험공사",
        # 산업·중소기업
        "중소벤처기업진흥공단", "소상공인시장진흥공단",
        "산업인력공단", "에너지공단", "무역협회",
        "정보통신산업진흥원", "콘텐츠진흥원", "창업진흥원",
        # 복지·노동
        "근로복지공단", "산업안전보건공단",
        "건강보험심사평가원", "건설근로자공제회",
        "노사발전재단", "사립학교교직원연금공단",
        # 농림·해양
        "농어촌공사", "농수산식품유통공사",
        "농업정책보험금융원", "축산물품질평가원",
        # 인프라·교통
        "도로공사", "수자원공사", "토지주택공사",
        "철도공사", "전력공사", "가스공사",
        "한전", "에스알",
        # 문화·교육·기타
        "독립기념관", "북한이탈주민지원재단",
        "시청자미디어재단", "해양환경공단",
        "장애인기업종합지원센터",
        "올림픽기념국민체육진흥공단",
        "공영홈쇼핑", "코리아레저",
        "태권도진흥재단",
        # 위원회 (전국 단위만 명시)
        "금융위원회", "공정거래위원회",
        "방송통신위원회", "방송미디어통신위원회",
        "개인정보보호위원회", "원자력안전위원회",
        "국민권익위원회", "신용회복위원회",
        "탄소중립녹색성장위원회",
    ]
    return any(kw in org or kw in stripped for kw in national_keywords)


# 시·도 이름 변환 매핑 (전체 이름/약칭 → 약칭)
# 긴 이름부터 매칭해야 "경상남도"가 "경남"으로 정확히 잡힘
REGION_VARIANTS = [
    ("서울특별시", "서울"), ("부산광역시", "부산"), ("대구광역시", "대구"),
    ("인천광역시", "인천"), ("광주광역시", "광주"), ("대전광역시", "대전"),
    ("울산광역시", "울산"), ("세종특별자치시", "세종"),
    ("경기도", "경기"), ("강원특별자치도", "강원"), ("강원도", "강원"),
    ("충청북도", "충북"), ("충청남도", "충남"),
    ("전북특별자치도", "전북"), ("전라북도", "전북"), ("전라남도", "전남"),
    ("경상북도", "경북"), ("경상남도", "경남"),
    ("제주특별자치도", "제주"), ("제주도", "제주"),
    # 약칭 폴백
    ("서울", "서울"), ("부산", "부산"), ("대구", "대구"), ("인천", "인천"),
    ("광주", "광주"), ("대전", "대전"), ("울산", "울산"), ("세종", "세종"),
    ("경기", "경기"), ("강원", "강원"), ("충북", "충북"), ("충남", "충남"),
    ("전북", "전북"), ("전남", "전남"), ("경북", "경북"), ("경남", "경남"),
    ("제주", "제주"),
]


def filter_by_region(items, regions, include_orgs=None):
    """지역 필터: 중앙부처 사업은 통과, 지자체 사업은 설정된 지역만 통과."""
    if not regions:
        return items

    filtered = []
    excluded_local_orgs = set()
    for item in items:
        org = item.get("organization", "")

        matched_region = None
        for variant, canonical in REGION_VARIANTS:
            if variant in org:
                matched_region = canonical
                break

        if matched_region:
            if matched_region in regions:
                filtered.append(item)
        else:
            if is_central_government(org, include_orgs):
                filtered.append(item)
            else:
                excluded_local_orgs.add(org)

    removed = len(items) - len(filtered)
    if removed > 0:
        print(f"[지역필터] {removed}건 제외 (설정 지역: {', '.join(regions)})")
    if excluded_local_orgs:
        sample = sorted(excluded_local_orgs)[:10]
        suffix = f" 외 {len(excluded_local_orgs) - 10}개" if len(excluded_local_orgs) > 10 else ""
        print(f"[지역필터] 비중앙 기관 {len(excluded_local_orgs)}개 제외: {', '.join(sample)}{suffix}")
    return filtered


def filter_by_keywords(items, keywords):
    """키워드 필터: 제목에 키워드가 하나라도 포함된 공고만 통과."""
    if not keywords:
        return items
    filtered = [
        item for item in items
        if any(kw in item.get("title", "") for kw in keywords)
    ]
    removed = len(items) - len(filtered)
    if removed > 0:
        print(f"[키워드필터] {removed}건 제외 ({len(filtered)}건 통과, 키워드 {len(keywords)}개)")
    return filtered


def filter_by_organization(items, exclude_orgs):
    """특정 소관기관을 제외한다."""
    if not exclude_orgs:
        return items
    filtered = [item for item in items if item.get("organization", "") not in exclude_orgs]
    removed = len(items) - len(filtered)
    if removed > 0:
        print(f"[기관필터] {removed}건 제외 ({len(exclude_orgs)}개 기관)")
    return filtered


# ──────────────────────────────────────
# 데이터 처리
# ──────────────────────────────────────

def filter_new(parsed_items, seen_ids):
    """이미 수집한 공고를 제외하고 신규만 반환한다."""
    new_items = []
    for item in parsed_items:
        uid = item.get("id", "")
        if uid and uid not in seen_ids:
            new_items.append(item)
            seen_ids.add(uid)
    return new_items


def deduplicate(announcements):
    """사업명 + 소관기관 조합으로 중복 공고를 제거한다."""
    seen = {}
    result = []
    for a in announcements:
        key = (a.get("title", "").strip(), a.get("organization", "").strip())
        if key not in seen:
            seen[key] = True
            result.append(a)
    removed = len(announcements) - len(result)
    if removed > 0:
        print(f"[중복제거] {removed}건 중복 제거")
    return result


def cleanup_expired(announcements):
    """마감일이 지난 공고를 제거한다."""
    today = datetime.now().strftime("%Y-%m-%d")
    valid = [a for a in announcements if a.get("endDate", "") >= today or a.get("endDate", "") == ""]
    removed = len(announcements) - len(valid)
    if removed > 0:
        print(f"[정리] 마감 공고 {removed}건 삭제")
    return valid


def recalculate_ddays(announcements):
    """모든 공고의 D-day를 현재 날짜 기준으로 재계산한다."""
    for a in announcements:
        a["dDay"] = calculate_dday(a.get("endDate", ""))
    return announcements
