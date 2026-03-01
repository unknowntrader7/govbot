/**
 * GovBot Fix 보드 — 프론트엔드 로직
 */

const DATA_URL = "data/announcements.json";

let allAnnouncements = [];
let currentCategory = "전체";
let currentSearch = "";
let currentSort = "dday";

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

  return `다음 정부 지원사업 공고를 분석하여 간결하게 요약해줘.

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
  loadData();
  setupFilters();
  setupSearch();
  setupSort();
  setupSettingsModal();
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
    list = list.filter((a) => a.category === currentCategory);
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

  stats.textContent = `총 ${allAnnouncements.length}건 중 ${list.length}건 표시`;

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

function createCard(a) {
  const ddayInfo = getDdayInfo(a.dDay);
  const urgencyClass = a.dDay <= 3 ? "urgent" : a.dDay <= 7 ? "warning" : "";
  const highlightClass = isInterestMatch(a) ? "highlight" : "";
  const ai = getActiveAI();
  const hasKey = !!ai.key;
  const btnClass = hasKey ? "" : "no-key";
  const btnTitle = hasKey ? "AI로 공고 요약" : "설정에서 API 키를 입력하세요";
  const sourceLabel = a.source === "bizinfo" ? "기업마당" : a.source === "gov24" ? "보조금24" : "";

  return `
    <div class="card ${urgencyClass} ${highlightClass}">
      <div class="card-header">
        <span class="dday-badge ${ddayInfo.color}">${ddayInfo.text}</span>
        <span class="card-title">${escapeHtml(a.title)}</span>
      </div>
      <div class="card-meta">
        <span><span class="card-category">${escapeHtml(a.category)}</span></span>
        ${sourceLabel ? `<span class="card-source">${sourceLabel}</span>` : ""}
        <span>${escapeHtml(a.organization)}</span>
        <span>~${formatDate(a.endDate)}</span>
      </div>
      <div class="card-actions">
        <a class="btn btn-detail" href="${escapeHtml(a.detailUrl)}" target="_blank" rel="noopener">상세보기</a>
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
