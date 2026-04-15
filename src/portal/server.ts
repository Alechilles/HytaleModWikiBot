import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AppConfig } from "../config.js";
import type { TelemetryAuditLogRepository } from "../db/repositories/telemetry-audit-log-repo.js";
import type { TelemetryMembershipRepository, TelemetryPortalRole, TelemetryPortalUser } from "../db/repositories/telemetry-membership-repo.js";
import type { TelemetryProjectRepository } from "../db/repositories/telemetry-project-repo.js";
import type {
  TelemetryGroupRow,
  TelemetryProjectMetrics,
  TelemetryReportDetail,
  TelemetryReportRow,
  TelemetryReportFilters,
  TelemetryReportRepository
} from "../db/repositories/telemetry-report-repo.js";
import type { Logger } from "../logger.js";
import {
  buildClearedOAuthStateCookie,
  buildClearedSessionCookie,
  buildCsrfHiddenInput,
  buildOAuthAuthorizeUrl,
  buildOAuthStateCookie,
  buildSessionCookie,
  createOAuthState,
  createPortalSession,
  exchangeDiscordCode,
  fetchDiscordIdentity,
  oauthStateCookieName,
  parseCookieHeader,
  portalSessionCookieName,
  splitCsvList,
  verifyCsrfToken,
  verifyOAuthState,
  verifyPortalSession,
  type PortalSession
} from "./auth.js";

interface TelemetryPortalDependencies {
  config: AppConfig;
  logger: Logger;
  telemetryProjectRepo: TelemetryProjectRepository;
  telemetryReportRepo: TelemetryReportRepository;
  telemetryMembershipRepo: TelemetryMembershipRepository;
  telemetryAuditLogRepo: TelemetryAuditLogRepository;
}

interface AuthenticatedContext {
  session: PortalSession;
  user: TelemetryPortalUser;
  memberships: Array<{ projectId: string; role: TelemetryPortalRole }>;
}

const MUTATING_ROLES: TelemetryPortalRole[] = ["owner", "admin", "maintainer"];
const ADMIN_ROLES: TelemetryPortalRole[] = ["owner", "admin"];

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
    if (
      !this.deps.config.TELEMETRY_PORTAL_SESSION_SECRET ||
      !this.deps.config.TELEMETRY_PORTAL_OAUTH_CLIENT_ID ||
      !this.deps.config.TELEMETRY_PORTAL_OAUTH_CLIENT_SECRET ||
      !this.deps.config.TELEMETRY_PORTAL_OAUTH_REDIRECT_URI
    ) {
      throw new Error(
        "Telemetry portal requires TELEMETRY_PORTAL_SESSION_SECRET, TELEMETRY_PORTAL_OAUTH_CLIENT_ID, TELEMETRY_PORTAL_OAUTH_CLIENT_SECRET, and TELEMETRY_PORTAL_OAUTH_REDIRECT_URI."
      );
    }

    this.server = createServer((request, response) => {
      void this.handleRequest(request, response).catch((error) => {
        this.deps.logger.error({ err: error }, "Unhandled telemetry portal request error");
        if (!response.headersSent) {
          writeText(response, 500, "Internal server error");
        } else {
          response.end();
        }
      });
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

    setPortalHeaders(response);
    const cookies = parseCookieHeader(request.headers.cookie);

    if (path === `${this.basePath}/login` && request.method === "GET") {
      writeHtml(response, 200, renderLoginPage(this.basePath, url.searchParams.get("error") ?? undefined));
      return;
    }

    if (path === `${this.basePath}/auth/discord/start` && request.method === "GET") {
      await this.handleDiscordStart(response);
      return;
    }

    if (path === `${this.basePath}/auth/discord/callback` && request.method === "GET") {
      await this.handleDiscordCallback(url, cookies, response);
      return;
    }

    if (path === `${this.basePath}/logout` && request.method === "POST") {
      const context = await this.tryGetAuthContext(cookies);
      if (!verifyCsrfToken(context?.session ?? null, url.searchParams.get("csrfToken") ?? undefined)) {
        writeText(response, 403, "CSRF token mismatch");
        return;
      }
      response.setHeader("Set-Cookie", [
        buildClearedSessionCookie(this.cookieOptions()),
        buildClearedOAuthStateCookie(this.cookieOptions())
      ]);
      redirect(response, `${this.basePath}/login`);
      return;
    }

    const authContext = await this.requireAuthContext(cookies, response);
    if (!authContext) {
      return;
    }

    if (path === this.basePath || path === `${this.basePath}/projects`) {
      if (request.method === "GET") {
        await this.renderProjectsPage(response, authContext, url.searchParams.get("createdKey") ?? undefined);
        return;
      }
      if (request.method === "POST") {
        await this.handleCreateProject(request, response, authContext);
        return;
      }
    }

    if (path === `${this.basePath}/api/projects` && request.method === "GET") {
      const projects = await this.visibleProjects(authContext);
      writeJson(response, 200, { projects });
      return;
    }

    const projectMatch = path.match(new RegExp(`^${escapeRegExp(this.basePath)}/projects/([^/]+)$`));
    if (projectMatch && request.method === "GET") {
      const projectId = decodeURIComponent(projectMatch[1] ?? "");
      const role = requireProjectRole(authContext, projectId, "viewer", response);
      if (!role) {
        return;
      }
      await this.renderProjectPage(response, authContext, projectId, url);
      return;
    }

    const reportPageMatch = path.match(new RegExp(`^${escapeRegExp(this.basePath)}/projects/([^/]+)/reports/([^/]+)$`));
    if (reportPageMatch && request.method === "GET") {
      const projectId = decodeURIComponent(reportPageMatch[1] ?? "");
      const reportId = decodeURIComponent(reportPageMatch[2] ?? "");
      if (!requireProjectRole(authContext, projectId, "viewer", response)) {
        return;
      }
      await this.renderReportPage(response, projectId, reportId);
      return;
    }

    const groupPageMatch = path.match(new RegExp(`^${escapeRegExp(this.basePath)}/projects/([^/]+)/groups/([^/]+)$`));
    if (groupPageMatch && request.method === "GET") {
      const projectId = decodeURIComponent(groupPageMatch[1] ?? "");
      const fingerprint = decodeURIComponent(groupPageMatch[2] ?? "");
      if (!requireProjectRole(authContext, projectId, "viewer", response)) {
        return;
      }
      await this.renderGroupPage(response, projectId, fingerprint);
      return;
    }

    const projectApiMatch = path.match(new RegExp(`^${escapeRegExp(this.basePath)}/api/projects/([^/]+)$`));
    if (projectApiMatch && request.method === "GET") {
      const projectId = decodeURIComponent(projectApiMatch[1] ?? "");
      if (!requireProjectRole(authContext, projectId, "viewer", response)) {
        return;
      }
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
      if (!requireProjectRole(authContext, projectId, "viewer", response)) {
        return;
      }
      const reports = await this.deps.telemetryReportRepo.listReports(buildReportFilters(projectId, url, 200));
      writeJson(response, 200, { reports });
      return;
    }

    const metricsApiMatch = path.match(new RegExp(`^${escapeRegExp(this.basePath)}/api/projects/([^/]+)/metrics$`));
    if (metricsApiMatch && request.method === "GET") {
      const projectId = decodeURIComponent(metricsApiMatch[1] ?? "");
      if (!requireProjectRole(authContext, projectId, "viewer", response)) {
        return;
      }
      const metrics = await this.deps.telemetryReportRepo.getMetrics(projectId);
      writeJson(response, 200, { metrics });
      return;
    }

    const rotateMatch = path.match(new RegExp(`^${escapeRegExp(this.basePath)}/projects/([^/]+)/key/refresh$`));
    if (rotateMatch && request.method === "POST") {
      const projectId = decodeURIComponent(rotateMatch[1] ?? "");
      if (!requireProjectRole(authContext, projectId, "admin", response)) {
        return;
      }
      const form = await readForm(request);
      if (!verifyCsrfToken(authContext.session, form.get("csrfToken") ?? undefined)) {
        writeText(response, 403, "CSRF token mismatch");
        return;
      }
      const rotated = await this.deps.telemetryProjectRepo.rotateProjectKey(projectId);
      await this.deps.telemetryAuditLogRepo.append({
        actorDiscordUserId: authContext.user.discordUserId,
        projectId,
        action: "project_key_rotated",
        targetType: "telemetry_project_key",
        targetId: projectId,
        details: { preview: rotated.preview }
      });
      writeHtml(response, 200, renderKeyCreatedPage(this.basePath, projectId, rotated.projectKey, "Project key rotated."));
      return;
    }

    const discordMatch = path.match(new RegExp(`^${escapeRegExp(this.basePath)}/projects/([^/]+)/discord$`));
    if (discordMatch && request.method === "POST") {
      const projectId = decodeURIComponent(discordMatch[1] ?? "");
      if (!requireProjectRole(authContext, projectId, "maintainer", response)) {
        return;
      }
      const form = await readForm(request);
      if (!verifyCsrfToken(authContext.session, form.get("csrfToken") ?? undefined)) {
        writeText(response, 403, "CSRF token mismatch");
        return;
      }
      await this.deps.telemetryProjectRepo.updateDiscordRoute(projectId, {
        guildId: emptyToNull(form.get("guildId")),
        channelId: requiredFormValue(form, "channelId"),
        mentionRoleId: emptyToNull(form.get("mentionRoleId"))
      });
      await this.deps.telemetryAuditLogRepo.append({
        actorDiscordUserId: authContext.user.discordUserId,
        projectId,
        action: "discord_route_updated",
        targetType: "telemetry_project_discord_route",
        targetId: projectId,
        details: {
          guildId: emptyToNull(form.get("guildId")),
          channelId: requiredFormValue(form, "channelId"),
          mentionRoleId: emptyToNull(form.get("mentionRoleId"))
        }
      });
      redirect(response, `${this.basePath}/projects/${encodeURIComponent(projectId)}?saved=discord`);
      return;
    }

    writeText(response, 404, "Not found");
  }

  private async handleDiscordStart(response: ServerResponse): Promise<void> {
    const state = createOAuthState(this.deps.config.TELEMETRY_PORTAL_SESSION_SECRET!);
    response.setHeader("Set-Cookie", buildOAuthStateCookie(state.value, this.cookieOptions()));
    redirect(
      response,
      buildOAuthAuthorizeUrl({
        clientId: this.deps.config.TELEMETRY_PORTAL_OAUTH_CLIENT_ID!,
        redirectUri: this.deps.config.TELEMETRY_PORTAL_OAUTH_REDIRECT_URI!,
        state: state.nonce
      })
    );
  }

  private async handleDiscordCallback(url: URL, cookies: Record<string, string>, response: ServerResponse): Promise<void> {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!verifyOAuthState(cookies[oauthStateCookieName()], state, this.deps.config.TELEMETRY_PORTAL_SESSION_SECRET!)) {
      redirect(response, `${this.basePath}/login?error=invalid-state`);
      return;
    }
    if (!code) {
      redirect(response, `${this.basePath}/login?error=missing-code`);
      return;
    }

    const tokenResult = await exchangeDiscordCode({
      clientId: this.deps.config.TELEMETRY_PORTAL_OAUTH_CLIENT_ID!,
      clientSecret: this.deps.config.TELEMETRY_PORTAL_OAUTH_CLIENT_SECRET!,
      redirectUri: this.deps.config.TELEMETRY_PORTAL_OAUTH_REDIRECT_URI!,
      code
    });
    const user = await fetchDiscordIdentity(tokenResult.accessToken);
    await this.deps.telemetryMembershipRepo.upsertUser(user);

    const bootstrapUserIds = splitCsvList(this.deps.config.TELEMETRY_PORTAL_BOOTSTRAP_OWNER_DISCORD_IDS);
    const bootstrapProjects = splitCsvList(this.deps.config.TELEMETRY_PORTAL_BOOTSTRAP_OWNER_PROJECTS);
    if (bootstrapUserIds.includes(user.discordUserId)) {
      await this.deps.telemetryMembershipRepo.ensureBootstrapMemberships(user, bootstrapProjects);
    }

    const memberships = await this.deps.telemetryMembershipRepo.listUserMemberships(user.discordUserId);
    if (memberships.length === 0) {
      redirect(response, `${this.basePath}/login?error=no-project-access`);
      return;
    }

    const session = createPortalSession({
      discordUserId: user.discordUserId,
      username: user.username,
      avatarHash: user.avatarHash,
      secret: this.deps.config.TELEMETRY_PORTAL_SESSION_SECRET!
    });
    response.setHeader("Set-Cookie", [
      buildSessionCookie(session.value, this.cookieOptions()),
      buildClearedOAuthStateCookie(this.cookieOptions())
    ]);
    redirect(response, `${this.basePath}/projects`);
  }

  private async tryGetAuthContext(cookies: Record<string, string>): Promise<AuthenticatedContext | null> {
    const session = verifyPortalSession(cookies[portalSessionCookieName()], this.deps.config.TELEMETRY_PORTAL_SESSION_SECRET!);
    if (!session) {
      return null;
    }
    const user: TelemetryPortalUser = {
      discordUserId: session.discordUserId,
      username: session.username,
      avatarHash: session.avatarHash
    };
    const memberships = await this.deps.telemetryMembershipRepo.listUserMemberships(session.discordUserId);
    return { session, user, memberships };
  }

  private async requireAuthContext(cookies: Record<string, string>, response: ServerResponse): Promise<AuthenticatedContext | null> {
    const context = await this.tryGetAuthContext(cookies);
    if (!context) {
      redirect(response, `${this.basePath}/login`);
      return null;
    }
    if (context.memberships.length === 0) {
      const projectCount = await this.deps.telemetryProjectRepo.countProjects();
      if (projectCount > 0) {
        redirect(response, `${this.basePath}/login?error=no-project-access`);
        return null;
      }
    }
    return context;
  }

  private async visibleProjects(context: AuthenticatedContext) {
    return this.deps.telemetryProjectRepo.listProjectsByIds(context.memberships.map((membership) => membership.projectId));
  }

  private async renderProjectsPage(response: ServerResponse, context: AuthenticatedContext, createdKey?: string): Promise<void> {
    const projects = await this.visibleProjects(context);
    writeHtml(response, 200, renderProjectsPage(this.basePath, context, projects, createdKey));
  }

  private async renderProjectPage(response: ServerResponse, context: AuthenticatedContext, projectId: string, url: URL): Promise<void> {
    const project = await this.deps.telemetryProjectRepo.getProject(projectId);
    if (!project) {
      writeText(response, 404, "Project not found");
      return;
    }
    const membership = context.memberships.find((entry) => entry.projectId === projectId) ?? null;
    if (!membership) {
      writeText(response, 403, "Forbidden");
      return;
    }
    const reports = await this.deps.telemetryReportRepo.listReports(buildReportFilters(projectId, url, 100));
    const groups = await this.deps.telemetryReportRepo.listCrashGroups(projectId, 50);
    const metrics = await this.deps.telemetryReportRepo.getMetrics(projectId);
    writeHtml(
      response,
      200,
      renderProjectPage(
        this.basePath,
        context,
        membership.role,
        project,
        metrics,
        reports,
        groups,
        url.searchParams.get("saved") ?? undefined
      )
    );
  }

  private async renderReportPage(response: ServerResponse, projectId: string, reportId: string): Promise<void> {
    const report = await this.deps.telemetryReportRepo.getReportById(projectId, reportId);
    if (!report) {
      writeText(response, 404, "Report not found");
      return;
    }
    writeHtml(response, 200, renderReportDetailPage(this.basePath, report));
  }

  private async renderGroupPage(response: ServerResponse, projectId: string, fingerprint: string): Promise<void> {
    const group = await this.deps.telemetryReportRepo.getCrashGroup(projectId, fingerprint);
    if (!group) {
      writeText(response, 404, "Crash group not found");
      return;
    }
    const reports = await this.deps.telemetryReportRepo.listReports({ projectId, fingerprint, limit: 100, sort: "received_desc" });
    writeHtml(response, 200, renderGroupDetailPage(this.basePath, group, reports));
  }

  private async handleCreateProject(request: IncomingMessage, response: ServerResponse, context: AuthenticatedContext): Promise<void> {
    const existingProjectCount = await this.deps.telemetryProjectRepo.countProjects();
    const globalAdmin = existingProjectCount == 0 || context.memberships.some((membership) => ADMIN_ROLES.includes(membership.role));
    if (!globalAdmin) {
      writeText(response, 403, "Creating projects requires owner or admin access on an existing project.");
      return;
    }
    const form = await readForm(request);
    if (!verifyCsrfToken(context.session, form.get("csrfToken") ?? undefined)) {
      writeText(response, 403, "CSRF token mismatch");
      return;
    }
    const created = await this.deps.telemetryProjectRepo.createProject({
      projectId: requiredFormValue(form, "projectId"),
      displayName: requiredFormValue(form, "displayName"),
      channelId: requiredFormValue(form, "channelId"),
      guildId: emptyToNull(form.get("guildId")),
      mentionRoleId: emptyToNull(form.get("mentionRoleId"))
    });
    await this.deps.telemetryMembershipRepo.ensureBootstrapMemberships(context.user, [created.project.projectId]);
    await this.deps.telemetryAuditLogRepo.append({
      actorDiscordUserId: context.user.discordUserId,
      projectId: created.project.projectId,
      action: "project_created",
      targetType: "telemetry_project",
      targetId: created.project.projectId,
      details: { displayName: created.project.displayName }
    });
    writeHtml(
      response,
      200,
      renderKeyCreatedPage(this.basePath, created.project.projectId, created.projectKey, "Project created.")
    );
  }

  private cookieOptions() {
    return {
      secure: this.deps.config.TELEMETRY_PORTAL_COOKIE_SECURE,
      path: this.basePath
    };
  }
}

function normalizeBasePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return "/portal";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function setPortalHeaders(response: ServerResponse): void {
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' https://cdn.discordapp.com data:; style-src 'self' 'unsafe-inline'; form-action 'self' https://discord.com; frame-ancestors 'none'; base-uri 'self'");
}

function writeText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
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

function requireProjectRole(context: AuthenticatedContext, projectId: string, required: "viewer" | "maintainer" | "admin", response: ServerResponse): TelemetryPortalRole | null {
  const membership = context.memberships.find((entry) => entry.projectId === projectId);
  if (!membership) {
    writeText(response, 403, "Forbidden");
    return null;
  }
  const role = membership.role;
  if (required === "viewer") {
    return role;
  }
  if (required === "maintainer" && MUTATING_ROLES.includes(role)) {
    return role;
  }
  if (required === "admin" && ADMIN_ROLES.includes(role)) {
    return role;
  }
  writeText(response, 403, "Forbidden");
  return null;
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
    pre { white-space: pre-wrap; word-break: break-word; background: #020617; padding: 12px; border-radius: 8px; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

function renderLoginPage(basePath: string, error?: string): string {
  const errorMessage =
    error === "invalid-state"
      ? "Discord login state verification failed."
      : error === "missing-code"
        ? "Discord did not return an authorization code."
        : error === "no-project-access"
          ? "Your Discord account is not yet assigned to any telemetry projects."
          : undefined;
  return renderShell(
    "Telemetry Portal Login",
    `<div class="card" style="max-width: 520px; margin: 40px auto;">
      <h1>Telemetry Portal</h1>
      <p class="muted">Sign in with Discord to access the projects you have been granted.</p>
      ${errorMessage ? `<p style="color:#fca5a5;">${escapeHtml(errorMessage)}</p>` : ""}
      <p><a href="${basePath}/auth/discord/start"><button type="button">Sign in with Discord</button></a></p>
    </div>`
  );
}

function renderProjectsPage(basePath: string, context: AuthenticatedContext, projects: any[], createdKey?: string): string {
  const rows = projects
    .map((project) => {
      const membership = context.memberships.find((entry) => entry.projectId === project.projectId);
      return `<tr>
        <td><a href="${basePath}/projects/${encodeURIComponent(project.projectId)}">${escapeHtml(project.displayName)}</a><br/><span class="muted"><code>${escapeHtml(project.projectId)}</code></span></td>
        <td>${escapeHtml(membership?.role ?? "viewer")}</td>
        <td>${project.enabled ? "enabled" : "disabled"}</td>
        <td>${escapeHtml(project.activeKeyPreview ?? "none")}</td>
        <td>${escapeHtml(project.channelId ?? "not configured")}</td>
      </tr>`;
    })
    .join("");
  const csrf = buildCsrfHiddenInput(context.session);
  const canCreate = context.memberships.some((entry) => ADMIN_ROLES.includes(entry.role));
  return renderShell(
    "Telemetry Projects",
    `<div style="display:flex; justify-content:space-between; align-items:center; gap:16px;">
      <div>
        <h1>Telemetry Projects</h1>
        <p class="muted">Signed in as ${escapeHtml(context.user.username)} (${escapeHtml(context.user.discordUserId)})</p>
      </div>
      <form method="post" action="${basePath}/logout?csrfToken=${encodeURIComponent(context.session.csrfToken)}"><button type="submit">Log out</button></form>
    </div>
    ${createdKey ? `<div class="card"><strong>New project key:</strong> <code>${escapeHtml(createdKey)}</code></div>` : ""}
    ${
      canCreate
        ? `<div class="card">
      <h2>Create project</h2>
      <form method="post" action="${basePath}/projects">
        ${csrf}
        <div class="row">
          <div><label>Project ID</label><input name="projectId" required /></div>
          <div><label>Display name</label><input name="displayName" required /></div>
          <div><label>Discord guild ID</label><input name="guildId" /></div>
          <div><label>Discord channel ID</label><input name="channelId" required /></div>
          <div><label>Mention role ID</label><input name="mentionRoleId" /></div>
        </div>
        <div style="margin-top:12px;"><button type="submit">Create project</button></div>
      </form>
    </div>`
        : ""
    }
    <div class="card">
      <h2>Projects</h2>
      <table>
        <thead><tr><th>Project</th><th>Your role</th><th>Status</th><th>Active key</th><th>Discord channel</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5" class="muted">No project memberships yet.</td></tr>`}</tbody>
      </table>
    </div>`
  );
}

function renderProjectPage(
  basePath: string,
  context: AuthenticatedContext,
  role: TelemetryPortalRole,
  project: any,
  metrics: TelemetryProjectMetrics,
  reports: TelemetryReportRow[],
  groups: TelemetryGroupRow[],
  saved?: string
): string {
  const csrf = buildCsrfHiddenInput(context.session);
  const canRotate = ADMIN_ROLES.includes(role);
  const canEdit = MUTATING_ROLES.includes(role);
  const reportRows = reports
    .map(
      (report) => `<tr>
        <td>${escapeHtml(report.receivedAt)}</td>
        <td><a href="${basePath}/projects/${encodeURIComponent(project.projectId)}/reports/${encodeURIComponent(report.reportId)}"><code>${escapeHtml(report.fingerprint)}</code></a></td>
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
        <td><a href="${basePath}/projects/${encodeURIComponent(project.projectId)}/groups/${encodeURIComponent(group.fingerprint)}"><code>${escapeHtml(group.fingerprint)}</code></a></td>
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
        <p class="muted"><code>${escapeHtml(project.projectId)}</code> · your role: ${escapeHtml(role)} · active key: <code>${escapeHtml(project.activeKeyPreview ?? "none")}</code></p>
      </div>
      ${
        canRotate
          ? `<form method="post" action="${basePath}/projects/${encodeURIComponent(project.projectId)}/key/refresh">
              ${csrf}
              <button type="submit">Refresh project key</button>
            </form>`
          : ""
      }
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
      <h2>Hosted settings</h2>
      <div class="row">
        <div><strong>Rate limit / minute</strong><div>${project.rateLimitPerMinute}</div></div>
        <div><strong>Max payload bytes</strong><div>${project.maxPayloadBytes}</div></div>
        <div><strong>Fingerprint cooldown</strong><div>${project.fingerprintCooldownSeconds}s</div></div>
        <div><strong>Attach JSON</strong><div>${project.attachJson ? "yes" : "no"}</div></div>
        <div><strong>Stack lines</strong><div>${project.stackLines}</div></div>
      </div>
    </div>
    <div class="card">
      <h2>Discord routing</h2>
      <form method="post" action="${basePath}/projects/${encodeURIComponent(project.projectId)}/discord">
        ${csrf}
        <div class="row">
          <div><label>Guild ID</label><input name="guildId" value="${escapeHtml(project.guildId ?? "")}" ${canEdit ? "" : "disabled"} /></div>
          <div><label>Channel ID</label><input name="channelId" value="${escapeHtml(project.channelId ?? "")}" ${canEdit ? "required" : "disabled"} /></div>
          <div><label>Mention role ID</label><input name="mentionRoleId" value="${escapeHtml(project.mentionRoleId ?? "")}" ${canEdit ? "" : "disabled"} /></div>
        </div>
        ${canEdit ? `<div style="margin-top:12px;"><button type="submit">Save Discord routing</button></div>` : `<p class="muted">You need maintainer or higher access to update Discord routing.</p>`}
      </form>
    </div>
    <div class="card">
      <h2>Top recurring fingerprints</h2>
      <ul>${metrics.topRecurringFingerprints.map((row) => `<li><a href="${basePath}/projects/${encodeURIComponent(project.projectId)}/groups/${encodeURIComponent(row.fingerprint)}"><code>${escapeHtml(row.fingerprint)}</code></a> · ${row.occurrenceCount}</li>`).join("") || `<li class="muted">No reports yet.</li>`}</ul>
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

function renderReportDetailPage(basePath: string, report: TelemetryReportDetail): string {
  return renderShell(
    `Report ${report.reportId}`,
    `<p><a href="${basePath}/projects/${encodeURIComponent(report.projectId)}">Back to project</a></p>
    <div class="card">
      <h1>Report ${escapeHtml(report.reportId)}</h1>
      <p class="muted"><code>${escapeHtml(report.projectId)}</code> · fingerprint <code>${escapeHtml(report.fingerprint)}</code></p>
      <div class="row">
        <div><strong>Received</strong><div>${escapeHtml(report.receivedAt)}</div></div>
        <div><strong>Captured</strong><div>${escapeHtml(report.capturedAt ?? "unknown")}</div></div>
        <div><strong>Last captured</strong><div>${escapeHtml(report.lastCapturedAt ?? "unknown")}</div></div>
        <div><strong>Occurrences</strong><div>${report.occurrenceCount}</div></div>
      </div>
      <div class="row">
        <div><strong>Exception</strong><div>${escapeHtml(report.exceptionType ?? "unknown")}</div></div>
        <div><strong>Message</strong><div>${escapeHtml(report.exceptionMessage ?? "<empty>")}</div></div>
        <div><strong>Plugin version</strong><div>${escapeHtml(report.pluginVersion ?? "unknown")}</div></div>
        <div><strong>Source</strong><div>${escapeHtml(report.source ?? "unknown")}</div></div>
      </div>
      <h2>Raw JSON</h2>
      <pre>${escapeHtml(report.rawJson)}</pre>
    </div>`
  );
}

function renderGroupDetailPage(basePath: string, group: TelemetryGroupRow, reports: TelemetryReportRow[]): string {
  return renderShell(
    `Crash group ${group.fingerprint}`,
    `<p><a href="${basePath}/projects/${encodeURIComponent(group.projectId)}">Back to project</a></p>
    <div class="card">
      <h1>Crash group <code>${escapeHtml(group.fingerprint)}</code></h1>
      <div class="row">
        <div><strong>First seen</strong><div>${escapeHtml(group.firstSeenAt)}</div></div>
        <div><strong>Last seen</strong><div>${escapeHtml(group.lastSeenAt)}</div></div>
        <div><strong>Occurrences</strong><div>${group.occurrenceCount}</div></div>
        <div><strong>Latest exception</strong><div>${escapeHtml(group.latestExceptionType ?? "unknown")}</div></div>
      </div>
    </div>
    <div class="card">
      <h2>Reports in this group</h2>
      <table>
        <thead><tr><th>Received</th><th>Report ID</th><th>Exception</th><th>Source</th><th>Occurrences</th></tr></thead>
        <tbody>
          ${reports.map((report) => `<tr><td>${escapeHtml(report.receivedAt)}</td><td><a href="${basePath}/projects/${encodeURIComponent(group.projectId)}/reports/${encodeURIComponent(report.reportId)}"><code>${escapeHtml(report.reportId)}</code></a></td><td>${escapeHtml(report.exceptionType ?? "unknown")}</td><td>${escapeHtml(report.source ?? "unknown")}</td><td>${report.occurrenceCount}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">No reports found.</td></tr>`}
        </tbody>
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

function buildReportFilters(projectId: string, url: URL, defaultLimit: number): TelemetryReportFilters {
  const filters: TelemetryReportFilters = {
    projectId,
    limit: defaultLimit
  };
  const fingerprint = url.searchParams.get("fingerprint");
  const exceptionType = url.searchParams.get("exceptionType");
  const pluginVersion = url.searchParams.get("pluginVersion");
  const source = url.searchParams.get("source");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const sort = url.searchParams.get("sort");
  if (fingerprint) filters.fingerprint = fingerprint;
  if (exceptionType) filters.exceptionType = exceptionType;
  if (pluginVersion) filters.pluginVersion = pluginVersion;
  if (source) filters.source = source;
  if (from) filters.from = from;
  if (to) filters.to = to;
  if (sort === "received_desc" || sort === "received_asc" || sort === "last_seen_desc" || sort === "occurrence_desc") {
    filters.sort = sort;
  }
  const requestedLimit = url.searchParams.get("limit");
  if (requestedLimit) {
    const parsedLimit = Number.parseInt(requestedLimit, 10);
    if (Number.isFinite(parsedLimit)) {
      filters.limit = parsedLimit;
    }
  }
  return filters;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
