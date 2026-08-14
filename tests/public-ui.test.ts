import { expect, test } from "bun:test";

const index = await Bun.file(new URL("../public/index.html", import.meta.url)).text();
const app = await Bun.file(new URL("../public/app.js", import.meta.url)).text();
const styles = await Bun.file(new URL("../public/styles.css", import.meta.url)).text();

function section(id: string, nextId: string): string {
  return index.slice(index.indexOf(`id="${id}"`), index.indexOf(`id="${nextId}"`));
}

test("home is a compact composer with an integrated repository chooser and icon submit", () => {
  const home = section("setup", "settings");
  expect(home).toContain('class="composer-wrap"');
  expect(home).toContain('id="prompt"');
  expect(home).toContain('id="repo-picker"');
  expect(home).toContain('class="composer-footer"');
  expect(home).toContain('id="start-session" class="send"');
  expect(home).toContain('aria-label="Start session"');
  expect(home).toContain('id="repo-list"');
  expect(home).not.toContain('id="github-token"');
  expect(home).not.toContain('id="openai-key"');
  expect(home).not.toContain('class="intro"');
  expect(styles).toContain('.setup-page{display:grid;place-items:center');
  expect(styles).toContain('.composer{position:relative;border:1px solid var(--line2);border-radius:14px');
});

test("settings has provider cards, status badges, scoped actions, and persistence guidance", () => {
  const settings = section("settings", "workspace");
  expect(settings).toContain('class="settings-card"');
  expect(settings).toContain('class="provider-icon"');
  expect(settings).toContain('class="credential-status"');
  expect(settings).toContain('class="card-actions"');
  expect(settings).toContain('class="credential-editor"');
  expect(settings).toContain('class="security-copy"');
  expect(settings).toContain('class="persistence-notice"');
  expect(settings).toContain("Stored in this browser only");
  expect(styles).toContain('@media(max-width:600px)');
  expect(styles).toContain('.card-head{padding:16px;flex-wrap:wrap}');
});

test("settings persists credentials locally without rendering saved values", () => {
  expect(app).toContain('localStorage.setItem(key, value)');
  expect(app).toContain('input.value = ""');
  expect(app).toContain('return hasValue ? "Stored" : "Not stored"');
  expect(app).toContain('classList.toggle("saved", githubSaved)');
  expect(app).toContain('localStorage.removeItem(key)');
});

test("GitHub token is only attached to repository and session-start calls", () => {
  expect(app).toContain('path === "/api/repositories" || /\\/api\\/sessions\\/[^/]+\\/start$/.test(path)');
  expect(app).not.toContain('path === "/api/auth/identity"');
  expect(app).toContain('credentials: { openaiApiKey: state.openaiApiKey }');
});

test("missing credentials direct the user to settings and settings is an SPA route", () => {
  expect(app).toContain('Save your ${missing.join(" and ")} in Settings before starting a session.');
  expect(app).toContain('if (location.pathname === "/settings")');
  expect(index).toContain('href="/settings"');
  expect(app).toContain('$("repo-picker").removeAttribute("open")');
});
