"""
GovBot 공모사업 수집 스크립트
KOCCA(한국콘텐츠진흥원) API + ARKO(한국문화예술위원회) 스크래핑으로
공모사업 공고를 수집하여 grants.json에 저장한다.
"""

import os
import re
import sys
import time
from datetime import datetime, timedelta
from urllib.parse import unquote

import requests
from bs4 import BeautifulSoup

from common import (
    ROOT_DIR, DATA_DIR, SEEN_IDS_DIR,
    is_holiday, load_config, load_json, save_json,
    calculate_dday, api_call_with_retry,
    filter_by_keywords, filter_new,
    deduplicate, cleanup_expired, recalculate_ddays,
)

# ──────────────────────────────────────
# 경로
# ──────────────────────────────────────

DATA_PATH = os.path.join(DATA_DIR, "grants.json")
SEEN_IDS_PATH = os.path.join(SEEN_IDS_DIR, "grants.json")

# ──────────────────────────────────────
# 날짜 유틸
# ──────────────────────────────────────

def parse_date(date_str):
    """다양한 형식의 날짜 문자열을 YYYY-MM-DD로 변환한다.

    지원 형식: 2026-03-01, 2026.03.01, 20260301
    """
    if not date_str:
        return ""
    date_str = str(date_str).strip()
    # "2026-03-01" 또는 "2026-03-01 12:00:00"
    try:
        return datetime.strptime(date_str[:10], "%Y-%m-%d").strftime("%Y-%m-%d")
    except ValueError:
        pass
    # "2026.03.01"
    try:
        return datetime.strptime(date_str[:10], "%Y.%m.%d").strftime("%Y-%m-%d")
    except ValueError:
        pass
    # "20260301"
    try:
        return datetime.strptime(date_str[:8], "%Y%m%d").strftime("%Y-%m-%d")
    except ValueError:
        return ""


# ──────────────────────────────────────
# KOCCA API (한국콘텐츠진흥원)
# ──────────────────────────────────────

KOCCA_API_URL = "https://kocca.kr/api/pims/List.do"

def fetch_kocca(api_key):
    """KOCCA 지원사업공고 API를 호출하여 목록을 가져온다."""
    print("[KOCCA] 수집 시작...")

    # 최근 90일 조회
    view_start = (datetime.now() - timedelta(days=90)).strftime("%Y%m%d")
    all_items = []
    page = 1

    while True:
        params = {
            "serviceKey": api_key,
            "pageNo": str(page),
            "numOfRows": "100",
            "viewStartDt": view_start,
        }

        data = api_call_with_retry(KOCCA_API_URL, params)
        if data is None:
            print("[KOCCA] 수집 실패")
            break

        # 응답 코드 확인
        result_code = data.get("resultCode", "")
        if result_code != "INFO-000":
            result_msg = data.get("resultMsg", "")
            print(f"[KOCCA] API 오류: {result_code} - {result_msg}")
            break

        # 아이템 추출 (data 또는 items 키)
        items = data.get("data", data.get("items", []))
        if not items or items == "":
            items = []
        if isinstance(items, dict):
            items = [items]

        all_items.extend(items)
        total_count = int(data.get("totalCount", len(all_items)))
        print(f"[KOCCA] 페이지 {page} - {len(items)}건 수신 "
              f"(총 {total_count}건 중 {len(all_items)}건)")

        if len(all_items) >= total_count or len(items) == 0:
            break

        page += 1
        time.sleep(1)

    print(f"[KOCCA] 총 {len(all_items)}건 수신 완료")
    return all_items


def parse_kocca(item):
    """KOCCA API 응답을 내부 스키마로 변환한다."""
    intc_no = item.get("intcNoSeq", "")
    end_date = parse_date(item.get("endDt", ""))
    start_date = parse_date(item.get("startDt", ""))
    reg_date = parse_date(item.get("regDate", item.get("regDt", "")))

    # 카테고리 매핑
    cate_map = {"1": "자유공모", "2": "지정공모", "3": "모집공고"}
    cate = cate_map.get(str(item.get("cate", "")), "공모")

    link = item.get("link", "")
    if not link and intc_no:
        link = f"https://www.kocca.kr/kocca/pims/view.do?intcNoSeq={intc_no}"

    return {
        "id": f"kocca_{intc_no}",
        "title": item.get("title", ""),
        "category": cate,
        "organization": "한국콘텐츠진흥원",
        "executor": "한국콘텐츠진흥원",
        "startDate": start_date,
        "endDate": end_date,
        "registDate": reg_date,
        "detailUrl": link,
        "dDay": calculate_dday(end_date),
        "summary": item.get("content", None),
        "source": "kocca",
    }


# ──────────────────────────────────────
# ARKO 스크래핑 (한국문화예술위원회)
# ──────────────────────────────────────

ARKO_BASE_URL = "https://www.arko.or.kr"
ARKO_LIST_URL = ARKO_BASE_URL + "/board/list/4013"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; GovBot/1.0)",
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "ko-KR,ko;q=0.9",
}


def fetch_arko(max_pages=5):
    """ARKO 공모사업 게시판을 스크래핑한다 (진행중 공모만)."""
    print("[ARKO] 수집 시작...")
    all_items = []

    for page in range(1, max_pages + 1):
        params = {
            "bid": "463",
            "dateLocation": "now",   # 진행중만
            "page": str(page),
        }

        try:
            resp = requests.get(
                ARKO_LIST_URL, params=params,
                headers=HEADERS, timeout=30,
            )
            resp.raise_for_status()
            resp.encoding = "utf-8"
        except requests.RequestException as e:
            print(f"[ARKO] 페이지 {page} 요청 실패: {e}")
            break

        soup = BeautifulSoup(resp.text, "html.parser")

        # 게시물 리스트: 두 번째 <ul class="cardBdList"> (첫 번째는 공지)
        card_lists = soup.select("div.boardList ul.cardBdList")
        if len(card_lists) >= 2:
            board_ul = card_lists[1]
        elif card_lists:
            board_ul = card_lists[0]
        else:
            print(f"[ARKO] 페이지 {page} 게시물 없음 - 수집 종료")
            break

        items = board_ul.find_all("li")
        if not items:
            print(f"[ARKO] 페이지 {page} 게시물 없음 - 수집 종료")
            break

        for li in items:
            parsed = _parse_arko_item(li)
            if parsed:
                all_items.append(parsed)

        print(f"[ARKO] 페이지 {page} - {len(items)}건 수신")

        # 총 페이지 확인
        m_num = soup.select_one("span.mNum")
        if m_num:
            text = m_num.get_text(strip=True)
            match = re.search(r"/\s*(\d+)", text)
            if match:
                total_pages = int(match.group(1))
                if page >= total_pages:
                    break

        time.sleep(1)

    print(f"[ARKO] 총 {len(all_items)}건 수신 완료")
    return all_items


def _parse_arko_item(li):
    """ARKO 게시판 <li> 항목을 내부 스키마로 변환한다."""
    a_tag = li.find("a")
    if not a_tag:
        return None

    # 제목
    tit_span = a_tag.select_one("span.tit")
    title = tit_span.get_text(strip=True) if tit_span else ""
    if not title:
        return None

    # 링크
    href = a_tag.get("href", "")
    if href.startswith("/"):
        detail_url = ARKO_BASE_URL + href
    else:
        detail_url = href

    # 고유 ID 추출
    cid_match = re.search(r"cid=(\d+)", href)
    if cid_match:
        uid = f"arko_{cid_match.group(1)}"
    else:
        docid_match = re.search(r"docid=([^&]+)", href)
        if docid_match:
            uid = f"arko_{docid_match.group(1)}"
        else:
            uid = f"arko_{abs(hash(href)) % 10**10}"

    # 날짜 (공모 탭에서는 비어있을 수 있음)
    date_span = a_tag.select_one("span.date")
    date_text = date_span.get_text(strip=True) if date_span else ""

    start_date = ""
    end_date = ""
    if date_text:
        # "2026.02.23 ~ 2026.03.23" 또는 "2026.02.26 ~"
        parts = date_text.split("~")
        if len(parts) >= 1:
            start_date = parse_date(parts[0].strip())
        if len(parts) >= 2 and parts[1].strip():
            end_date = parse_date(parts[1].strip())

    # 설명 (최대 200자)
    con_span = a_tag.select_one("span.con")
    summary = None
    if con_span:
        text = con_span.get_text(strip=True)
        if text:
            summary = text[:200]

    return {
        "id": uid,
        "title": title,
        "category": "공모",
        "organization": "한국문화예술위원회",
        "executor": "한국문화예술위원회",
        "startDate": start_date,
        "endDate": end_date,
        "registDate": start_date,
        "detailUrl": detail_url,
        "dDay": calculate_dday(end_date),
        "summary": summary,
        "source": "arko",
    }


# ──────────────────────────────────────
# 메인
# ──────────────────────────────────────

def main():
    print("=" * 50)
    print("[공모사업] 수집 시작")
    print("=" * 50)

    # 공휴일 체크
    force_run = os.environ.get("FORCE_RUN", "false").lower() == "true"
    if is_holiday() and not force_run:
        print("[스킵] 오늘은 공휴일입니다.")
        return

    kocca_key = os.environ.get("KOCCA_API_KEY")

    # 1. 설정 로드
    config = load_config()
    common_cfg = config.get("common", {})
    grants_cfg = config.get("grants", {})

    if not grants_cfg.get("enabled", False):
        print("[스킵] 공모사업 수집이 비활성화 상태입니다.")
        return

    keywords = common_cfg.get("keywords", [])

    # 2. 기존 데이터 로드
    grants = load_json(DATA_PATH, [])
    seen_ids = set(load_json(SEEN_IDS_PATH, []))
    print(f"[시작] 기존 공모사업 {len(grants)}건, 수집 이력 {len(seen_ids)}건")

    new_count = 0

    # 3. KOCCA 수집
    if kocca_key:
        kocca_key = unquote(kocca_key)
        raw_kocca = fetch_kocca(kocca_key)
        parsed_kocca = [parse_kocca(item) for item in raw_kocca]
        new_kocca = filter_new(parsed_kocca, seen_ids)
        grants.extend(new_kocca)
        new_count += len(new_kocca)
        print(f"[KOCCA] 신규 {len(new_kocca)}건 추가")
    else:
        print("[경고] KOCCA_API_KEY 미설정 - KOCCA 수집 건너뜀")

    # 4. ARKO 스크래핑 (API 키 불필요)
    raw_arko = fetch_arko(max_pages=5)
    new_arko = filter_new(raw_arko, seen_ids)
    grants.extend(new_arko)
    new_count += len(new_arko)
    print(f"[ARKO] 신규 {len(new_arko)}건 추가")

    # 5. 키워드 필터 (문화/AI 등)
    grants = filter_by_keywords(grants, keywords)

    # 6. 중복 제거
    grants = deduplicate(grants)

    # 7. 마감 공고 삭제
    grants = cleanup_expired(grants)

    # 8. D-day 재계산
    grants = recalculate_ddays(grants)

    # 9. 마감일순 정렬
    grants.sort(key=lambda x: x.get("dDay", 999))

    # 10. 저장
    save_json(DATA_PATH, grants)
    save_json(SEEN_IDS_PATH, list(seen_ids))

    print(f"[완료] 총 {len(grants)}건 저장 (신규 {new_count}건 추가)")


if __name__ == "__main__":
    main()
