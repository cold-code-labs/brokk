import type { DesignSpec } from "./design.ts";
export const roles = ["admin", "operator", "client", "reader"] as const;
export type Role = (typeof roles)[number];
export const kinds = [
  "scope",
  "task",
  "screen",
  "token",
  "component",
  "review",
  "call",
  "feedback",
  "run",
] as const;
export type Kind = (typeof kinds)[number];
export type User = { id: string; email: string; name: string; admin: boolean };
export type Organization = {
  id: string;
  name: string;
  role: Role;
  externalId: string | null;
};
export type Project = {
  id: string;
  organizationId: string;
  name: string;
  objective: string;
  status: string;
  version: number;
  updatedAt: string;
  repository: string | null;
  externalId: string | null;
};
export type Note = {
  id: string;
  body: string;
  category: "liked" | "change" | "question" | "decision";
  screenId: string;
  author: string;
  at: string;
};
export type RecordData = {
  body: string;
  design: DesignSpec | null;
  acceptance: string;
  priority: "low" | "normal" | "high";
  screenId: string;
  value: string;
  category: string;
  targetId: string;
  targetVersion: number;
  notes: Note[];
  summary: string;
  scheduledAt: string;
  roomName: string;
  sessionId: string;
  providerStatus: string;
  resultUrl: string;
  requestKey: string;
  executionPolicy: string;
  attempts: { provider: string; status: string; at: string }[];
  reviewedBy: string;
  reviewedAt: string;
};
export type Artifact = {
  id: string;
  projectId: string;
  kind: Kind;
  title: string;
  status: string;
  data: RecordData;
  version: number;
  author: string;
  updatedAt: string;
};
export type Event = {
  id: string;
  projectId: string;
  actor: string;
  action: string;
  detail: string;
  at: string;
};
export type Workspace = {
  project: Project;
  organization: Organization;
  records: Artifact[];
  events: Event[];
  members: { email: string; role: Role }[];
};
export const emptyData = (): RecordData => ({
  body: "",
  design: null,
  acceptance: "",
  priority: "normal",
  screenId: "",
  value: "",
  category: "",
  targetId: "",
  targetVersion: 0,
  notes: [],
  summary: "",
  scheduledAt: "",
  roomName: "",
  sessionId: "",
  providerStatus: "",
  resultUrl: "",
  requestKey: "",
  executionPolicy: "manual",
  attempts: [],
  reviewedBy: "",
  reviewedAt: "",
});
export const kindLabels: Record<Kind, string> = {
  scope: "Escopo",
  task: "Tarefa",
  screen: "Tela",
  token: "Token",
  component: "Componente",
  review: "Revisão",
  call: "Call",
  feedback: "Feedback",
  run: "Desenvolvimento",
};
export const statusLabels: Record<string, string> = {
  draft: "Rascunho",
  backlog: "A fazer",
  ready: "Pronta",
  building: "Em desenvolvimento",
  review: "Em revisão",
  approved: "Aprovado",
  changes: "Ajustes solicitados",
  done: "Concluído",
  scheduled: "Agendada",
  active: "Em andamento",
  closed: "Encerrada",
  launching: "Conectando",
  uncertain: "Verificar criação",
  failed: "Falhou",
  working: "Executando",
  coding: "Gerando código",
  delivery: "Preparando entrega",
  recovered_delivery: "Entrega recuperada",
};
export const canEdit = (role: Role) => role === "admin" || role === "operator";
