import type { Pool } from "pg";
import type { CrashReportEnvelope } from "../../telemetry/crash-contract.js";

export interface TelemetryReportFilters {
  projectId: string;
  fingerprint?: string;
  exceptionType?: string;
  pluginVersion?: string;
  source?: string;
  from?: string;
  to?: string;
  sort?: "received_desc" | "received_asc" | "last_seen_desc" | "occurrence_desc";
  limit?: number;
}

export interface TelemetryReportRow {
  id: number;
  projectId: string;
  reportId: string;
  fingerprint: string;
  source: string | null;
  receivedAt: string;
  capturedAt: string | null;
  lastCapturedAt: string | null;
  occurrenceCount: number;
  pluginIdentifier: string | null;
  pluginVersion: string | null;
  exceptionType: string | null;
  exceptionMessage: string | null;
  worldName: string | null;
  hytaleBuild: string | null;
  serverVersion: string | null;
  alertSuppressed: boolean;
  alertDispatched: boolean;
}

export interface TelemetryGroupRow {
  projectId: string;
  fingerprint: string;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
  latestExceptionType: string | null;
  latestExceptionMessage: string | null;
  latestPluginVersion: string | null;
  latestSource: string | null;
  latestAlertSuppressed: boolean;
  latestAlertDispatched: boolean;
}

export interface TelemetryProjectMetrics {
  reports24h: number;
  reports7d: number;
  reports30d: number;
  uniqueFingerprints24h: number;
  uniqueFingerprints7d: number;
  uniqueFingerprints30d: number;
  topRecurringFingerprints: Array<{ fingerprint: string; occurrenceCount: number }>;
  countsByPluginVersion: Array<{ pluginVersion: string; count: number }>;
  countsByServerVersion: Array<{ serverVersion: string; count: number }>;
}

export class TelemetryReportRepository {
  public constructor(private readonly pool: Pool) {}

  public async recordAcceptedReport(input: {
    projectId: string;
    envelope: CrashReportEnvelope;
    fingerprint: string;
    rawJson: string;
    alertSuppressed: boolean;
    alertDispatched: boolean;
  }): Promise<void> {
    const capturedAt = parseTimestamp(input.envelope.capturedAtUtc);
    const lastCapturedAt = parseTimestamp(input.envelope.lastCapturedAtUtc);
    const occurrenceCount = input.envelope.occurrenceCount ?? 1;
    const exceptionType = input.envelope.throwable?.type ?? null;
    const exceptionMessage = input.envelope.throwable?.message ?? null;

    await this.pool.query("BEGIN");
    try {
      await this.pool.query(
        `
        INSERT INTO telemetry_crash_reports (
          project_id,
          report_id,
          fingerprint,
          source,
          captured_at,
          last_captured_at,
          occurrence_count,
          plugin_identifier,
          plugin_version,
          thread_name,
          exception_type,
          exception_message,
          world_name,
          hytale_build,
          server_version,
          alert_suppressed,
          alert_dispatched,
          raw_json
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)
        `,
        [
          input.projectId,
          input.envelope.reportId ?? `${input.projectId}-${input.fingerprint}`,
          input.fingerprint,
          input.envelope.source ?? null,
          capturedAt,
          lastCapturedAt,
          occurrenceCount,
          input.envelope.pluginIdentifier ?? null,
          input.envelope.pluginVersion ?? null,
          input.envelope.threadName ?? null,
          exceptionType,
          exceptionMessage,
          input.envelope.worldName ?? null,
          readRuntimeField(input.envelope.runtime, "hytaleBuild"),
          readRuntimeField(input.envelope.runtime, "serverVersion"),
          input.alertSuppressed,
          input.alertDispatched,
          input.rawJson
        ]
      );

      await this.pool.query(
        `
        INSERT INTO telemetry_crash_groups (
          project_id,
          fingerprint,
          first_seen_at,
          last_seen_at,
          occurrence_count,
          latest_report_id,
          latest_source,
          latest_plugin_identifier,
          latest_plugin_version,
          latest_exception_type,
          latest_exception_message,
          latest_hytale_build,
          latest_server_version,
          latest_world_name,
          latest_alert_suppressed,
          latest_alert_dispatched,
          updated_at
        )
        VALUES ($1,$2,COALESCE($3, now()),COALESCE($4, now()),$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
        ON CONFLICT (project_id, fingerprint)
        DO UPDATE SET
          last_seen_at = GREATEST(telemetry_crash_groups.last_seen_at, COALESCE(EXCLUDED.last_seen_at, telemetry_crash_groups.last_seen_at)),
          occurrence_count = telemetry_crash_groups.occurrence_count + EXCLUDED.occurrence_count,
          latest_report_id = EXCLUDED.latest_report_id,
          latest_source = EXCLUDED.latest_source,
          latest_plugin_identifier = EXCLUDED.latest_plugin_identifier,
          latest_plugin_version = EXCLUDED.latest_plugin_version,
          latest_exception_type = EXCLUDED.latest_exception_type,
          latest_exception_message = EXCLUDED.latest_exception_message,
          latest_hytale_build = EXCLUDED.latest_hytale_build,
          latest_server_version = EXCLUDED.latest_server_version,
          latest_world_name = EXCLUDED.latest_world_name,
          latest_alert_suppressed = EXCLUDED.latest_alert_suppressed,
          latest_alert_dispatched = EXCLUDED.latest_alert_dispatched,
          updated_at = now()
        `,
        [
          input.projectId,
          input.fingerprint,
          capturedAt,
          lastCapturedAt,
          occurrenceCount,
          input.envelope.reportId ?? null,
          input.envelope.source ?? null,
          input.envelope.pluginIdentifier ?? null,
          input.envelope.pluginVersion ?? null,
          exceptionType,
          exceptionMessage,
          readRuntimeField(input.envelope.runtime, "hytaleBuild"),
          readRuntimeField(input.envelope.runtime, "serverVersion"),
          input.envelope.worldName ?? null,
          input.alertSuppressed,
          input.alertDispatched
        ]
      );

      await this.pool.query("COMMIT");
    } catch (error) {
      await this.pool.query("ROLLBACK");
      throw error;
    }
  }

  public async listReports(filters: TelemetryReportFilters): Promise<TelemetryReportRow[]> {
    const clauses = ["project_id = $1"];
    const values: unknown[] = [filters.projectId];
    const push = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    if (filters.fingerprint) {
      clauses.push(`fingerprint = ${push(filters.fingerprint)}`);
    }
    if (filters.exceptionType) {
      clauses.push(`exception_type = ${push(filters.exceptionType)}`);
    }
    if (filters.pluginVersion) {
      clauses.push(`plugin_version = ${push(filters.pluginVersion)}`);
    }
    if (filters.source) {
      clauses.push(`source = ${push(filters.source)}`);
    }
    if (filters.from) {
      clauses.push(`received_at >= ${push(filters.from)}::timestamptz`);
    }
    if (filters.to) {
      clauses.push(`received_at <= ${push(filters.to)}::timestamptz`);
    }

    const orderBy =
      filters.sort === "received_asc"
        ? "received_at ASC"
        : filters.sort === "last_seen_desc"
          ? "COALESCE(last_captured_at, received_at) DESC"
          : filters.sort === "occurrence_desc"
            ? "occurrence_count DESC, received_at DESC"
            : "received_at DESC";
    const limit = Math.max(1, Math.min(filters.limit ?? 200, 1000));

    const result = await this.pool.query(
      `
      SELECT
        id,
        project_id,
        report_id,
        fingerprint,
        source,
        received_at,
        captured_at,
        last_captured_at,
        occurrence_count,
        plugin_identifier,
        plugin_version,
        exception_type,
        exception_message,
        world_name,
        hytale_build,
        server_version,
        alert_suppressed,
        alert_dispatched
      FROM telemetry_crash_reports
      WHERE ${clauses.join(" AND ")}
      ORDER BY ${orderBy}
      LIMIT ${limit}
      `,
      values
    );

    return result.rows.map((row) => ({
      id: Number(row.id),
      projectId: row.project_id,
      reportId: row.report_id,
      fingerprint: row.fingerprint,
      source: row.source,
      receivedAt: toIso(row.received_at) ?? new Date(0).toISOString(),
      capturedAt: toIso(row.captured_at),
      lastCapturedAt: toIso(row.last_captured_at),
      occurrenceCount: row.occurrence_count,
      pluginIdentifier: row.plugin_identifier,
      pluginVersion: row.plugin_version,
      exceptionType: row.exception_type,
      exceptionMessage: row.exception_message,
      worldName: row.world_name,
      hytaleBuild: row.hytale_build,
      serverVersion: row.server_version,
      alertSuppressed: row.alert_suppressed,
      alertDispatched: row.alert_dispatched
    }));
  }

  public async listCrashGroups(projectId: string, limit = 100): Promise<TelemetryGroupRow[]> {
    const result = await this.pool.query(
      `
      SELECT
        project_id,
        fingerprint,
        first_seen_at,
        last_seen_at,
        occurrence_count,
        latest_exception_type,
        latest_exception_message,
        latest_plugin_version,
        latest_source,
        latest_alert_suppressed,
        latest_alert_dispatched
      FROM telemetry_crash_groups
      WHERE project_id = $1
      ORDER BY last_seen_at DESC
      LIMIT $2
      `,
      [projectId, Math.max(1, Math.min(limit, 500))]
    );

    return result.rows.map((row) => ({
      projectId: row.project_id,
      fingerprint: row.fingerprint,
      firstSeenAt: toIso(row.first_seen_at) ?? new Date(0).toISOString(),
      lastSeenAt: toIso(row.last_seen_at) ?? new Date(0).toISOString(),
      occurrenceCount: Number(row.occurrence_count),
      latestExceptionType: row.latest_exception_type,
      latestExceptionMessage: row.latest_exception_message,
      latestPluginVersion: row.latest_plugin_version,
      latestSource: row.latest_source,
      latestAlertSuppressed: row.latest_alert_suppressed,
      latestAlertDispatched: row.latest_alert_dispatched
    }));
  }

  public async getMetrics(projectId: string): Promise<TelemetryProjectMetrics> {
    const [windowResult, recurringResult, pluginResult, serverResult] = await Promise.all([
      this.pool.query(
        `
        SELECT
          COUNT(*) FILTER (WHERE received_at >= now() - interval '24 hours')::int AS reports_24h,
          COUNT(*) FILTER (WHERE received_at >= now() - interval '7 days')::int AS reports_7d,
          COUNT(*) FILTER (WHERE received_at >= now() - interval '30 days')::int AS reports_30d,
          COUNT(DISTINCT fingerprint) FILTER (WHERE received_at >= now() - interval '24 hours')::int AS unique_fingerprints_24h,
          COUNT(DISTINCT fingerprint) FILTER (WHERE received_at >= now() - interval '7 days')::int AS unique_fingerprints_7d,
          COUNT(DISTINCT fingerprint) FILTER (WHERE received_at >= now() - interval '30 days')::int AS unique_fingerprints_30d
        FROM telemetry_crash_reports
        WHERE project_id = $1
        `,
        [projectId]
      ),
      this.pool.query(
        `
        SELECT fingerprint, occurrence_count
        FROM telemetry_crash_groups
        WHERE project_id = $1
        ORDER BY occurrence_count DESC, last_seen_at DESC
        LIMIT 10
        `,
        [projectId]
      ),
      this.pool.query(
        `
        SELECT COALESCE(plugin_version, '<unknown>') AS plugin_version, COUNT(*)::int AS count
        FROM telemetry_crash_reports
        WHERE project_id = $1
        GROUP BY COALESCE(plugin_version, '<unknown>')
        ORDER BY count DESC, plugin_version ASC
        LIMIT 10
        `,
        [projectId]
      ),
      this.pool.query(
        `
        SELECT COALESCE(server_version, '<unknown>') AS server_version, COUNT(*)::int AS count
        FROM telemetry_crash_reports
        WHERE project_id = $1
        GROUP BY COALESCE(server_version, '<unknown>')
        ORDER BY count DESC, server_version ASC
        LIMIT 10
        `,
        [projectId]
      )
    ]);

    const windowRow = windowResult.rows[0] ?? {};
    return {
      reports24h: Number(windowRow.reports_24h ?? 0),
      reports7d: Number(windowRow.reports_7d ?? 0),
      reports30d: Number(windowRow.reports_30d ?? 0),
      uniqueFingerprints24h: Number(windowRow.unique_fingerprints_24h ?? 0),
      uniqueFingerprints7d: Number(windowRow.unique_fingerprints_7d ?? 0),
      uniqueFingerprints30d: Number(windowRow.unique_fingerprints_30d ?? 0),
      topRecurringFingerprints: recurringResult.rows.map((row) => ({
        fingerprint: row.fingerprint,
        occurrenceCount: Number(row.occurrence_count)
      })),
      countsByPluginVersion: pluginResult.rows.map((row) => ({
        pluginVersion: row.plugin_version,
        count: Number(row.count)
      })),
      countsByServerVersion: serverResult.rows.map((row) => ({
        serverVersion: row.server_version,
        count: Number(row.count)
      }))
    };
  }
}

function parseTimestamp(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function readRuntimeField(runtime: Record<string, unknown> | undefined, field: string): string | null {
  const value = runtime?.[field];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toIso(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    return value;
  }
  return null;
}
