import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join, basename } from "path";

// ── Config ──────────────────────────────────────────────────────────────

interface SnapConfig {
  contextDir?: string;
  maxHistoryLines?: number;
  maxDecisions?: number;
}

const DEFAULT_MAX_HISTORY = 30;
const DEFAULT_MAX_DECISIONS = 20;

// ── Snap file parser/writer ─────────────────────────────────────────────

interface SnapData {
  meta: Record<string, string>;
  currentStatus: string;
  keyDecisions: string[];
  history: string[];
}

function parseSnap(content: string): SnapData {
  const snap: SnapData = { meta: {}, currentStatus: "", keyDecisions: [], history: [] };
  let section: "none" | "meta" | "status" | "decisions" | "history" = "none";
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## Meta")) { section = "meta"; continue; }
    if (trimmed.startsWith("## Current Status")) { section = "status"; continue; }
    if (trimmed.startsWith("## Key Decisions")) { section = "decisions"; continue; }
    if (trimmed.startsWith("## History")) { section = "history"; continue; }
    if (trimmed.startsWith("# ")) continue; // title line

    if (section === "meta" && trimmed.startsWith("- ")) {
      const match = trimmed.match(/^- \*\*(.+?)\*\*:\s*(.+)$/);
      if (match) snap.meta[match[1]] = match[2];
    } else if (section === "status") {
      snap.currentStatus += line + "\n";
    } else if (section === "decisions" && trimmed.startsWith("- ")) {
      snap.keyDecisions.push(trimmed.slice(2));
    } else if (section === "history" && trimmed.startsWith("- ")) {
      snap.history.push(trimmed.slice(2));
    }
  }

  snap.currentStatus = snap.currentStatus.trim();
  return snap;
}

function serializeSnap(title: string, snap: SnapData): string {
  const parts: string[] = [`# ${title}\n`];

  if (Object.keys(snap.meta).length > 0) {
    parts.push("## Meta");
    for (const [k, v] of Object.entries(snap.meta)) {
      parts.push(`- **${k}**: ${v}`);
    }
    parts.push("");
  }

  parts.push("## Current Status");
  parts.push(snap.currentStatus || "(no status yet)");
  parts.push("");

  parts.push("## Key Decisions");
  if (snap.keyDecisions.length === 0) {
    parts.push("(none yet)");
  } else {
    for (const d of snap.keyDecisions) parts.push(`- ${d}`);
  }
  parts.push("");

  parts.push("## History");
  if (snap.history.length === 0) {
    parts.push("(none yet)");
  } else {
    for (const h of snap.history) parts.push(`- ${h}`);
  }
  parts.push("");

  return parts.join("\n");
}

// ── Helper: resolve snap directory ──────────────────────────────────────

function resolveSnapDir(config: SnapConfig, api: any): string {
  if (config.contextDir) return config.contextDir;
  // Try multiple paths to find workspace
  const candidates = [
    api.workspace,
    api.config?.workspace,
    process.env.OPENCLAW_WORKSPACE,
    process.env.HOME ? join(process.env.HOME, ".openclaw", "workspace") : null,
    process.cwd(),
  ].filter(Boolean) as string[];
  const workspace = candidates[0] || process.cwd();
  return join(workspace, "memory");
}

function listSnapFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir) as string[];
  return files
    .filter((f: string) => f.startsWith("context-") && f.endsWith(".md"))
    .map((f: string) => join(dir, f));
}

// ── Session → topic mapping ─────────────────────────────────────────────

const SESSION_TOPIC_MAP_FILE = "context-session-map.json";

type SessionTopicMap = Record<string, string>; // sessionKey → topic

function loadSessionMap(snapDir: string): SessionTopicMap {
  const mapPath = join(snapDir, SESSION_TOPIC_MAP_FILE);
  if (!existsSync(mapPath)) return {};
  try {
    return JSON.parse(readFileSync(mapPath, "utf-8"));
  } catch {
    return {};
  }
}

function saveSessionMap(snapDir: string, map: SessionTopicMap): void {
  const mapPath = join(snapDir, SESSION_TOPIC_MAP_FILE);
  writeFileSync(mapPath, JSON.stringify(map, null, 2), "utf-8");
}

function bindSessionToTopic(snapDir: string, sessionKey: string, topic: string): void {
  const map = loadSessionMap(snapDir);
  map[sessionKey] = topic;
  saveSessionMap(snapDir, map);
}

function getTopicForSession(snapDir: string, sessionKey: string): string | undefined {
  return loadSessionMap(snapDir)[sessionKey];
}

// ── Auto-topic: derive topic name from sessionKey ───────────────────────

function sessionKeyToAutoTopic(sessionKey: string): string {
  // sessionKey format: "agent:main:discord:1480754631297597611"
  // → extract meaningful parts, sanitize for filename
  return sessionKey
    .replace(/[^a-zA-Z0-9_:-]/g, "-")
    .replace(/:/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80); // keep filenames reasonable
}

// ── Plugin registration ─────────────────────────────────────────────────

export default function register(api: any) {
  const pluginConfig: SnapConfig = api.config?.plugins?.entries?.["snap-context"]?.config ?? {};
  const snapDir = resolveSnapDir(pluginConfig, api);

  // ── Hook: before_prompt_build — auto-inject context ─────────────────
  api.on(
    "before_prompt_build",
    (event: { prompt: string; messages: unknown[] }, ctx: { sessionKey?: string }) => {
      if (!ctx.sessionKey) return;

      // Try explicit binding first, then auto-topic
      let topic = getTopicForSession(snapDir, ctx.sessionKey);
      if (!topic) {
        // Check if an auto-topic file exists for this session
        const autoTopic = sessionKeyToAutoTopic(ctx.sessionKey);
        const autoPath = join(snapDir, `context-${autoTopic}.md`);
        if (existsSync(autoPath)) topic = autoTopic;
      }
      if (!topic) return;

      const filePath = join(snapDir, `context-${topic}.md`);
      if (!existsSync(filePath)) return;

      const content = readFileSync(filePath, "utf-8");
      if (!content.trim()) return;

      api.logger?.info?.(`[snap-context] Injecting context for topic: ${topic}`);
      return {
        appendSystemContext: `\n\n## Topic Context (auto-injected by snap-context)\n${content}`,
      };
    },
    { priority: 5 },
  );

  // ── Hook: before_compaction — auto-save before compaction ───────────
  api.on(
    "before_compaction",
    async (event: { messageCount: number; messages?: unknown[]; sessionFile?: string }, ctx: { sessionKey?: string }) => {
      if (!ctx.sessionKey) return;

      // Resolve topic: explicit binding → auto-topic (auto-create if neither exists)
      let topic = getTopicForSession(snapDir, ctx.sessionKey);
      if (!topic) {
        topic = sessionKeyToAutoTopic(ctx.sessionKey);
        // Auto-bind for future lookups
        bindSessionToTopic(snapDir, ctx.sessionKey, topic);
      }

      const filePath = join(snapDir, `context-${topic}.md`);
      const today = new Date().toISOString().slice(0, 10);
      const maxHistory = pluginConfig.maxHistoryLines ?? DEFAULT_MAX_HISTORY;

      let snap: SnapData;
      if (existsSync(filePath)) {
        snap = parseSnap(readFileSync(filePath, "utf-8"));
      } else {
        snap = {
          meta: { created: today, session: ctx.sessionKey },
          currentStatus: "(auto-created by compaction)",
          keyDecisions: [],
          history: [],
        };
      }

      snap.history.push(`${today}: Auto-saved before compaction (${event.messageCount} messages)`);
      while (snap.history.length > maxHistory) snap.history.shift();
      snap.meta["updated"] = today;

      writeFileSync(filePath, serializeSnap(topic, snap), "utf-8");
      api.logger?.info?.(`[snap-context] Auto-saved before compaction: ${topic}`);
    },
  );

  // ── Hook: after_compaction — log compaction result ──────────────────
  api.on(
    "after_compaction",
    async (event: { messageCount: number; compactedCount: number }, ctx: { sessionKey?: string }) => {
      if (!ctx.sessionKey) return;

      const topic = getTopicForSession(snapDir, ctx.sessionKey);
      if (!topic) return; // before_compaction should have created the binding

      const filePath = join(snapDir, `context-${topic}.md`);
      if (!existsSync(filePath)) return;

      const today = new Date().toISOString().slice(0, 10);
      const maxHistory = pluginConfig.maxHistoryLines ?? DEFAULT_MAX_HISTORY;
      const snap = parseSnap(readFileSync(filePath, "utf-8"));

      snap.history.push(`${today}: Compaction completed (${event.compactedCount}→${event.messageCount} messages)`);
      while (snap.history.length > maxHistory) snap.history.shift();
      snap.meta["updated"] = today;

      writeFileSync(filePath, serializeSnap(topic, snap), "utf-8");
      api.logger?.info?.(`[snap-context] Logged compaction: ${topic}`);
    },
  );

  // ── Agent tool: context_snap ────────────────────────────────────────
  api.registerTool({
    name: "context_snap",
    description:
      "Save or update a topic checkpoint (snap). Use when: (1) user says 'checkpoint'/'存一下'/'save context', " +
      "(2) a key decision is made, (3) a milestone is reached. " +
      "Actions: 'checkpoint' to save/update, 'list' to show all snaps, 'read' to view a snap.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["checkpoint", "list", "read"],
          description: "Action to perform",
        },
        topic: {
          type: "string",
          description: "Topic name for the snap file (used in filename: context-{topic}.md)",
        },
        status: {
          type: "string",
          description: "Current status text (overwrites previous status)",
        },
        decisions: {
          type: "array",
          items: { type: "string" },
          description: "New key decisions to append (format: 'YYYY-MM-DD: decision text')",
        },
        historyLine: {
          type: "string",
          description: "Single history line to append (format: 'YYYY-MM-DD: what happened')",
        },
        sessionId: {
          type: "string",
          description: "Session ID to bind this snap to (for auto-matching). Optional.",
        },
      },
      required: ["action"],
    },
    async execute(_id: string, params: any) {
      const { action, topic, status, decisions, historyLine, sessionId } = params;

      if (!existsSync(snapDir)) mkdirSync(snapDir, { recursive: true });

      if (action === "list") {
        const files = listSnapFiles(snapDir);
        if (files.length === 0) {
          return { content: [{ type: "text", text: "No context snap files found." }] };
        }
        const names = files.map((f: string) => basename(f));
        return {
          content: [{ type: "text", text: `Context snaps:\n${names.map((n: string) => `- ${n}`).join("\n")}` }],
        };
      }

      if (action === "read") {
        if (!topic) {
          return { content: [{ type: "text", text: "Error: 'topic' required for read action." }] };
        }
        const filePath = join(snapDir, `context-${topic}.md`);
        if (!existsSync(filePath)) {
          return { content: [{ type: "text", text: `Not found: context-${topic}.md` }] };
        }
        const content = readFileSync(filePath, "utf-8");
        return { content: [{ type: "text", text: content }] };
      }

      if (action === "checkpoint") {
        if (!topic) {
          return { content: [{ type: "text", text: "Error: 'topic' required for checkpoint action." }] };
        }

        const filePath = join(snapDir, `context-${topic}.md`);
        const today = new Date().toISOString().slice(0, 10);
        const maxHistory = pluginConfig.maxHistoryLines ?? DEFAULT_MAX_HISTORY;
        const maxDec = pluginConfig.maxDecisions ?? DEFAULT_MAX_DECISIONS;

        let snap: SnapData;

        if (existsSync(filePath)) {
          snap = parseSnap(readFileSync(filePath, "utf-8"));
        } else {
          snap = {
            meta: { created: today },
            currentStatus: "",
            keyDecisions: [],
            history: [`${today}: Context created`],
          };
        }

        // Auto-bind session → topic for hook matching
        if (sessionId) {
          snap.meta["session"] = sessionId;
          bindSessionToTopic(snapDir, sessionId, topic);
        }
        if (status) snap.currentStatus = status;

        if (decisions && decisions.length > 0) {
          snap.keyDecisions.push(...decisions);
          while (snap.keyDecisions.length > maxDec) snap.keyDecisions.shift();
        }

        if (historyLine) {
          snap.history.push(historyLine);
          while (snap.history.length > maxHistory) snap.history.shift();
        }

        snap.meta["updated"] = today;
        writeFileSync(filePath, serializeSnap(topic, snap), "utf-8");

        return {
          content: [{ type: "text", text: `✅ Context saved: context-${topic}.md` }],
        };
      }

      return { content: [{ type: "text", text: `Unknown action: ${action}` }] };
    },
  });
}
