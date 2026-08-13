const state = { repos: [], selected: null, session: null, poll: null, vncUrl: null, githubToken: sessionStorage.getItem("ino.githubToken") || "" };
const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char]));

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.githubToken && (path === "/api/auth/identity" || path === "/api/repositories")) headers.set("x-github-token", state.githubToken);
  if (options.body) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function selectRepo(repo) {
  state.selected = repo;
  $("summary-repo").textContent = repo.fullName;
  renderRepos();
}
function renderRepos() {
  const query = $("repo-search").value.trim().toLowerCase();
  const repos = state.repos.filter((repo) => repo.fullName.toLowerCase().includes(query));
  $("repo-count").textContent = `${repos.length} available`;
  $("repo-list").innerHTML = repos.map((repo) => `<button class="repo-option ${state.selected?.id === repo.id ? "selected" : ""}" data-repo-id="${escapeHtml(repo.id)}" type="button" role="option" aria-selected="${state.selected?.id === repo.id}"><span class="repo-glyph">&gt;_</span><span class="repo-copy"><strong>${escapeHtml(repo.fullName)}</strong><span>${repo.private ? "Private" : "Public"} · ${escapeHtml(repo.defaultBranch)}</span></span></button>`).join("") || `<div class="security-note" style="padding:14px">No repositories found.</div>`;
  document.querySelectorAll("[data-repo-id]").forEach((button) => button.addEventListener("click", () => selectRepo(state.repos.find((repo) => String(repo.id) === button.dataset.repoId))));
}
async function loadRepos() {
  showError("");
  $("load-repos").textContent = "Loading…";
  state.githubToken = $("github-token").value.trim();
  if (state.githubToken) sessionStorage.setItem("ino.githubToken", state.githubToken); else sessionStorage.removeItem("ino.githubToken");
  try {
    const [identity, repos] = await Promise.all([api("/api/auth/identity"), api("/api/repositories")]);
    state.repos = repos; state.selected = repos[0] || null;
    $("identity").innerHTML = `<span class="status-dot"></span><span>${escapeHtml(identity.login)} · ${identity.mode}</span>`;
    $("summary-repo").textContent = state.selected?.fullName || "Not selected";
    renderRepos();
  } catch (error) { showError(error.message); }
  finally { $("load-repos").textContent = "Load repos"; }
}
function showError(message) { $("form-error").textContent = message; }
function statusLabel(status) { return ({created:"Created",starting:"Starting",running:"Running",stopped:"Stopped",failed:"Failed"})[status] || status; }
function renderSession(session) {
  state.session = session;
  $("session-status").textContent = `${statusLabel(session.status)}${session.mode === "mock" ? " · demo" : ""}`;
  $("session-status").style.color = session.status === "failed" ? "var(--danger)" : session.status === "stopped" ? "var(--muted)" : "var(--accent)";
  $("updated-at").textContent = `Updated ${new Date(session.updatedAt).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"})}`;
  $("event-log").innerHTML = session.logs.map((event) => `<li class="event ${escapeHtml(event.type)}"><time>${new Date(event.at).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",second:"2-digit"})}</time><p>${escapeHtml(event.message)}</p></li>`).join("");
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
  $("message").disabled = session.status !== "running";
  if (terminal && state.poll) { clearInterval(state.poll); state.poll = null; }
}
async function pollSession() { if (!state.session) return; try { renderSession(await api(`/api/sessions/${state.session.id}`)); } catch (error) { console.error(error); } }
async function startSession(event) {
  event.preventDefault(); showError("");
  const key = $("openai-key").value.trim(); const prompt = $("prompt").value.trim();
  if (!state.selected) return showError("Choose a repository.");
  if (!key) return showError("Enter an OpenAI API key for Codex.");
  if (!prompt) return showError("Describe the task.");
  const button = $("start-session"); button.disabled = true; button.textContent = "Starting…";
  try {
    const session = await api("/api/sessions", {method:"POST", body:JSON.stringify({repo:state.selected,prompt})});
    $("setup").classList.add("hidden"); $("workspace").classList.remove("hidden");
    $("workspace-repo").textContent = session.repo.fullName; $("workspace-task").textContent = prompt; $("objective").textContent = prompt;
    history.replaceState(null, "", `?session=${encodeURIComponent(session.id)}`);
    renderSession(session);
    const started = await api(`/api/sessions/${session.id}/start`, {method:"POST", body:JSON.stringify({credentials:{openaiApiKey:key}})});
    $("openai-key").value = ""; renderSession(started);
    state.poll = setInterval(pollSession, 2000);
  } catch (error) { showError(error.message); $("setup").classList.remove("hidden"); $("workspace").classList.add("hidden"); }
  finally { button.disabled = false; button.innerHTML = "Start session <span>→</span>"; }
}
$("github-token").value = state.githubToken;
$("load-repos").addEventListener("click", loadRepos);
$("repo-search").addEventListener("input", renderRepos);
$("session-form").addEventListener("submit", startSession);
$("prompt").addEventListener("keydown", (event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") $("session-form").requestSubmit(); });
$("stop-session").addEventListener("click", async () => { if (state.session) renderSession(await api(`/api/sessions/${state.session.id}/stop`, {method:"POST"})); });
$("message-form").addEventListener("submit", async (event) => { event.preventDefault(); const message=$("message").value.trim(); if (!message || !state.session) return; renderSession(await api(`/api/sessions/${state.session.id}/message`, {method:"POST",body:JSON.stringify({message})})); $("message").value=""; });
async function restoreSession() {
  const id = new URLSearchParams(location.search).get("session");
  if (!id) return false;
  try {
    const session = await api(`/api/sessions/${encodeURIComponent(id)}`);
    $("setup").classList.add("hidden"); $("workspace").classList.remove("hidden");
    $("workspace-repo").textContent = session.repo.fullName; $("workspace-task").textContent = session.prompt; $("objective").textContent = session.prompt;
    renderSession(session);
    if (session.status === "running" || session.status === "starting") state.poll = setInterval(pollSession, 2000);
    return true;
  } catch { history.replaceState(null, "", location.pathname); return false; }
}
restoreSession().then((restored) => { if (!restored) loadRepos(); });
