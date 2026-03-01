/**
 * GovBot Fix 보드 — 프론트엔드 로직
 */

const DATA_URL = "data/announcements.json";

let allAnnouncements = [];
let currentCategory = "전체";
let currentSearch = "";
let currentSort = "dday";

// 초기화
document.addEventListener("DOMContentLoaded", () => {
  loadData();
  setupFilters();
  setupSearch();
  setupSort();
});

async function loadData() {
  try {
    const response = await fetch(DATA_URL);
    if (!response.ok) throw new Error("데이터를 불러올 수 없습니다.");
    allAnnouncements = await response.json();
    render();
    updateLastUpdated();
  } catch (err) {
    document.getElementById("card-list").innerHTML =
      '<div class="empty">공고 데이터를 불러올 수 없습니다.</div>';
  }
}

function setupFilters() {
  document.getElementById("filters").addEventListener("click", (e) => {
    if (!e.target.classList.contains("filter-btn")) return;

    document.querySelectorAll(".filter-btn").forEach((btn) => btn.classList.remove("active"));
    e.target.classList.add("active");

    currentCategory = e.target.dataset.category;
    render();
  });
}

function setupSearch() {
  let timer;
  document.getElementById("search").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      currentSearch = e.target.value.trim().toLowerCase();
      render();
    }, 200);
  });
}

function setupSort() {
  document.getElementById("sort").addEventListener("change", (e) => {
    currentSort = e.target.value;
    render();
  });
}

function getFiltered() {
  let list = [...allAnnouncements];

  // 카테고리 필터
  if (currentCategory !== "전체") {
    list = list.filter((a) => a.category === currentCategory);
  }

  // 키워드 검색
  if (currentSearch) {
    list = list.filter(
      (a) =>
        a.title.toLowerCase().includes(currentSearch) ||
        a.organization.toLowerCase().includes(currentSearch) ||
        a.executor.toLowerCase().includes(currentSearch)
    );
  }

  // 정렬
  if (currentSort === "dday") {
    list.sort((a, b) => a.dDay - b.dDay);
  } else if (currentSort === "regist") {
    list.sort((a, b) => (b.registDate || "").localeCompare(a.registDate || ""));
  }

  return list;
}

function render() {
  const list = getFiltered();
  const container = document.getElementById("card-list");
  const stats = document.getElementById("stats");

  stats.textContent = `총 ${allAnnouncements.length}건 중 ${list.length}건 표시`;

  if (list.length === 0) {
    container.innerHTML = '<div class="empty">표시할 공고가 없습니다.</div>';
    return;
  }

  container.innerHTML = list.map(createCard).join("");
}

function createCard(a) {
  const ddayInfo = getDdayInfo(a.dDay);
  const urgencyClass = a.dDay <= 3 ? "urgent" : a.dDay <= 7 ? "warning" : "";

  return `
    <div class="card ${urgencyClass}">
      <div class="card-header">
        <span class="dday-badge ${ddayInfo.color}">${ddayInfo.text}</span>
        <span class="card-title">${escapeHtml(a.title)}</span>
      </div>
      <div class="card-meta">
        <span><span class="card-category">${escapeHtml(a.category)}</span></span>
        <span>${escapeHtml(a.organization)}</span>
        <span>~${formatDate(a.endDate)}</span>
      </div>
      <div class="card-actions">
        <a class="btn btn-detail" href="${escapeHtml(a.detailUrl)}" target="_blank" rel="noopener">상세보기</a>
        <button class="btn btn-summary disabled" title="Phase 2에서 활성화 예정">AI 요약</button>
      </div>
    </div>
  `;
}

function getDdayInfo(dDay) {
  if (dDay <= 0) return { text: "마감", color: "red" };
  if (dDay <= 3) return { text: `D-${dDay}`, color: "red" };
  if (dDay <= 7) return { text: `D-${dDay}`, color: "yellow" };
  return { text: `D-${dDay}`, color: "green" };
}

function formatDate(dateStr) {
  if (!dateStr) return "미정";
  const parts = dateStr.split("-");
  if (parts.length >= 3) return `${parts[1]}.${parts[2]}`;
  return dateStr;
}

function escapeHtml(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function updateLastUpdated() {
  const el = document.getElementById("last-updated");
  if (allAnnouncements.length > 0) {
    const now = new Date();
    el.textContent = `마지막 업데이트: ${now.toLocaleDateString("ko-KR")}`;
  }
}
