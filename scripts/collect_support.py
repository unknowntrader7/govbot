"""
GovBot 지원사업 수집 스크립트
기업마당 API + 보조금24 API에서 정부 지원사업 공고를 수집하여 support.json에 저장한다.
"""

import os
import sys
import time

from common import (
    ROOT_DIR, DATA_DIR, SEEN_IDS_DIR,
    is_holiday, load_config, load_json, save_json,
    calculate_dday, extract_date, api_call_with_retry,
    filter_by_keywords, filter_by_region, filter_by_organization, filter_new,
    deduplicate, cleanup_expired, recalculate_ddays,
)

# ──────────────────────────────────────
# 경로
# ──────────────────────────────────────

DATA_PATH = os.path.join(DATA_DIR, "support.json")
SEEN_IDS_PATH = os.path.join(SEEN_IDS_DIR, "support.json")

# ──────────────────────────────────────
# API 엔드포인트
# ──────────────────────────────────────

BIZINFO_API_URL = "https://www.bizinfo.go.kr/uss/rss/bizinfoApi.do"
GOV24_API_URL = "https://api.odcloud.kr/api/gov24/v3/serviceList"

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
        time.sleep(1)

    print(f"[보조금24] 총 {len(all_items)}건 수신 완료")
    return all_items


def parse_gov24(item):
    """보조금24 API 응답을 내부 스키마로 변환한다."""
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


# ──────────────────────────────────────
# 메인
# ──────────────────────────────────────

def main():
    print("=" * 50)
    print("[지원사업] 수집 시작")
    print("=" * 50)

    # 공휴일 체크
    force_run = os.environ.get("FORCE_RUN", "false").lower() == "true"
    if is_holiday() and not force_run:
        print("[스킵] 오늘은 공휴일입니다.")
        return

    bizinfo_key = os.environ.get("BIZINFO_API_KEY")
    gov24_key = os.environ.get("GOV24_API_KEY")

    if not bizinfo_key:
        print("[경고] BIZINFO_API_KEY가 설정되지 않았습니다.")
    if not gov24_key:
        print("[경고] GOV24_API_KEY가 설정되지 않았습니다.")
    if not bizinfo_key and not gov24_key:
        print("[오류] API 키가 하나도 설정되지 않았습니다.")
        sys.exit(1)

    # 1. 설정 로드
    config = load_config()
    common_cfg = config.get("common", {})
    support_cfg = config.get("support", {})

    regions = common_cfg.get("regions", [])
    keywords = common_cfg.get("keywords", [])
    include_orgs = common_cfg.get("include_organizations", [])
    exclude_orgs = support_cfg.get("exclude_organizations", [])

    # 2. 기존 데이터 로드
    announcements = load_json(DATA_PATH, [])
    seen_ids = set(load_json(SEEN_IDS_PATH, []))
    print(f"[시작] 기존 공고 {len(announcements)}건, 수집 이력 {len(seen_ids)}건")

    new_count = 0

    # 3. 기업마당 수집
    if bizinfo_key:
        raw_bizinfo = fetch_bizinfo(bizinfo_key)
        parsed_bizinfo = [parse_bizinfo(item) for item in raw_bizinfo]
        parsed_bizinfo = filter_by_region(parsed_bizinfo, regions, include_orgs)
        new_bizinfo = filter_new(parsed_bizinfo, seen_ids)
        announcements.extend(new_bizinfo)
        new_count += len(new_bizinfo)
        print(f"[기업마당] 신규 {len(new_bizinfo)}건 추가")

    # 4. 보조금24 수집
    if gov24_key:
        raw_gov24 = fetch_gov24(gov24_key)
        parsed_gov24 = [parse_gov24(item) for item in raw_gov24]
        parsed_gov24 = filter_by_region(parsed_gov24, regions, include_orgs)
        new_gov24 = filter_new(parsed_gov24, seen_ids)
        announcements.extend(new_gov24)
        new_count += len(new_gov24)
        print(f"[보조금24] 신규 {len(new_gov24)}건 추가")

    # 5. 기존 데이터 포함 전체에 지역 필터 재적용
    announcements = filter_by_region(announcements, regions, include_orgs)

    # 5-1. 키워드 필터 (문화/AI 등)
    announcements = filter_by_keywords(announcements, keywords)

    # 5-2. 제외 기관 필터
    announcements = filter_by_organization(announcements, exclude_orgs)

    # 6. 중복 제거
    announcements = deduplicate(announcements)

    # 7. 마감 공고 삭제
    announcements = cleanup_expired(announcements)

    # 8. D-day 재계산
    announcements = recalculate_ddays(announcements)

    # 9. 마감일순 정렬
    announcements.sort(key=lambda x: x.get("dDay", 999))

    # 10. 저장
    save_json(DATA_PATH, announcements)
    save_json(SEEN_IDS_PATH, list(seen_ids))

    print(f"[완료] 총 {len(announcements)}건 저장 (신규 {new_count}건 추가)")


if __name__ == "__main__":
    main()
