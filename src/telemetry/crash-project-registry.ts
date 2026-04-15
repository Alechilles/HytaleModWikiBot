import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

const discordTargetSchema = z.object({
  channelId: z.string().trim().min(1),
  guildId: z.string().trim().min(1).optional(),
  mentionRoleId: z.string().trim().min(1).optional()
});

export const crashRelayProjectSchema = z.object({
  projectId: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  publicProjectKey: z.string().trim().min(1),
  enabled: z.boolean().default(true),
  rateLimitPerMinute: z.number().int().positive().max(10_000).default(60),
  maxPayloadBytes: z.number().int().min(1_024).max(5_000_000).default(262_144),
  fingerprintCooldownSeconds: z.number().int().positive().max(86_400).default(300),
  attachJson: z.boolean().default(true),
  stackLines: z.number().int().min(1).max(20).default(8),
  discord: discordTargetSchema
});

const crashRelayProjectRegistrySchema = z.object({
  projects: z.array(crashRelayProjectSchema)
});

export type CrashRelayProjectConfig = z.infer<typeof crashRelayProjectSchema>;

export class CrashRelayProjectRegistry {
  private readonly byProjectId = new Map<string, CrashRelayProjectConfig>();
  private readonly byProjectKey = new Map<string, CrashRelayProjectConfig>();

  private constructor(projects: CrashRelayProjectConfig[]) {
    for (const project of projects) {
      const projectIdKey = project.projectId.toLowerCase();
      if (this.byProjectId.has(projectIdKey)) {
        throw new Error(`Duplicate crash relay projectId detected: ${project.projectId}`);
      }
      if (this.byProjectKey.has(project.publicProjectKey)) {
        throw new Error(`Duplicate crash relay publicProjectKey detected for project ${project.projectId}`);
      }
      this.byProjectId.set(projectIdKey, project);
      this.byProjectKey.set(project.publicProjectKey, project);
    }
  }

  public static async loadFromFile(filePath: string): Promise<CrashRelayProjectRegistry> {
    const absolutePath = resolve(filePath);
    const raw = await readFile(absolutePath, "utf8");
    const parsed = crashRelayProjectRegistrySchema.parse(JSON.parse(raw));
    return new CrashRelayProjectRegistry(parsed.projects);
  }

  public static fromProjects(projects: CrashRelayProjectConfig[]): CrashRelayProjectRegistry {
    const parsed = crashRelayProjectRegistrySchema.parse({ projects });
    return new CrashRelayProjectRegistry(parsed.projects);
  }

  public findByProjectKey(projectKey: string): CrashRelayProjectConfig | null {
    return this.byProjectKey.get(projectKey) ?? null;
  }

  public size(): number {
    return this.byProjectId.size;
  }

  public enabledProjectCount(): number {
    let count = 0;
    for (const project of this.byProjectId.values()) {
      if (project.enabled) {
        count += 1;
      }
    }
    return count;
  }
}
