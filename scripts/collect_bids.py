"""
GovBot 입찰/조달 수집 스크립트
나라장터(G2B) API에서 입찰공고 정보를 수집하여 bids.json에 저장한다.
"""

import os
import sys
import time
from datetime import datetime, timedelta
from urllib.parse import unquote

from common import (
    ROOT_DIR, DATA_DIR, SEEN_IDS_DIR,
    is_holiday, load_config, load_json, save_json,
    calculate_dday, api_call_with_retry,
    filter_by_keywords, filter_by_region, filter_new,
    deduplicate, cleanup_expired, recalculate_ddays,
)

# ──────────────────────────────────────
# 경로
# ──────────────────────────────────────

DATA_PATH = os.path.join(DATA_DIR, "bids.json")
SEEN_IDS_PATH = os.path.join(SEEN_IDS_DIR, "bids.json")

# ──────────────────────────────────────
# API 엔드포인트
# ──────────────────────────────────────

G2B_BASE_URL = "http://apis.data.go.kr/1230000/BidPublicInfoService/"

# 업무별 입찰공고 목록 엔드포인트
BID_ENDPOINTS = {
    "용역": "getBidPblancListInfoServc04",
    "물품": "getBidPblancListInfoThng04",
    "공사": "getBidPblancListInfoCnstwk04",
    "외자": "getBidPblancListInfoFrgcpt04",
}

# 나라장터 상세 조회 URL
G2B_DETAIL_URL = "https://www.g2b.go.kr:8340/search.do?bidno={bidno}"

# ──────────────────────────────────────
# 날짜 유틸
# ──────────────────────────────────────

def get_query_date_range(days_back=7):
    """조회 기간을 계산한다 (최근 N일)."""
    end_dt = datetime.now()
    begin_dt = end_dt - timedelta(days=days_back)
    return (
        begin_dt.strftime("%Y%m%d") + "0000",
        end_dt.strftime("%Y%m%d") + "2359",
    )


def parse_g2b_date(date_str):
    """나라장터 날짜 문자열을 YYYY-MM-DD로 변환한다.

    입력 예: '2026/03/01 10:00:00' → '2026-03-01'
             '20260301'            → '2026-03-01'
    """
    if not date_str:
        return ""
    date_str = date_str.strip()
    # "2026/03/01 10:00:00" 형식
    try:
        dt = datetime.strptime(date_str[:10], "%Y/%m/%d")
        return dt.strftime("%Y-%m-%d")
    except ValueError:
        pass
    # "2026-03-01 10:00:00" 형식
    try:
        dt = datetime.strptime(date_str[:10], "%Y-%m-%d")
        return dt.strftime("%Y-%m-%d")
    except ValueError:
        pass
    # "20260301" 형식
    try:
        dt = datetime.strptime(date_str[:8], "%Y%m%d")
        return dt.strftime("%Y-%m-%d")
    except ValueError:
        return ""


# ──────────────────────────────────────
# API 호출
# ──────────────────────────────────────

def fetch_bids(api_key, bid_type, endpoint):
    """나라장터 API를 호출하여 입찰공고 목록을 가져온다."""
    print(f"[나라장터-{bid_type}] 수집 시작...")

    begin_dt, end_dt = get_query_date_range(days_back=7)
    all_items = []
    page = 1
    num_of_rows = 100

    while True:
        url = G2B_BASE_URL + endpoint
        params = {
            "ServiceKey": api_key,
            "inqryDiv": "1",           # 입찰공고일시 기준
            "inqryBgnDt": begin_dt,
            "inqryEndDt": end_dt,
            "pageNo": str(page),
            "numOfRows": str(num_of_rows),
            "type": "json",
        }

        data = api_call_with_retry(url, params)
        if data is None:
            print(f"[나라장터-{bid_type}] 수집 실패")
            break

        # 에러 응답 체크
        header = data.get("response", {}).get("header", {})
        result_code = header.get("resultCode", "")
        if result_code != "00":
            result_msg = header.get("resultMsg", "")
            print(f"[나라장터-{bid_type}] API 오류: {result_code} - {result_msg}")
            break

        # 응답 구조: response > body > items, totalCount
        body = data.get("response", {}).get("body", {})
        items = body.get("items", [])
        total_count = body.get("totalCount", 0)

        # data.go.kr은 결과가 없으면 items가 빈 문자열("")일 수 있음
        if not items or items == "":
            items = []
        # 결과가 1건일 때 dict로 올 수 있음
        if isinstance(items, dict):
            items = [items]

        all_items.extend(items)
        print(f"[나라장터-{bid_type}] 페이지 {page} - {len(items)}건 수신 "
              f"(총 {total_count}건 중 {len(all_items)}건)")

        if len(all_items) >= total_count or len(items) == 0:
            break

        page += 1
        time.sleep(1)

    print(f"[나라장터-{bid_type}] 총 {len(all_items)}건 수신 완료")
    return all_items


def parse_bid(item, bid_type):
    """나라장터 API 응답을 내부 스키마로 변환한다."""
    bid_no = item.get("bidNtceNo", "")
    bid_ord = item.get("bidNtceOrd", "00")

    end_date = parse_g2b_date(item.get("bidClseDt", ""))
    start_date = parse_g2b_date(item.get("bidNtceDt", ""))
    regist_date = parse_g2b_date(item.get("rgstDt", ""))

    # 예산 금액 (추정가격 → 배정예산 순서로 폴백)
    budget_raw = item.get("presmptPrce", "") or item.get("asignBdgtAmt", "")
    try:
        budget = int(float(budget_raw)) if budget_raw else 0
    except (ValueError, TypeError):
        budget = 0

    detail_url = G2B_DETAIL_URL.format(bidno=bid_no) if bid_no else ""

    return {
        "id": f"g2b_{bid_no}_{bid_ord}",
        "title": item.get("bidNtceNm", ""),
        "category": bid_type,
        "organization": item.get("ntceInsttNm", ""),
        "executor": item.get("dminsttNm", ""),
        "startDate": start_date,
        "endDate": end_date,
        "registDate": regist_date,
        "detailUrl": detail_url,
        "dDay": calculate_dday(end_date),
        "summary": item.get("cntrctCnclsMthdNm", None),
        "source": "g2b",
        "budget": budget,
    }


# ──────────────────────────────────────
# 필터
# ──────────────────────────────────────

def filter_by_budget(items, min_budget):
    """최소 예산 이하 공고를 제외한다."""
    if not min_budget or min_budget <= 0:
        return items
    filtered = [item for item in items if item.get("budget", 0) >= min_budget]
    removed = len(items) - len(filtered)
    if removed > 0:
        print(f"[예산필터] {removed}건 제외 (최소 {min_budget:,}원)")
    return filtered


# ──────────────────────────────────────
# 메인
# ──────────────────────────────────────

def main():
    print("=" * 50)
    print("[입찰/조달] 수집 시작")
    print("=" * 50)

    # 공휴일 체크
    force_run = os.environ.get("FORCE_RUN", "false").lower() == "true"
    if is_holiday() and not force_run:
        print("[스킵] 오늘은 공휴일입니다.")
        return

    g2b_key = os.environ.get("G2B_API_KEY")
    if not g2b_key:
        print("[오류] G2B_API_KEY가 설정되지 않았습니다.")
        sys.exit(1)

    # data.go.kr API 키는 URL 인코딩된 상태로 저장될 수 있음
    # requests가 다시 인코딩하므로 미리 디코딩
    g2b_key = unquote(g2b_key)

    # 1. 설정 로드
    config = load_config()
    common_cfg = config.get("common", {})
    bids_cfg = config.get("bids", {})

    if not bids_cfg.get("enabled", False):
        print("[스킵] 입찰/조달 수집이 비활성화 상태입니다.")
        return

    regions = common_cfg.get("regions", [])
    keywords = common_cfg.get("keywords", [])
    include_orgs = common_cfg.get("include_organizations", [])
    min_budget = bids_cfg.get("min_budget", 0)

    # 2. 기존 데이터 로드
    bids = load_json(DATA_PATH, [])
    seen_ids = set(load_json(SEEN_IDS_PATH, []))
    print(f"[시작] 기존 입찰 {len(bids)}건, 수집 이력 {len(seen_ids)}건")

    new_count = 0

    # 3. 업무별 입찰공고 수집
    for bid_type, endpoint in BID_ENDPOINTS.items():
        raw_items = fetch_bids(g2b_key, bid_type, endpoint)
        parsed = [parse_bid(item, bid_type) for item in raw_items]
        parsed = filter_by_region(parsed, regions, include_orgs)
        new_items = filter_new(parsed, seen_ids)
        bids.extend(new_items)
        new_count += len(new_items)
        print(f"[나라장터-{bid_type}] 신규 {len(new_items)}건 추가")
        time.sleep(1)  # API 부하 방지

    # 4. 기존 데이터 포함 전체에 지역 필터 재적용
    bids = filter_by_region(bids, regions, include_orgs)

    # 5. 키워드 필터 (문화/AI 등)
    bids = filter_by_keywords(bids, keywords)

    # 5-1. 예산 필터
    bids = filter_by_budget(bids, min_budget)

    # 6. 중복 제거
    bids = deduplicate(bids)

    # 7. 마감 공고 삭제
    bids = cleanup_expired(bids)

    # 8. D-day 재계산
    bids = recalculate_ddays(bids)

    # 9. 마감일순 정렬
    bids.sort(key=lambda x: x.get("dDay", 999))

    # 10. 저장
    save_json(DATA_PATH, bids)
    save_json(SEEN_IDS_PATH, list(seen_ids))

    print(f"[완료] 총 {len(bids)}건 저장 (신규 {new_count}건 추가)")


if __name__ == "__main__":
    main()
