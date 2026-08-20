/** Wire types for the slice of the Coder API Brokk actually drives.
 *
 *  Deliberately partial: Coder's payloads are large and versioned, and typing
 *  the whole surface would be a second source of truth to keep in sync. Every
 *  field below is one Brokk reads. Unknown fields survive round-trips because
 *  we never re-serialise a workspace we fetched.
 */

export type BuildTransition = "start" | "stop" | "delete";

/** Terminal + in-flight states of a workspace build job. */
export type BuildStatus =
  | "pending"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed"
  | "canceling"
  | "canceled"
  | "deleting"
  | "deleted";

/** Agent lifecycle as reported by the workspace agent itself. `ready` is the
 *  only state that means the startup script finished cleanly. */
export type AgentLifecycle =
  | "created"
  | "starting"
  | "start_timeout"
  | "start_error"
  | "ready"
  | "shutting_down"
  | "shutdown_timeout"
  | "shutdown_error"
  | "off";

export interface CoderApp {
  id: string;
  slug: string;
  display_name?: string;
  url?: string;
  subdomain: boolean;
  sharing_level: "owner" | "authenticated" | "public";
  health: "disabled" | "initializing" | "healthy" | "unhealthy";
}

export interface CoderAgent {
  id: string;
  name: string;
  status: string;
  lifecycle_state: AgentLifecycle;
  health?: { healthy: boolean; reason?: string };
  apps?: CoderApp[];
}

export interface CoderResource {
  id: string;
  type: string;
  name: string;
  agents?: CoderAgent[];
}

export interface CoderBuild {
  id: string;
  build_number: number;
  transition: BuildTransition;
  status: BuildStatus;
  job: { id: string; status: string; error?: string };
  resources: CoderResource[];
}

export interface CoderWorkspace {
  id: string;
  name: string;
  owner_id: string;
  owner_name: string;
  organization_id: string;
  template_id: string;
  template_name: string;
  latest_build: CoderBuild;
  outdated?: boolean;
}

export interface CoderTemplate {
  id: string;
  name: string;
  display_name?: string;
  active_version_id: string;
}

export interface CoderUser {
  id: string;
  username: string;
  email: string;
  status: string;
}

/** A `coder_parameter` value, as the create/build endpoints take them. */
export interface RichParameter {
  name: string;
  value: string;
}

/** AgentAPI (the HTTP face the Claude Code module puts in front of the CLI).
 *  Brokk reaches it through the Coder app proxy, so the shape below is all we
 *  need — no direct network path to the workspace exists or should exist. */
export interface AgentMessage {
  id: number;
  role: "user" | "agent";
  content: string;
  time?: string;
}

/** `stable` = the agent is idle and accepting a new message; `running` = a turn
 *  is in flight. Anything else means the workspace is not answering. */
export type AgentStatus = "stable" | "running" | "unknown";
