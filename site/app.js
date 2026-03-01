/**
 * GovBot Fix 보드 — 프론트엔드 로직
 */

const DATA_URL = "data/announcements.json";

let allAnnouncements = [];
let currentCategory = "전체";
let currentSearch = "";
let currentSort = "dday";

// ──────────────────────────────────────
// AI 설정 (localStorage 기반)
// ──────────────────────────────────────

const AI_SETTINGS_KEY = "govbot_ai_settings";

function loadAISettings() {
  try {
    const raw = localStorage.getItem(AI_SETTINGS_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return {
    activeProvider: "gemini",
    gemini: { key: "", model: "gemini-2.0-flash" },
    openai: { key: "", model: "gpt-4o-mini" },
  };
}

function saveAISettings(settings) {
  localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(settings));
}

function getActiveAI() {
  const s = loadAISettings();
  const provider = s.activeProvider;
  const config = s[provider];
  return { provider, key: config.key, model: config.model };
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
      model: model,
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

async function requestSummary(announcement) {
  const ai = getActiveAI();
  if (!ai.key) {
    throw new Error("API 키가 설정되지 않았습니다. ⚙️ 설정에서 키를 입력해주세요.");
  }

  const prompt = buildSummaryPrompt(announcement);

  if (ai.provider === "gemini") {
    return await callGemini(ai.key, ai.model, prompt);
  } else {
    return await callOpenAI(ai.key, ai.model, prompt);
  }
}

// ──────────────────────────────────────
// 초기화
// ──────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
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
    const settings = {
      activeProvider: document.querySelector('input[name="active-provider"]:checked').value,
      gemini: {
        key: document.getElementById("gemini-key").value.trim(),
        model: document.getElementById("gemini-model").value,
      },
      openai: {
        key: document.getElementById("openai-key").value.trim(),
        model: document.getElementById("openai-model").value,
      },
    };
    saveAISettings(settings);
    modal.classList.remove("open");
    showToast("AI 설정이 저장되었습니다.");
    render(); // 버튼 상태 업데이트
  });
}

function populateSettings() {
  const s = loadAISettings();
  document.getElementById("gemini-key").value = s.gemini.key;
  document.getElementById("gemini-model").value = s.gemini.model;
  document.getElementById("openai-key").value = s.openai.key;
  document.getElementById("openai-model").value = s.openai.model;
  document.querySelector(`input[name="active-provider"][value="${s.activeProvider}"]`).checked = true;
}

// ──────────────────────────────────────
// 렌더링
// ──────────────────────────────────────

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
        (a.executor || "").toLowerCase().includes(currentSearch)
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

  container.innerHTML = list.map((a, idx) => createCard(a, idx)).join("");

  // AI 요약 버튼 이벤트 바인딩
  container.querySelectorAll(".btn-summary").forEach((btn) => {
    btn.addEventListener("click", handleSummaryClick);
  });
}

function createCard(a, idx) {
  const ddayInfo = getDdayInfo(a.dDay);
  const urgencyClass = a.dDay <= 3 ? "urgent" : a.dDay <= 7 ? "warning" : "";
  const ai = getActiveAI();
  const hasKey = !!ai.key;
  const btnClass = hasKey ? "" : "no-key";
  const btnTitle = hasKey ? "AI로 공고 요약" : "⚙️ 설정에서 API 키를 입력하세요";

  return `
    <div class="card ${urgencyClass}" data-idx="${idx}">
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
        <button class="btn btn-summary ${btnClass}" data-id="${escapeHtml(a.id)}" title="${btnTitle}">AI 요약</button>
      </div>
    </div>
  `;
}

async function handleSummaryClick(e) {
  const btn = e.currentTarget;
  const card = btn.closest(".card");
  const id = btn.dataset.id;

  // 이미 요약이 있으면 토글
  const existing = card.querySelector(".summary-box");
  if (existing) {
    existing.remove();
    return;
  }

  // API 키 확인
  const ai = getActiveAI();
  if (!ai.key) {
    document.getElementById("settings-modal").classList.add("open");
    populateSettings();
    return;
  }

  // 해당 공고 찾기
  const announcement = allAnnouncements.find((a) => a.id === id);
  if (!announcement) return;

  // 로딩 상태
  btn.classList.add("loading");
  btn.textContent = "요약 중...";

  try {
    const summary = await requestSummary(announcement);

    const providerLabel = ai.provider === "gemini" ? "Gemini" : "ChatGPT";
    const summaryHtml = `
      <div class="summary-box">
        <div class="summary-header">
          <span>${providerLabel} · ${ai.model}</span>
        </div>
        <div class="summary-content">${escapeHtml(summary)}</div>
      </div>
    `;
    card.insertAdjacentHTML("beforeend", summaryHtml);
  } catch (err) {
    const errorHtml = `<div class="summary-error">⚠️ ${escapeHtml(err.message)}</div>`;
    card.insertAdjacentHTML("beforeend", errorHtml);
    // 5초 후 에러 메시지 제거
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
