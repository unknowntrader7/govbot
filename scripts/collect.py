"""
GovBot 수집 스크립트
기업마당 API + 보조금24 API에서 정부 지원사업 공고를 수집하여 announcements.json에 저장한다.
"""

import json
import os
import sys
import time
from datetime import datetime

import requests

# 경로 설정
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
ANNOUNCEMENTS_PATH = os.path.join(ROOT_DIR, "site", "data", "announcements.json")
SEEN_IDS_PATH = os.path.join(ROOT_DIR, "seen_ids.json")
CONFIG_PATH = os.path.join(SCRIPT_DIR, "config.json")

# API 엔드포인트
BIZINFO_API_URL = "https://www.bizinfo.go.kr/uss/rss/bizinfoApi.do"
GOV24_API_URL = "https://api.odcloud.kr/api/gov24/v3/serviceList"


# ──────────────────────────────────────
# 공통 유틸리티
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
# 기업마당 API
# ──────────────────────────────────────

def fetch_bizinfo(api_key):
    """기업마당 API를 호출하여 공고 목록을 가져온다."""
    print("[기업마당] 수집 시작...")
    params = {
        "crtfcKey": api_key,
        "dataType": "JSON",
    }
    data = api_call_with_retry(BIZINFO_API_URL, params)
    if data is None:
        print("[기업마당] 수집 실패")
        return []

    items = data.get("jsonArray", [])
    print(f"[기업마당] {len(items)}건 수신")
    return items


def parse_bizinfo(item):
    """기업마당 API 응답을 내부 스키마로 변환한다."""
    end_date = item.get("reqstEndDe", "")
    return {
        "id": item.get("pblancId", ""),
        "title": item.get("pblancNm", ""),
        "category": item.get("hashtags", "기타"),
        "organization": item.get("jrsdInsttNm", ""),
        "executor": item.get("excInsttNm", ""),
        "startDate": item.get("reqstBeginDe", ""),
        "endDate": end_date,
        "registDate": item.get("creatPnttm", ""),
        "detailUrl": item.get("detailUrl", ""),
        "dDay": calculate_dday(end_date),
        "summary": None,
        "source": "bizinfo",
    }


# ──────────────────────────────────────
# 보조금24 API
# ──────────────────────────────────────

def fetch_gov24(api_key):
    """보조금24 API를 호출하여 공공서비스 목록을 가져온다."""
    print("[보조금24] 수집 시작...")
    all_items = []
    page = 1
    per_page = 500

    while True:
        params = {
            "page": page,
            "perPage": per_page,
            "returnType": "JSON",
            "serviceKey": api_key,
        }
        data = api_call_with_retry(GOV24_API_URL, params)
        if data is None:
            print("[보조금24] 수집 실패")
            break

        items = data.get("data", [])
        total_count = data.get("totalCount", 0)
        all_items.extend(items)
        print(f"[보조금24] 페이지 {page} - {len(items)}건 수신 (총 {total_count}건 중 {len(all_items)}건)")

        if len(all_items) >= total_count or len(items) == 0:
            break

        page += 1
        time.sleep(1)  # 요청 간격 유지

    print(f"[보조금24] 총 {len(all_items)}건 수신 완료")
    return all_items


def parse_gov24(item):
    """보조금24 API 응답을 내부 스키마로 변환한다."""
    # 신청기한에서 날짜 추출 시도
    deadline = item.get("신청기한", "")
    end_date = extract_date(deadline)

    return {
        "id": f"gov24_{item.get('서비스ID', '')}",
        "title": item.get("서비스명", ""),
        "category": item.get("서비스분야", "기타"),
        "organization": item.get("소관기관명", ""),
        "executor": item.get("접수기관", ""),
        "startDate": "",
        "endDate": end_date,
        "registDate": item.get("등록일시", ""),
        "detailUrl": item.get("상세조회URL", ""),
        "dDay": calculate_dday(end_date),
        "summary": item.get("서비스목적요약", None),
        "source": "gov24",
    }


def extract_date(text):
    """텍스트에서 날짜(YYYY-MM-DD)를 추출한다."""
    if not text:
        return ""
    # YYYY-MM-DD 패턴 찾기
    import re
    match = re.search(r"(\d{4}-\d{2}-\d{2})", text)
    if match:
        return match.group(1)
    # YYYY.MM.DD 패턴
    match = re.search(r"(\d{4})\.(\d{2})\.(\d{2})", text)
    if match:
        return f"{match.group(1)}-{match.group(2)}-{match.group(3)}"
    return ""


# ──────────────────────────────────────
# 중복 제거 & 필터링
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
    """사업명 + 소관기관 조합으로 중복 공고를 제거한다. 기업마당 우선."""
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


# ──────────────────────────────────────
# 메인
# ──────────────────────────────────────

def main():
    bizinfo_key = os.environ.get("BIZINFO_API_KEY")
    gov24_key = os.environ.get("GOV24_API_KEY")

    if not bizinfo_key:
        print("[경고] BIZINFO_API_KEY가 설정되지 않았습니다. 기업마당 수집을 건너뜁니다.")
    if not gov24_key:
        print("[경고] GOV24_API_KEY가 설정되지 않았습니다. 보조금24 수집을 건너뜁니다.")
    if not bizinfo_key and not gov24_key:
        print("[오류] API 키가 하나도 설정되지 않았습니다.")
        sys.exit(1)

    # 1. 기존 데이터 로드
    announcements = load_json(ANNOUNCEMENTS_PATH, [])
    seen_ids = set(load_json(SEEN_IDS_PATH, []))
    print(f"[시작] 기존 공고 {len(announcements)}건, 수집 이력 {len(seen_ids)}건")

    new_count = 0

    # 2. 기업마당 수집
    if bizinfo_key:
        raw_bizinfo = fetch_bizinfo(bizinfo_key)
        parsed_bizinfo = [parse_bizinfo(item) for item in raw_bizinfo]
        new_bizinfo = filter_new(parsed_bizinfo, seen_ids)
        announcements.extend(new_bizinfo)
        new_count += len(new_bizinfo)
        print(f"[기업마당] 신규 {len(new_bizinfo)}건 추가")

    # 3. 보조금24 수집
    if gov24_key:
        raw_gov24 = fetch_gov24(gov24_key)
        parsed_gov24 = [parse_gov24(item) for item in raw_gov24]
        new_gov24 = filter_new(parsed_gov24, seen_ids)
        announcements.extend(new_gov24)
        new_count += len(new_gov24)
        print(f"[보조금24] 신규 {len(new_gov24)}건 추가")

    # 4. 중복 제거 (사업명 + 소관기관 기준)
    announcements = deduplicate(announcements)

    # 5. 마감 공고 삭제
    announcements = cleanup_expired(announcements)

    # 6. D-day 재계산
    announcements = recalculate_ddays(announcements)

    # 7. 마감일순 정렬 (D-day 오름차순)
    announcements.sort(key=lambda x: x.get("dDay", 999))

    # 8. 저장
    save_json(ANNOUNCEMENTS_PATH, announcements)
    save_json(SEEN_IDS_PATH, list(seen_ids))

    print(f"[완료] 총 {len(announcements)}건 저장 (신규 {new_count}건 추가)")


if __name__ == "__main__":
    main()
