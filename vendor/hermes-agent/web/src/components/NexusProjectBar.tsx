import { useCallback, useEffect, useState } from "react";
import { Check, FolderOpen, Play, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import { Badge } from "@nous-research/ui/ui/components/badge";

type Plan = {
  draftId: string;
  version: number;
  hash: string;
  status: "PROJECTED" | "APPROVED" | "DISPATCHED" | "REJECTED" | "PROJECTION_FAILED";
  lastError: string | null;
};

type ProjectState = {
  projectId: string;
  runtimeState: string;
  employees: Array<{ id: string; name: string }>;
  clarifications: Array<{ clarifyId: string; prompt: string }>;
  plans: Plan[];
  tasks: Array<{
    taskId: string;
    title: string;
    status: string;
    files: Array<{ relativePath: string; mediaType: string; sha256: string }>;
  }>;
  updatedAt: number;
};

type Envelope<T> = { ok: true; result: T } | { ok: false; error: string };

function csrfToken(): string | null {
  const entry = document.cookie.split(";").map((part) => part.trim())
    .find((part) => part.startsWith("__Host-opc_hermes_csrf="));
  return entry ? decodeURIComponent(entry.slice(entry.indexOf("=") + 1)) : null;
}

async function request<T>(operation: string, payload?: unknown): Promise<T> {
  const mutation = payload !== undefined;
  const csrf = mutation ? csrfToken() : null;
  const response = await fetch(`/__opc_nexus/project/${operation}`, {
    method: mutation ? "POST" : "GET",
    credentials: "include",
    headers: mutation ? {
      "content-type": "application/json",
      ...(csrf ? { "x-opc-csrf": csrf } : {}),
    } : undefined,
    body: mutation ? JSON.stringify(payload) : undefined,
  });
  const body = await response.json() as Envelope<T>;
  if (!response.ok || !body.ok) throw new Error("error" in body ? body.error : `Request failed (${response.status})`);
  return body.result;
}

export function NexusProjectBar() {
  const mode = window.__OPC_NEXUS_PROJECT_MODE__;
  const canOperate = mode === "desktop" || mode === "mobile-operator";
  const canOpenHostDirectory = mode === "desktop";
  const [state, setState] = useState<ProjectState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await request<ProjectState>("state"));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Project state unavailable");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const plan = state?.plans[0] ?? null;
  const activeTaskCount = state?.tasks.filter((task) => !["COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"].includes(task.status)).length ?? 0;
  const completedTaskCount = state?.tasks.filter((task) => task.status === "COMPLETED").length ?? 0;

  const run = useCallback(async (operation: string, payload: unknown = {}) => {
    setBusy(operation);
    try {
      await request(operation, payload);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Project operation failed");
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  if (!mode) return null;
  return (
    <section className="relative z-20 flex min-h-11 min-w-0 shrink-0 items-center gap-2 border-b border-current/15 bg-background-base px-3 py-1.5 text-xs" data-nexus-mobile-project-bar>
      <div className="flex min-w-0 items-center gap-2">
        <span className="font-semibold text-text-primary">Quest</span>
        <Badge tone={state?.runtimeState === "healthy" ? "success" : "warning"}>
          {state?.runtimeState === "healthy" ? "Hermes 在线" : state ? "Hermes 启动中" : "正在连接"}
        </Badge>
      </div>

      {state && (
        <div className="hidden min-w-0 flex-1 items-center gap-2 text-text-secondary min-[430px]:flex">
          {state.clarifications.length > 0 && <span className="whitespace-nowrap">待回答 {state.clarifications.length}</span>}
          <span className="whitespace-nowrap">进行中 {activeTaskCount}</span>
          <span className="whitespace-nowrap">已完成 {completedTaskCount}</span>
        </div>
      )}

      {error && (
        <span className="flex min-w-0 items-center gap-1 text-destructive" title={error} aria-label={error}>
          <TriangleAlert className="size-3.5 shrink-0" />
        </span>
      )}

      <div className="ml-auto flex items-center gap-1">
        {canOperate && plan?.status === "PROJECTED" && (
          <Button size="sm" onClick={() => void run("approve-plan", { draftId: plan.draftId })} disabled={busy !== null} prefix={<Check />}>
            Approve
          </Button>
        )}
        {canOperate && plan?.status === "APPROVED" && (
          <Button size="sm" onClick={() => void run("dispatch-plan", { draftId: plan.draftId })} disabled={busy !== null} prefix={<Play />}>
            Dispatch
          </Button>
        )}
        {canOpenHostDirectory && (
          <Button ghost size="icon" aria-label="Open project directory" title="Open project directory"
            onClick={() => void run("open-project-directory")} disabled={busy !== null}>
            <FolderOpen />
          </Button>
        )}
        <Button ghost size="icon" aria-label="Refresh project state" title="Refresh project state"
          onClick={() => void refresh()} disabled={busy !== null}>
          <RefreshCw className={busy ? "animate-spin" : ""} />
        </Button>
      </div>
    </section>
  );
}
