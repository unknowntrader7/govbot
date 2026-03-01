/**
 * GovBot 문화사업 보드 — 프론트엔드 로직
 */

// ──────────────────────────────────────
// 채널 정의
// ──────────────────────────────────────

const CHANNELS = {
  support: {
    url: "data/support.json",
    label: "지원사업",
    sourceLabels: { bizinfo: "기업마당", gov24: "보조금24" },
  },
  bids: {
    url: "data/bids.json",
    label: "입찰·조달",
    sourceLabels: { g2b: "나라장터" },
  },
  grants: {
    url: "data/grants.json",
    label: "공모사업",
    sourceLabels: { kocca: "콘진원", arko: "문예위" },
  },
};

let currentChannel = "support";
let allAnnouncements = [];
let currentCategory = "전체";
let currentSearch = "";
let currentSort = "dday";

// ──────────────────────────────────────
// 카테고리 태그 파싱 (bizinfo hashtags 정리)
// ──────────────────────────────────────

const NOISE_TAGS = new Set([
  "서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종",
  "경기", "강원", "충북", "충남", "전북", "전남", "경북", "경남", "제주",
  "전국", "해외",
]);

// 기관명 접미 패턴 (4글자 이상일 때만 적용)
const ORG_SUFFIXES = ["진흥원", "진흥공단", "진흥재단", "진흥공사", "관광부", "통상부", "자원부", "통신부", "안전부", "고용부", "복지부", "환경부", "행정부", "기획부", "산업진흥원", "협력단", "연구원", "공사", "공단", "재단"];

function isOrgTag(tag) {
  if (tag.length < 4) return false;
  return ORG_SUFFIXES.some((s) => tag.endsWith(s));
}

function parseCategoryTags(category) {
  if (!category) return [];
  const tags = category.split(",").map((t) => t.trim()).filter(Boolean);
  // 태그가 1~2개이면 gov24 같은 깨끗한 카테고리 → 그대로 반환
  if (tags.length <= 2) return tags;
  // bizinfo 해시태그: 노이즈 제거
  return tags.filter((t) => {
    if (NOISE_TAGS.has(t)) return false;
    if (/^\d{4}$/.test(t)) return false; // 연도
    if (isOrgTag(t)) return false; // 기관명
    return true;
  });
}

const BIZINFO_DETAIL_BASE =
  "https://www.bizinfo.go.kr/web/lay1/bbs/S1T122C128/AS/74/view.do?pblancId=";

function resolveDetailUrl(a) {
  if (a.detailUrl) return a.detailUrl;
  if (a.id && a.id.startsWith("PBLN_")) return BIZINFO_DETAIL_BASE + a.id;
  return "";
}

// ──────────────────────────────────────
// 설정 (localStorage)
// ──────────────────────────────────────

const SETTINGS_KEY = "govbot_settings";

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return {
    activeProvider: "gemini",
    interestKeywords: [],
    gemini: { key: "", model: "gemini-2.5-flash" },
    openai: { key: "", model: "gpt-5-mini" },
    claude: { key: "", model: "claude-haiku-4-5-20241022" },
  };
}

function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function getActiveAI() {
  const s = loadSettings();
  const provider = s.activeProvider;
  const config = s[provider];
  return { provider, key: config?.key || "", model: config?.model || "" };
}

function getInterestKeywords() {
  return loadSettings().interestKeywords || [];
}

// ──────────────────────────────────────
// 다크모드
// ──────────────────────────────────────

function initDarkMode() {
  const saved = localStorage.getItem("govbot_dark");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isDark = saved === "true" || (saved === null && prefersDark);
  applyDarkMode(isDark);

  document.getElementById("toggle-dark").addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme") === "dark";
    applyDarkMode(!current);
    localStorage.setItem("govbot_dark", !current);
  });
}

function applyDarkMode(isDark) {
  document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
  document.getElementById("toggle-dark").textContent = isDark ? "☀️" : "🌙";
}

// ──────────────────────────────────────
// AI API 호출
// ──────────────────────────────────────

function buildSummaryPrompt(announcement) {
  let info = `사업명: ${announcement.title}\n`;
  info += `소관기관: ${announcement.organization}\n`;
  info += `분야: ${announcement.category}\n`;
  if (announcement.executor) info += `수행기관: ${announcement.executor}\n`;
  if (announcement.startDate) info += `접수 시작: ${announcement.startDate}\n`;
  if (announcement.endDate) info += `접수 마감: ${announcement.endDate}\n`;
  if (announcement.summary) info += `요약: ${announcement.summary}\n`;
  if (announcement.budget) info += `예산: ${Number(announcement.budget).toLocaleString()}원\n`;

  const typeLabel = currentChannel === "bids" ? "입찰공고" : "정부 지원사업 공고";
  return `다음 ${typeLabel}를 분석하여 간결하게 요약해줘.

${info}

아래 형식으로 3~5줄로 정리해줘:
- 지원 대상
- 지원 내용 (금액, 혜택 등)
- 신청 방법 또는 조건
- 핵심 포인트

정보가 부족하면 공고 제목과 소관기관을 바탕으로 추정하되, 추정임을 명시해줘.`;
}

async function callGemini(apiKey, model, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 500, temperature: 0.3 },
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Gemini API 오류 (${res.status})`);
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "요약 결과 없음";
}

async function callOpenAI(apiKey, model, prompt) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 500,
      temperature: 0.3,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `OpenAI API 오류 (${res.status})`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "요약 결과 없음";
}

async function callClaude(apiKey, model, prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model,
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Claude API 오류 (${res.status})`);
  }
  const data = await res.json();
  return data.content?.[0]?.text || "요약 결과 없음";
}

async function requestSummary(announcement) {
  const ai = getActiveAI();
  if (!ai.key) {
    throw new Error("API 키가 설정되지 않았습니다. ⚙️ 설정에서 키를 입력해주세요.");
  }
  const prompt = buildSummaryPrompt(announcement);
  if (ai.provider === "gemini") return await callGemini(ai.key, ai.model, prompt);
  if (ai.provider === "openai") return await callOpenAI(ai.key, ai.model, prompt);
  return await callClaude(ai.key, ai.model, prompt);
}

// ──────────────────────────────────────
// 초기화
// ──────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  initDarkMode();
  setupChannelTabs();
  setupFilters();
  setupSearch();
  setupSort();
  setupSettingsModal();
  loadData();
});

// ──────────────────────────────────────
// 채널 탭
// ──────────────────────────────────────

function setupChannelTabs() {
  document.getElementById("channel-tabs").addEventListener("click", (e) => {
    if (!e.target.classList.contains("channel-tab")) return;
    const channel = e.target.dataset.channel;
    if (channel === currentChannel) return;

    document.querySelectorAll(".channel-tab").forEach((t) => t.classList.remove("active"));
    e.target.classList.add("active");
    currentChannel = channel;
    currentCategory = "전체";
    currentSearch = "";
    document.getElementById("search").value = "";
    buildCategoryFilters();
    loadData();
  });
}

function buildCategoryFilters() {
  const container = document.getElementById("filters");
  // 태그별 빈도수 집계
  const tagCount = {};
  allAnnouncements.forEach((a) => {
    const tags = parseCategoryTags(a.category);
    const seen = new Set();
    tags.forEach((tag) => {
      if (!seen.has(tag)) {
        seen.add(tag);
        tagCount[tag] = (tagCount[tag] || 0) + 1;
      }
    });
  });

  // 빈도순 정렬 → 상위 12개 표시
  const topTags = Object.entries(tagCount)
    .filter(([, count]) => count >= 2) // 최소 2건 이상
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([tag]) => tag);

  let html =
    '<button class="filter-btn active" data-category="전체">전체</button>';
  topTags.forEach((tag) => {
    const count = tagCount[tag];
    html += `<button class="filter-btn" data-category="${escapeHtml(tag)}">${escapeHtml(tag)} <span class="filter-count">${count}</span></button>`;
  });
  container.innerHTML = html;
}

// ──────────────────────────────────────
// 데이터 로드
// ──────────────────────────────────────

async function loadData() {
  const channel = CHANNELS[currentChannel];
  const cardList = document.getElementById("card-list");
  cardList.innerHTML = '<div class="loading">공고를 불러오는 중...</div>';

  try {
    const response = await fetch(channel.url);
    if (!response.ok) throw new Error("데이터를 불러올 수 없습니다.");
    allAnnouncements = await response.json();
    buildCategoryFilters();
    render();
    updateLastUpdated();
  } catch (err) {
    allAnnouncements = [];
    buildCategoryFilters();
    cardList.innerHTML =
      `<div class="empty">${channel.label} 데이터를 불러올 수 없습니다.</div>`;
  }
}

function setupFilters() {
  document.getElementById("filters").addEventListener("click", (e) => {
    const btn = e.target.closest(".filter-btn");
    if (!btn) return;
    document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentCategory = btn.dataset.category;
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

// ──────────────────────────────────────
// 설정 모달
// ──────────────────────────────────────

let activeSettingsTab = "gemini";

function setupSettingsModal() {
  const modal = document.getElementById("settings-modal");
  const openBtn = document.getElementById("open-settings");
  const closeBtn = document.getElementById("close-settings");
  const saveBtn = document.getElementById("save-settings");

  openBtn.addEventListener("click", () => {
    populateSettings();
    modal.classList.add("open");
  });

  closeBtn.addEventListener("click", () => modal.classList.remove("open"));
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.classList.remove("open");
  });

  // Provider tabs
  document.querySelectorAll(".provider-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".provider-tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".provider-panel").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(`panel-${tab.dataset.provider}`).classList.add("active");
      activeSettingsTab = tab.dataset.provider;
    });
  });

  // Toggle key visibility
  document.querySelectorAll(".toggle-key-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = document.getElementById(btn.dataset.target);
      if (input.type === "password") {
        input.type = "text";
        btn.textContent = "🙈";
      } else {
        input.type = "password";
        btn.textContent = "👁";
      }
    });
  });

  // Save
  saveBtn.addEventListener("click", () => {
    const kwRaw = document.getElementById("interest-keywords").value;
    const keywords = kwRaw
      .split(",")
      .map((k) => k.trim())
      .filter((k) => k.length > 0);

    const settings = {
      activeProvider: activeSettingsTab,
      interestKeywords: keywords,
      gemini: {
        key: document.getElementById("gemini-key").value.trim(),
        model: document.getElementById("gemini-model").value,
      },
      openai: {
        key: document.getElementById("openai-key").value.trim(),
        model: document.getElementById("openai-model").value,
      },
      claude: {
        key: document.getElementById("claude-key").value.trim(),
        model: document.getElementById("claude-model").value,
      },
    };
    saveSettings(settings);
    modal.classList.remove("open");
    showToast("설정이 저장되었습니다.");
    render();
  });
}

function populateSettings() {
  const s = loadSettings();
  document.getElementById("interest-keywords").value = (s.interestKeywords || []).join(", ");
  document.getElementById("gemini-key").value = s.gemini?.key || "";
  document.getElementById("gemini-model").value = s.gemini?.model || "gemini-2.5-flash";
  document.getElementById("openai-key").value = s.openai?.key || "";
  document.getElementById("openai-model").value = s.openai?.model || "gpt-5-mini";
  document.getElementById("claude-key").value = s.claude?.key || "";
  document.getElementById("claude-model").value = s.claude?.model || "claude-haiku-4-5-20241022";

  // 활성 탭 복원
  activeSettingsTab = s.activeProvider || "gemini";
  document.querySelectorAll(".provider-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.provider === activeSettingsTab);
  });
  document.querySelectorAll(".provider-panel").forEach((p) => {
    p.classList.toggle("active", p.id === `panel-${activeSettingsTab}`);
  });
}

// ──────────────────────────────────────
// 관심 키워드 매칭
// ──────────────────────────────────────

function isInterestMatch(announcement) {
  const keywords = getInterestKeywords();
  if (keywords.length === 0) return false;
  const text = `${announcement.title} ${announcement.organization} ${announcement.category} ${announcement.executor || ""}`.toLowerCase();
  return keywords.some((kw) => text.includes(kw.toLowerCase()));
}

// ──────────────────────────────────────
// 렌더링
// ──────────────────────────────────────

function getFiltered() {
  let list = [...allAnnouncements];

  if (currentCategory !== "전체") {
    list = list.filter((a) => {
      if (!a.category) return false;
      const tags = parseCategoryTags(a.category);
      return tags.includes(currentCategory);
    });
  }

  if (currentSearch) {
    list = list.filter(
      (a) =>
        a.title.toLowerCase().includes(currentSearch) ||
        a.organization.toLowerCase().includes(currentSearch) ||
        (a.executor || "").toLowerCase().includes(currentSearch)
    );
  }

  if (currentSort === "dday") {
    list.sort((a, b) => a.dDay - b.dDay);
  } else if (currentSort === "regist") {
    list.sort((a, b) => (b.registDate || "").localeCompare(a.registDate || ""));
  }

  return list;
}

function render() {
  const list = getFiltered();
  const stats = document.getElementById("stats");
  const channelLabel = CHANNELS[currentChannel].label;

  stats.textContent = `${channelLabel} ${allAnnouncements.length}건 중 ${list.length}건 표시`;

  // 긴급 섹션 (D-3 이하)
  const urgent = list.filter((a) => a.dDay > 0 && a.dDay <= 3);
  const normal = list.filter((a) => !(a.dDay > 0 && a.dDay <= 3));

  const urgentSection = document.getElementById("urgent-section");
  const urgentList = document.getElementById("urgent-list");
  const normalList = document.getElementById("card-list");

  if (urgent.length > 0) {
    urgentSection.style.display = "block";
    urgentList.innerHTML = urgent.map((a) => createCard(a)).join("");
    urgentList.querySelectorAll(".btn-summary").forEach((btn) => {
      btn.addEventListener("click", handleSummaryClick);
    });
  } else {
    urgentSection.style.display = "none";
    urgentList.innerHTML = "";
  }

  if (normal.length === 0 && urgent.length === 0) {
    normalList.innerHTML = '<div class="empty">표시할 공고가 없습니다.</div>';
  } else {
    normalList.innerHTML = normal.map((a) => createCard(a)).join("");
    normalList.querySelectorAll(".btn-summary").forEach((btn) => {
      btn.addEventListener("click", handleSummaryClick);
    });
  }
}

function getSourceLabel(source) {
  const channel = CHANNELS[currentChannel];
  return channel.sourceLabels[source] || "";
}

function formatBudget(budget) {
  if (!budget || budget <= 0) return "";
  const num = Number(budget);
  if (num >= 100000000) return `${(num / 100000000).toFixed(1)}억`;
  if (num >= 10000) return `${(num / 10000).toFixed(0)}만`;
  return num.toLocaleString() + "원";
}

function getDisplayTags(a) {
  const tags = parseCategoryTags(a.category);
  if (tags.length === 0) return [a.category || "기타"];
  return tags.slice(0, 3);
}

function createCard(a) {
  const ddayInfo = getDdayInfo(a.dDay);
  const urgencyClass = a.dDay <= 3 ? "urgent" : a.dDay <= 7 ? "warning" : "";
  const highlightClass = isInterestMatch(a) ? "highlight" : "";
  const ai = getActiveAI();
  const hasKey = !!ai.key;
  const btnClass = hasKey ? "" : "no-key";
  const btnTitle = hasKey ? "AI로 공고 요약" : "설정에서 API 키를 입력하세요";
  const sourceLabel = getSourceLabel(a.source);
  const budgetStr = formatBudget(a.budget);
  const detailUrl = resolveDetailUrl(a);
  const displayTags = getDisplayTags(a);
  const tagsHtml = displayTags
    .map((t) => `<span class="card-tag">${escapeHtml(t)}</span>`)
    .join("");
  const executorHtml = a.executor
    ? `<span class="card-executor">${escapeHtml(a.executor)}</span>`
    : "";

  // 마감일 / 등록일 표시
  let dateHtml = "";
  if (a.endDate) {
    dateHtml = `<span class="card-date">~${formatDate(a.endDate)}</span>`;
  } else if (a.registDate) {
    dateHtml = `<span class="card-date">등록 ${formatDate(a.registDate)}</span>`;
  }

  // 요약 정보 표시 (gov24의 summary 필드)
  const summaryHtml = a.summary
    ? `<p class="card-summary">${escapeHtml(a.summary)}</p>`
    : "";

  // 상세보기 버튼 (URL이 있을 때만)
  const detailBtnHtml = detailUrl
    ? `<a class="btn btn-detail" href="${escapeHtml(detailUrl)}" target="_blank" rel="noopener">상세보기 ↗</a>`
    : "";

  return `
    <div class="card ${urgencyClass} ${highlightClass}">
      <div class="card-header">
        <span class="dday-badge ${ddayInfo.color}">${ddayInfo.text}</span>
        <span class="card-title">${detailUrl ? `<a href="${escapeHtml(detailUrl)}" target="_blank" rel="noopener">${escapeHtml(a.title)}</a>` : escapeHtml(a.title)}</span>
      </div>
      ${summaryHtml}
      <div class="card-meta">
        <div class="card-tags">${tagsHtml}</div>
        ${sourceLabel ? `<span class="card-source">${sourceLabel}</span>` : ""}
        <span class="card-org">${escapeHtml(a.organization)}</span>
        ${executorHtml}
        ${budgetStr ? `<span class="card-budget">${budgetStr}</span>` : ""}
        ${dateHtml}
      </div>
      <div class="card-actions">
        ${detailBtnHtml}
        <button class="btn btn-summary ${btnClass}" data-id="${escapeHtml(a.id)}" title="${btnTitle}">AI 요약</button>
      </div>
    </div>
  `;
}

async function handleSummaryClick(e) {
  const btn = e.currentTarget;
  const card = btn.closest(".card");
  const id = btn.dataset.id;

  const existing = card.querySelector(".summary-box");
  if (existing) { existing.remove(); return; }

  const ai = getActiveAI();
  if (!ai.key) {
    document.getElementById("settings-modal").classList.add("open");
    populateSettings();
    return;
  }

  const announcement = allAnnouncements.find((a) => a.id === id);
  if (!announcement) return;

  btn.classList.add("loading");
  btn.textContent = "요약 중...";

  try {
    const summary = await requestSummary(announcement);
    const labels = { gemini: "Gemini", openai: "ChatGPT", claude: "Claude" };
    const summaryHtml = `
      <div class="summary-box">
        <div class="summary-header">
          <span>${labels[ai.provider] || ai.provider} · ${ai.model}</span>
        </div>
        <div class="summary-content">${escapeHtml(summary)}</div>
      </div>
    `;
    card.insertAdjacentHTML("beforeend", summaryHtml);
  } catch (err) {
    card.insertAdjacentHTML("beforeend", `<div class="summary-error">${escapeHtml(err.message)}</div>`);
    setTimeout(() => {
      const errEl = card.querySelector(".summary-error");
      if (errEl) errEl.remove();
    }, 5000);
  } finally {
    btn.classList.remove("loading");
    btn.textContent = "AI 요약";
  }
}

// ──────────────────────────────────────
// 유틸
// ──────────────────────────────────────

function getDdayInfo(dDay) {
  if (dDay >= 999) return { text: "상시", color: "gray" };
  if (dDay <= 0) return { text: "마감", color: "red" };
  if (dDay <= 3) return { text: `D-${dDay}`, color: "red" };
  if (dDay <= 7) return { text: `D-${dDay}`, color: "yellow" };
  return { text: `D-${dDay}`, color: "green" };
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  // "2026-02-27 14:23:18" → "02.27"
  const match = dateStr.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[2]}.${match[3]}`;
  // "20201217142613" → "12.17"
  const match2 = dateStr.match(/^(\d{4})(\d{2})(\d{2})/);
  if (match2) return `${match2[2]}.${match2[3]}`;
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

function showToast(msg) {
  let toast = document.querySelector(".toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2500);
}
