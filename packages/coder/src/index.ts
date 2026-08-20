/**
 * @brokk/coder — the runtime port.
 *
 * Brokk decides; Coder runs. This package is the only place that knows the
 * Coder wire protocol: provisioning a bancada (workspace) from a project's
 * pinned runtime, driving the agent that lives inside it, and addressing the
 * hot preview it serves. Everything above it speaks Brokk's own domain.
 *
 * See docs/adr/0100-brokk-sobre-coder.md.
 */
export { CoderClient, CoderError, AGENT_APP_SLUG, PREVIEW_APP_SLUG } from "./client.js";
export type { CoderConfig } from "./client.js";
export { bancadaParameters, devPort, workspaceName, UnrunnableProject } from "./bancada.js";
export { parseAgentScreen, resumoDaTela } from "./screen.js";
export type { Bloco, BlocoTipo } from "./screen.js";
export type { BancadaRecipe } from "./bancada.js";
export type {
  AgentLifecycle,
  AgentMessage,
  AgentStatus,
  BuildStatus,
  BuildTransition,
  CoderAgent,
  CoderApp,
  CoderBuild,
  CoderResource,
  CoderTemplate,
  CoderUser,
  CoderWorkspace,
  RichParameter,
} from "./types.js";
