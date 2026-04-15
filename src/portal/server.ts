import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AppConfig } from "../config.js";
import type { TelemetryProjectRepository } from "../db/repositories/telemetry-project-repo.js";
import type { TelemetryReportRepository } from "../db/repositories/telemetry-report-repo.js";
import type { Logger } from "../logger.js";
import {
  buildClearedSessionCookie,
  buildSessionCookie,
  createPortalSession,
  parseCookieHeader,
  portalSessionCookieName,
  verifyPortalSession
} from "./auth.js";

interface TelemetryPortalDependencies {
  config: AppConfig;
  logger: Logger;
  telemetryProjectRepo: TelemetryProjectRepository;
  telemetryReportRepo: TelemetryReportRepository;
}

export class TelemetryPortalServer {
  private server: Server | null = null;
  private readonly basePath: string;

  public constructor(private readonly deps: TelemetryPortalDependencies) {
    this.basePath = normalizeBasePath(this.deps.config.TELEMETRY_PORTAL_BASE_PATH);
  }

  public async start(): Promise<void> {
    if (!this.deps.config.TELEMETRY_PORTAL_ENABLED || this.server) {
      return;
    }
    if (!this.deps.config.TELEMETRY_PORTAL_ADMIN_TOKEN || !this.deps.config.TELEMETRY_PORTAL_SESSION_SECRET) {
      throw new Error("Telemetry portal requires TELEMETRY_PORTAL_ADMIN_TOKEN and TELEMETRY_PORTAL_SESSION_SECRET.");
    }

    this.server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      if (!server) {
        reject(new Error("Telemetry portal server was not created."));
        return;
      }
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.deps.config.TELEMETRY_PORTAL_PORT, this.deps.config.TELEMETRY_PORTAL_BIND_HOST);
    });

    this.deps.logger.info(
      {
        host: this.deps.config.TELEMETRY_PORTAL_BIND_HOST,
        port: this.deps.config.TELEMETRY_PORTAL_PORT,
        basePath: this.basePath
      },
      "Telemetry portal started"
    );
  }

  public async stop(): Promise<void> {
    const active = this.server;
    this.server = null;
    if (!active) {
      return;
    }
    await new Promise<void>((resolve) => active.close(() => resolve()));
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const path = url.pathname;
    if (!path.startsWith(this.basePath)) {
      writeText(response, 404, "Not found");
      return;
    }

    if (path === `${this.basePath}/login`) {
      if (request.method === "GET") {
        writeHtml(response, 200, renderLoginPage(this.basePath, url.searchParams.get("error") ?? undefined));
        return;
      }
      if (request.method === "POST") {
        await this.handleLogin(request, response);
        return;
      }
    }

    if (path === `${this.basePath}/logout` && request.method === "POST") {
      response.setHeader("Set-Cookie", buildClearedSessionCookie());
      redirect(response, `${this.basePath}/login`);
      return;
    }

    if (!this.isAuthenticated(request)) {
      redirect(response, `${this.basePath}/login`);
      return;
    }

    if (path === this.basePath || path === `${this.basePath}/projects`) {
      if (request.method === "GET") {
        await this.renderProjectsPage(response, url.searchParams.get("createdKey") ?? undefined);
        return;
      }
      if (request.method === "POST") {
        await this.handleCreateProject(request, response);
        return;
      }
    }

    if (path === `${this.basePath}/api/projects` && request.method === "GET") {
      writeJson(response, 200, { projects: await this.deps.telemetryProjectRepo.listProjects() });
      return;
    }

    const projectMatch = path.match(new RegExp(`^${escapeRegExp(this.basePath)}/projects/([^/]+)$`));
    if (projectMatch && request.method === "GET") {
      await this.renderProjectPage(response, decodeURIComponent(projectMatch[1] ?? ""), url);
      return;
    }

    const projectApiMatch = path.match(new RegExp(`^${escapeRegExp(this.basePath)}/api/projects/([^/]+)$`));
    if (projectApiMatch && request.method === "GET") {
      const projectId = decodeURIComponent(projectApiMatch[1] ?? "");
      const project = await this.deps.telemetryProjectRepo.getProject(projectId);
      if (!project) {
        writeJson(response, 404, { error: "project_not_found" });
        return;
      }
      writeJson(response, 200, { project });
      return;
    }

    const reportsApiMatch = path.match(new RegExp(`^${escapeRegExp(this.basePath)}/api/projects/([^/]+)/reports$`));
    if (reportsApiMatch && request.method === "GET") {
      const projectId = decodeURIComponent(reportsApiMatch[1] ?? "");
      const reports = await this.deps.telemetryReportRepo.listReports(buildReportFilters(projectId, url, 200));
      writeJson(response, 200, { reports });
      return;
    }

    const metricsApiMatch = path.match(new RegExp(`^${escapeRegExp(this.basePath)}/api/projects/([^/]+)/metrics$`));
    if (metricsApiMatch && request.method === "GET") {
      const projectId = decodeURIComponent(metricsApiMatch[1] ?? "");
      const metrics = await this.deps.telemetryReportRepo.getMetrics(projectId);
      writeJson(response, 200, { metrics });
      return;
    }

    const rotateMatch = path.match(new RegExp(`^${escapeRegExp(this.basePath)}/projects/([^/]+)/key/refresh$`));
    if (rotateMatch && request.method === "POST") {
      const projectId = decodeURIComponent(rotateMatch[1] ?? "");
      const rotated = await this.deps.telemetryProjectRepo.rotateProjectKey(projectId);
      writeHtml(response, 200, renderKeyCreatedPage(this.basePath, projectId, rotated.projectKey, "Project key rotated."));
      return;
    }

    const discordMatch = path.match(new RegExp(`^${escapeRegExp(this.basePath)}/projects/([^/]+)/discord$`));
    if (discordMatch && request.method === "POST") {
      const projectId = decodeURIComponent(discordMatch[1] ?? "");
      const form = await readForm(request);
      await this.deps.telemetryProjectRepo.updateDiscordRoute(projectId, {
        guildId: emptyToNull(form.get("guildId")),
        channelId: requiredFormValue(form, "channelId"),
        mentionRoleId: emptyToNull(form.get("mentionRoleId"))
      });
      redirect(response, `${this.basePath}/projects/${encodeURIComponent(projectId)}?saved=discord`);
      return;
    }

    writeText(response, 404, "Not found");
  }

  private async handleLogin(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const form = await readForm(request);
    const token = requiredFormValue(form, "token");
    if (token !== this.deps.config.TELEMETRY_PORTAL_ADMIN_TOKEN) {
      redirect(response, `${this.basePath}/login?error=invalid-token`);
      return;
    }
    const session = createPortalSession(this.deps.config.TELEMETRY_PORTAL_SESSION_SECRET!);
    response.setHeader("Set-Cookie", buildSessionCookie(session.value));
    redirect(response, `${this.basePath}/projects`);
  }

  private isAuthenticated(request: IncomingMessage): boolean {
    const cookies = parseCookieHeader(request.headers.cookie);
    return (
      verifyPortalSession(cookies[portalSessionCookieName()], this.deps.config.TELEMETRY_PORTAL_SESSION_SECRET!) != null
    );
  }

  private async renderProjectsPage(response: ServerResponse, createdKey?: string): Promise<void> {
    const projects = await this.deps.telemetryProjectRepo.listProjects();
    writeHtml(response, 200, renderProjectsPage(this.basePath, projects, createdKey));
  }

  private async renderProjectPage(response: ServerResponse, projectId: string, url: URL): Promise<void> {
    const project = await this.deps.telemetryProjectRepo.getProject(projectId);
    if (!project) {
      writeText(response, 404, "Project not found");
      return;
    }
    const reports = await this.deps.telemetryReportRepo.listReports({
      ...buildReportFilters(projectId, url, 100)
    });
    const groups = await this.deps.telemetryReportRepo.listCrashGroups(projectId, 50);
    const metrics = await this.deps.telemetryReportRepo.getMetrics(projectId);
    writeHtml(
      response,
      200,
      renderProjectPage(this.basePath, project, metrics, reports, groups, url.searchParams.get("saved") ?? undefined)
    );
  }

  private async handleCreateProject(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const form = await readForm(request);
    const created = await this.deps.telemetryProjectRepo.createProject({
      projectId: requiredFormValue(form, "projectId"),
      displayName: requiredFormValue(form, "displayName"),
      channelId: requiredFormValue(form, "channelId"),
      guildId: emptyToNull(form.get("guildId")),
      mentionRoleId: emptyToNull(form.get("mentionRoleId"))
    });
    writeHtml(
      response,
      200,
      renderKeyCreatedPage(this.basePath, created.project.projectId, created.projectKey, "Project created.")
    );
  }
}

function normalizeBasePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return "/portal";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function writeText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(body);
}

function writeHtml(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(body);
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(body));
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, { Location: location });
  response.end();
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function requiredFormValue(form: URLSearchParams, key: string): string {
  const value = form.get(key)?.trim();
  if (!value) {
    throw new Error(`Missing required form field: ${key}`);
  }
  return value;
}

function emptyToNull(value: string | null): string | null {
  return value && value.trim() ? value.trim() : null;
}

function escapeHtml(value: string | null | undefined): string {
  if (value == null) {
    return "";
  }
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: Inter, Segoe UI, Arial, sans-serif; margin: 0; padding: 24px; background: #0f172a; color: #e2e8f0; }
    a { color: #93c5fd; }
    h1,h2,h3 { margin-top: 0; }
    .card { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
    .grid { display: grid; gap: 16px; }
    .metrics { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
    input, select, button, textarea { width: 100%; padding: 10px; border-radius: 8px; border: 1px solid #334155; background: #0b1220; color: #e2e8f0; }
    button { cursor: pointer; background: #1d4ed8; border: none; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { text-align: left; padding: 8px; border-bottom: 1px solid #1f2937; vertical-align: top; }
    .muted { color: #94a3b8; }
    .row { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
    code { background: #020617; padding: 2px 6px; border-radius: 6px; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

function renderLoginPage(basePath: string, error?: string): string {
  return renderShell(
    "Telemetry Portal Login",
    `<div class="card" style="max-width: 420px; margin: 40px auto;">
      <h1>Telemetry Portal Login</h1>
      <p class="muted">Internal alpha admin login.</p>
      ${error ? `<p style="color:#fca5a5;">Invalid admin token.</p>` : ""}
      <form method="post" action="${basePath}/login">
        <label>Admin token</label>
        <input type="password" name="token" autocomplete="current-password" required />
        <div style="margin-top: 12px;"><button type="submit">Sign in</button></div>
      </form>
    </div>`
  );
}

function renderProjectsPage(basePath: string, projects: any[], createdKey?: string): string {
  const rows = projects
    .map(
      (project) => `<tr>
        <td><a href="${basePath}/projects/${encodeURIComponent(project.projectId)}">${escapeHtml(project.displayName)}</a><br/><span class="muted"><code>${escapeHtml(project.projectId)}</code></span></td>
        <td>${project.enabled ? "enabled" : "disabled"}</td>
        <td>${escapeHtml(project.activeKeyPreview ?? "none")}</td>
        <td>${escapeHtml(project.channelId ?? "not configured")}</td>
      </tr>`
    )
    .join("");
  return renderShell(
    "Telemetry Projects",
    `<div style="display:flex; justify-content:space-between; align-items:center; gap:16px;">
      <div>
        <h1>Telemetry Projects</h1>
        <p class="muted">Internal alpha portal for hosted telemetry administration.</p>
      </div>
      <form method="post" action="${basePath}/logout"><button type="submit">Log out</button></form>
    </div>
    ${createdKey ? `<div class="card"><strong>New project key:</strong> <code>${escapeHtml(createdKey)}</code></div>` : ""}
    <div class="card">
      <h2>Create project</h2>
      <form method="post" action="${basePath}/projects">
        <div class="row">
          <div><label>Project ID</label><input name="projectId" required /></div>
          <div><label>Display name</label><input name="displayName" required /></div>
          <div><label>Discord guild ID</label><input name="guildId" /></div>
          <div><label>Discord channel ID</label><input name="channelId" required /></div>
          <div><label>Mention role ID</label><input name="mentionRoleId" /></div>
        </div>
        <div style="margin-top:12px;"><button type="submit">Create project</button></div>
      </form>
    </div>
    <div class="card">
      <h2>Projects</h2>
      <table>
        <thead><tr><th>Project</th><th>Status</th><th>Active key</th><th>Discord channel</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="4" class="muted">No hosted projects yet.</td></tr>`}</tbody>
      </table>
    </div>`
  );
}

function renderProjectPage(basePath: string, project: any, metrics: any, reports: any[], groups: any[], saved?: string): string {
  const reportRows = reports
    .map(
      (report) => `<tr>
        <td>${escapeHtml(report.receivedAt)}</td>
        <td><code>${escapeHtml(report.fingerprint)}</code></td>
        <td>${escapeHtml(report.exceptionType ?? "unknown")}</td>
        <td>${escapeHtml(report.pluginVersion ?? "unknown")}</td>
        <td>${escapeHtml(report.source ?? "unknown")}</td>
        <td>${report.occurrenceCount}</td>
      </tr>`
    )
    .join("");
  const groupRows = groups
    .map(
      (group) => `<tr>
        <td><code>${escapeHtml(group.fingerprint)}</code></td>
        <td>${escapeHtml(group.latestExceptionType ?? "unknown")}</td>
        <td>${escapeHtml(group.latestPluginVersion ?? "unknown")}</td>
        <td>${group.occurrenceCount}</td>
        <td>${escapeHtml(group.lastSeenAt)}</td>
      </tr>`
    )
    .join("");
  return renderShell(
    `${project.displayName} · Telemetry Portal`,
    `<p><a href="${basePath}/projects">Back to projects</a></p>
    <div style="display:flex; justify-content:space-between; align-items:center; gap:16px;">
      <div>
        <h1>${escapeHtml(project.displayName)}</h1>
        <p class="muted"><code>${escapeHtml(project.projectId)}</code> · active key: <code>${escapeHtml(project.activeKeyPreview ?? "none")}</code></p>
      </div>
      <form method="post" action="${basePath}/projects/${encodeURIComponent(project.projectId)}/key/refresh">
        <button type="submit">Refresh project key</button>
      </form>
    </div>
    ${saved ? `<div class="card">Saved: ${escapeHtml(saved)}</div>` : ""}
    <div class="grid metrics">
      <div class="card"><strong>Reports 24h</strong><div>${metrics.reports24h}</div></div>
      <div class="card"><strong>Reports 7d</strong><div>${metrics.reports7d}</div></div>
      <div class="card"><strong>Reports 30d</strong><div>${metrics.reports30d}</div></div>
      <div class="card"><strong>Unique fingerprints 24h</strong><div>${metrics.uniqueFingerprints24h}</div></div>
      <div class="card"><strong>Unique fingerprints 7d</strong><div>${metrics.uniqueFingerprints7d}</div></div>
      <div class="card"><strong>Unique fingerprints 30d</strong><div>${metrics.uniqueFingerprints30d}</div></div>
    </div>
    <div class="card">
      <h2>Discord routing</h2>
      <form method="post" action="${basePath}/projects/${encodeURIComponent(project.projectId)}/discord">
        <div class="row">
          <div><label>Guild ID</label><input name="guildId" value="${escapeHtml(project.guildId ?? "")}" /></div>
          <div><label>Channel ID</label><input name="channelId" value="${escapeHtml(project.channelId ?? "")}" required /></div>
          <div><label>Mention role ID</label><input name="mentionRoleId" value="${escapeHtml(project.mentionRoleId ?? "")}" /></div>
        </div>
        <div style="margin-top:12px;"><button type="submit">Save Discord routing</button></div>
      </form>
    </div>
    <div class="card">
      <h2>Top recurring fingerprints</h2>
      <ul>${metrics.topRecurringFingerprints.map((row: any) => `<li><code>${escapeHtml(row.fingerprint)}</code> · ${row.occurrenceCount}</li>`).join("") || `<li class="muted">No reports yet.</li>`}</ul>
    </div>
    <div class="card">
      <h2>Chronological reports</h2>
      <table>
        <thead><tr><th>Received</th><th>Fingerprint</th><th>Exception</th><th>Plugin version</th><th>Source</th><th>Occurrences</th></tr></thead>
        <tbody>${reportRows || `<tr><td colspan="6" class="muted">No reports yet.</td></tr>`}</tbody>
      </table>
    </div>
    <div class="card">
      <h2>Crash groups</h2>
      <table>
        <thead><tr><th>Fingerprint</th><th>Exception</th><th>Plugin version</th><th>Occurrences</th><th>Last seen</th></tr></thead>
        <tbody>${groupRows || `<tr><td colspan="5" class="muted">No crash groups yet.</td></tr>`}</tbody>
      </table>
    </div>`
  );
}

function renderKeyCreatedPage(basePath: string, projectId: string, projectKey: string, heading: string): string {
  return renderShell(
    heading,
    `<div class="card" style="max-width: 720px; margin: 32px auto;">
      <h1>${escapeHtml(heading)}</h1>
      <p class="muted">Copy this project key now. It will not be shown again in full.</p>
      <p><code>${escapeHtml(projectKey)}</code></p>
      <p><a href="${basePath}/projects/${encodeURIComponent(projectId)}">Return to project</a></p>
    </div>`
  );
}

function buildReportFilters(projectId: string, url: URL, limit: number) {
  const filters: import("../db/repositories/telemetry-report-repo.js").TelemetryReportFilters = {
    projectId,
    limit
  };
  const fingerprint = url.searchParams.get("fingerprint");
  const exceptionType = url.searchParams.get("exceptionType");
  const pluginVersion = url.searchParams.get("pluginVersion");
  const source = url.searchParams.get("source");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const sort = url.searchParams.get("sort");
  if (fingerprint) {
    filters.fingerprint = fingerprint;
  }
  if (exceptionType) {
    filters.exceptionType = exceptionType;
  }
  if (pluginVersion) {
    filters.pluginVersion = pluginVersion;
  }
  if (source) {
    filters.source = source;
  }
  if (from) {
    filters.from = from;
  }
  if (to) {
    filters.to = to;
  }
  if (sort === "received_asc" || sort === "last_seen_desc" || sort === "occurrence_desc" || sort === "received_desc") {
    filters.sort = sort;
  }
  const requestedLimit = url.searchParams.get("limit");
  if (requestedLimit) {
    const parsed = Number.parseInt(requestedLimit, 10);
    if (Number.isFinite(parsed)) {
      filters.limit = parsed;
    }
  }
  return filters;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
