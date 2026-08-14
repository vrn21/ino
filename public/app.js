const STORAGE_KEYS = { github: "ino.githubToken", openai: "ino.openaiApiKey" };
const state = {
  repos: [], selected: null, session: null, poll: null, vncUrl: null,
  githubToken: localStorage.getItem(STORAGE_KEYS.github) || "",
  openaiApiKey: localStorage.getItem(STORAGE_KEYS.openai) || "",
};
const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.githubToken && (path === "/api/repositories" || /\/api\/sessions\/[^/]+\/start$/.test(path))) headers.set("x-github-token", state.githubToken);
  if (options.body) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function showPage(page) {
  $("setup").classList.toggle("hidden", page !== "setup");
  $("settings").classList.toggle("hidden", page !== "settings");
  $("workspace").classList.toggle("hidden", page !== "workspace");
}

function credentialStatus(hasValue) {
  return hasValue ? "Stored" : "Not stored";
}

function renderSettings() {
  const githubSaved = Boolean(state.githubToken);
  const openaiSaved = Boolean(state.openaiApiKey);
  $("github-status").textContent = credentialStatus(githubSaved);
  $("github-status").classList.toggle("saved", githubSaved);
  $("openai-status").textContent = credentialStatus(openaiSaved);
  $("openai-status").classList.toggle("saved", openaiSaved);
  $("delete-github").disabled = !githubSaved;
  $("delete-openai").disabled = !openaiSaved;
}

function settingsNotice(message = "") {
  $("settings-notice").textContent = message;
  $("settings-notice").classList.toggle("hidden", !message);
}

function selectRepo(repo) {
  state.selected = repo;
  $("selected-repo").textContent = repo.fullName;
  $("repo-picker").removeAttribute("open");
  renderRepos();
}

function renderRepos() {
  const query = $("repo-search").value.trim().toLowerCase();
  const repos = state.repos.filter((repo) => repo.fullName.toLowerCase().includes(query));
  $("repo-status").textContent = `${repos.length} available`;
  $("repo-list").innerHTML = repos.map((repo) => `<button class="repo-option ${state.selected?.id === repo.id ? "selected" : ""}" data-repo-id="${escapeHtml(repo.id)}" type="button" role="option" aria-selected="${state.selected?.id === repo.id}"><span class="repo-glyph">>_</span><span class="repo-copy"><strong>${escapeHtml(repo.fullName)}</strong><span>${repo.private ? "Private" : "Public"} · ${escapeHtml(repo.defaultBranch)}</span></span></button>`).join("") || '<div class="empty-repos">No repositories found.</div>';
  document.querySelectorAll("[data-repo-id]").forEach((button) => button.addEventListener("click", () => selectRepo(state.repos.find((repo) => String(repo.id) === button.dataset.repoId))));
}

async function loadRepos() {
  if (!state.githubToken) {
    state.repos = [];
    state.selected = null;
    $("repo-search").disabled = true;
    $("repo-status").textContent = "Add a GitHub token in Settings to load repositories.";
    $("repo-list").innerHTML = '<a class="empty-repos settings-inline-link" href="/settings">Open Settings</a>';
    $("selected-repo").textContent = "Choose repository";
    return;
  }
  $("repo-status").textContent = "Loading repositories…";
  $("repo-search").disabled = true;
  try {
    const repos = await api("/api/repositories");
    state.repos = repos;
    state.selected = repos.find((repo) => repo.id === state.selected?.id) || repos[0] || null;
    $("selected-repo").textContent = state.selected?.fullName || "Choose repository";
    $("repo-search").disabled = false;
    renderRepos();
  } catch (error) {
    state.repos = [];
    state.selected = null;
    $("repo-status").textContent = "Could not load repositories.";
    $("repo-list").innerHTML = `<div class="empty-repos">${escapeHtml(error.message)}</div>`;
    $("selected-repo").textContent = "Choose repository";
  }
}

function showError(message = "") { $("form-error").innerHTML = message; }
function statusLabel(status) { return ({ created: "Created", starting: "Starting", running: "Running", stopped: "Stopped", failed: "Failed" })[status] || status; }

function renderSession(session) {
  state.session = session;
  $("session-status").textContent = `${statusLabel(session.status)}${session.mode === "mock" ? " · demo" : ""}`;
  $("session-status").style.color = session.status === "failed" ? "var(--danger)" : session.status === "stopped" ? "var(--muted)" : "var(--accent)";
  $("updated-at").textContent = `Updated ${new Date(session.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  $("event-log").innerHTML = session.logs.map((event) => `<li class="event ${escapeHtml(event.type)}"><time>${new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time><p>${escapeHtml(event.message)}</p></li>`).join("");
  $("event-log").scrollTop = $("event-log").scrollHeight;
  let vncUrl = null;
  try { const candidate = new URL(session.vncUrl); if (candidate.protocol === "https:") vncUrl = candidate.href; } catch {}
  const hasVnc = Boolean(vncUrl && !vncUrl.includes(".invalid"));
  $("open-vnc").href = hasVnc ? vncUrl : "#";
  $("open-vnc").classList.toggle("hidden", !hasVnc);
  $("computer-empty").classList.toggle("hidden", hasVnc);
  $("vnc-frame").classList.toggle("hidden", !hasVnc);
  if (hasVnc && state.vncUrl !== vncUrl) { state.vncUrl = vncUrl; $("vnc-frame").src = vncUrl; }
  const terminal = session.status === "stopped" || session.status === "failed";
  $("stop-session").disabled = terminal;
  if (terminal && state.poll) { clearInterval(state.poll); state.poll = null; }
}

async function pollSession() {
  if (!state.session) return;
  try { renderSession(await api(`/api/sessions/${state.session.id}`)); } catch (error) { console.error(error); }
}

function missingCredentials() {
  const missing = [];
  if (!state.githubToken) missing.push("GitHub token");
  if (!state.openaiApiKey) missing.push("OpenAI API key");
  return missing;
}

function openSettingsForCredentials() {
  const missing = missingCredentials();
  if (!missing.length) return false;
  const message = `Save your ${missing.join(" and ")} in Settings before starting a session.`;
  showError(`${escapeHtml(message)} <a href="/settings">Open Settings</a>`);
  return true;
}

async function startSession(event) {
  event.preventDefault();
  showError("");
  if (openSettingsForCredentials()) return;
  const prompt = $("prompt").value.trim();
  if (!state.selected) return showError('Choose a repository or <a href="/settings">check your GitHub token</a>.');
  if (!prompt) return showError("Describe the task.");
  const button = $("start-session");
  button.disabled = true;
  button.textContent = "Starting…";
  try {
    // The GitHub token is deliberately absent from creation and all unrelated API calls.
    const session = await api("/api/sessions", { method: "POST", body: JSON.stringify({ repo: state.selected, prompt }) });
    showPage("workspace");
    $("workspace-repo").textContent = session.repo.fullName;
    $("workspace-task").textContent = prompt;
    $("objective").textContent = prompt;
    history.replaceState(null, "", `/?session=${encodeURIComponent(session.id)}`);
    renderSession(session);
    const started = await api(`/api/sessions/${session.id}/start`, { method: "POST", body: JSON.stringify({ credentials: { openaiApiKey: state.openaiApiKey } }) });
    renderSession(started);
    state.poll = setInterval(pollSession, 2000);
  } catch (error) {
    showPage("setup");
    showError(escapeHtml(error.message));
  } finally {
    button.disabled = false;
    button.innerHTML = "Start session <span>→</span>";
  }
}

function saveCredential(kind) {
  const input = $(kind === "github" ? "github-token" : "openai-key");
  const value = input.value.trim();
  if (!value) return settingsNotice("Paste a credential before saving.");
  const key = kind === "github" ? STORAGE_KEYS.github : STORAGE_KEYS.openai;
  localStorage.setItem(key, value);
  if (kind === "github") state.githubToken = value;
  else state.openaiApiKey = value;
  input.value = "";
  renderSettings();
  settingsNotice(`${kind === "github" ? "GitHub token" : "OpenAI API key"} saved in this browser.`);
  if (kind === "github") loadRepos();
}

function deleteCredential(kind) {
  const key = kind === "github" ? STORAGE_KEYS.github : STORAGE_KEYS.openai;
  localStorage.removeItem(key);
  if (kind === "github") state.githubToken = "";
  else state.openaiApiKey = "";
  renderSettings();
  settingsNotice(`${kind === "github" ? "GitHub token" : "OpenAI API key"} deleted from this browser.`);
  if (kind === "github") loadRepos();
}

async function restoreSession() {
  const id = new URLSearchParams(location.search).get("session");
  if (!id) return false;
  try {
    const session = await api(`/api/sessions/${encodeURIComponent(id)}`);
    showPage("workspace");
    $("workspace-repo").textContent = session.repo.fullName;
    $("workspace-task").textContent = session.prompt;
    $("objective").textContent = session.prompt;
    renderSession(session);
    if (session.status === "running" || session.status === "starting") state.poll = setInterval(pollSession, 2000);
    return true;
  } catch {
    history.replaceState(null, "", "/");
    return false;
  }
}

function navigate() {
  if (location.pathname === "/settings") {
    showPage("settings");
    renderSettings();
    return;
  }
  restoreSession().then((restored) => {
    if (!restored) {
      showPage("setup");
      loadRepos();
    }
  });
}

document.addEventListener("click", (event) => {
  const link = event.target.closest('a[href="/"], a[href="/settings"]');
  if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  history.pushState(null, "", link.getAttribute("href"));
  navigate();
});
window.addEventListener("popstate", navigate);
$("repo-search").addEventListener("input", renderRepos);
$("session-form").addEventListener("submit", startSession);
$("prompt").addEventListener("keydown", (event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") $("session-form").requestSubmit(); });
$("stop-session").addEventListener("click", async () => { if (state.session) renderSession(await api(`/api/sessions/${state.session.id}/stop`, { method: "POST" })); });
$("save-github").addEventListener("click", () => saveCredential("github"));
$("delete-github").addEventListener("click", () => deleteCredential("github"));
$("save-openai").addEventListener("click", () => saveCredential("openai"));
$("delete-openai").addEventListener("click", () => deleteCredential("openai"));
navigate();
