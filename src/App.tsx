import {
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Circle,
  Clock3,
  Code2,
  FileText,
  Folder,
  Layers3,
  LayoutDashboard,
  MessageSquare,
  MoreHorizontal,
  Palette,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Users,
  Video,
  X,
} from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type {
  Artifact,
  Kind,
  Organization,
  Project,
  Role,
  User,
  Workspace,
} from "../shared/domain.ts";
import {
  canEdit,
  emptyData,
  kindLabels,
  statusLabels,
} from "../shared/domain.ts";
import { request } from "./api.ts";
import brokkLogo from "./assets/brokk.svg";
import { DesignEditor, DesignSystem } from "./DesignSystem.tsx";

type Me = {
  user: User | null;
  devAuth: boolean;
  integrations?: { devin: boolean; calls: boolean; var: boolean };
};
type Tab =
  | "overview"
  | "scope"
  | "tasks"
  | "screens"
  | "design"
  | "reviews"
  | "development"
  | "calls"
  | "activity"
  | "settings";
const tabs: { id: Tab; label: string; icon: typeof Folder }[] = [
  { id: "overview", label: "Visão geral", icon: LayoutDashboard },
  { id: "scope", label: "Escopo", icon: FileText },
  { id: "tasks", label: "Trabalho", icon: Layers3 },
  { id: "screens", label: "Telas", icon: Folder },
  { id: "design", label: "Design system", icon: Palette },
  { id: "reviews", label: "Revisões", icon: CheckCircle2 },
  { id: "development", label: "Desenvolvimento", icon: Code2 },
  { id: "calls", label: "Calls de review", icon: Video },
  { id: "activity", label: "Atividade", icon: Clock3 },
  { id: "settings", label: "Acesso e conexões", icon: ShieldCheck },
];
const projectLabels: Record<string, string> = {
  planning: "Planejamento",
  building: "Em desenvolvimento",
  review: "Em revisão",
  active: "Em operação",
  paused: "Pausado",
};
const fmt = (v: string) =>
  new Date(v).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
const roleLabels: Record<Role, string> = {
  admin: "Administração",
  operator: "Operador",
  client: "Cliente",
  reader: "Leitor",
};
function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const f = () => setPath(location.pathname);
    window.addEventListener("popstate", f);
    return () => window.removeEventListener("popstate", f);
  }, []);
  return path;
}
function navigate(path: string) {
  history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
function Link({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a
      href={href}
      className={className}
      onClick={(e) => {
        if (!e.metaKey && !e.ctrlKey && e.button === 0) {
          e.preventDefault();
          navigate(href);
        }
      }}
    >
      {children}
    </a>
  );
}
function Badge({ status }: { status: string }) {
  return (
    <span className={`badge ${status}`}>
      <span />
      {statusLabels[status] || projectLabels[status] || status}
    </span>
  );
}
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children as ReactElement<{ id?: string }>, { id })}
      {hint && <small>{hint}</small>}
    </div>
  );
}
function Empty({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Layers3 size={26} />
      </div>
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}
function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog ref={ref} onCancel={close} aria-label={title}>
      <div className="modal-header">
        <div>
          <p className="eyebrow">BROKK WORKSPACE</p>
          <h2>{title}</h2>
        </div>
        <button
          type="button"
          className="icon-btn"
          aria-label="Fechar"
          onClick={close}
        >
          <X />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export default function App() {
  const path = usePath(),
    [me, setMe] = useState<Me | null>(null),
    [orgs, setOrgs] = useState<Organization[]>([]),
    [projects, setProjects] = useState<Project[]>([]),
    [orgId, setOrgId] = useState(""),
    [workspace, setWorkspace] = useState<Workspace | null>(null),
    [query, setQuery] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [modal, setModal] = useState<"project" | "organization" | null>(null),
    [editing, setEditing] = useState<{ kind: Kind; record?: Artifact } | null>(
      null,
    );
  const [, , projectId, rawTab] = path.split("/"),
    tab = tabs.some((t) => t.id === rawTab) ? (rawTab as Tab) : "overview";
  const reload = useCallback(async () => {
    const [o, p] = await Promise.all([
      request<Organization[]>("/organizations"),
      request<Project[]>("/projects"),
    ]);
    setOrgs(o);
    setProjects(p);
    setOrgId((current) => current || o[0]?.id || "");
    if (projectId) {
      const ws = await request<Workspace>(`/projects/${projectId}`);
      setWorkspace(ws);
      setOrgId(ws.organization.id);
    } else setWorkspace(null);
  }, [projectId]);
  useEffect(() => {
    request<Me>("/me")
      .then(setMe)
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (me?.user) reload().catch((e) => setError(e.message));
  }, [me, reload]);
  useEffect(() => {
    if (!me?.user || !projectId) return;
    const source = new EventSource(`/api/projects/${projectId}/events`);
    source.addEventListener("workspace", (e) => {
      try {
        const fresh = JSON.parse((e as MessageEvent).data);
        setWorkspace((ws) =>
          ws?.project.id === projectId
            ? { ...ws, records: fresh.records, events: fresh.events }
            : ws,
        );
      } catch {
        /* reconnect provides a new snapshot */
      }
    });
    return () => source.close();
  }, [projectId, me?.user]);
  const perform = async (fn: () => Promise<unknown>, message = "Salvo.") => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await reload();
      setNotice(message);
      setTimeout(() => setNotice(""), 3500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível concluir.");
    } finally {
      setBusy(false);
    }
  };
  if (!me)
    return (
      <div className="loading">
        <img src={brokkLogo} alt="Brokk" className="brokk-logo" />
        <p>Preparando seu workspace…</p>
        {error && <p role="alert">{error}</p>}
      </div>
    );
  if (!me.user)
    return (
      <main className="signin">
        <div className="signin-brand">
          <img src={brokkLogo} alt="" className="brokk-logo" />
          <b>
            Brokk<span>DESENVOLVIMENTO</span>
          </b>
        </div>
        <div className="signin-copy">
          <p className="eyebrow">DA IDEIA À ENTREGA</p>
          <h1>
            Um lugar para
            <br />
            construir o que vem depois.
          </h1>
          <p>
            Escopo claro. Design consistente. Desenvolvimento acompanhado. Cada
            decisão, no contexto do seu projeto.
          </p>
        </div>
        <div className="signin-card">
          <span className="small-icon">
            <ShieldCheck />
          </span>
          <h2>Seu workspace de desenvolvimento</h2>
          <p>
            Entre com a identidade da Cold Code Labs ou abra o projeto pelo
            agente Brokk no Var.
          </p>
          <a className="primary" href="/api/auth/start">
            Entrar com CCL ID <ArrowRight size={16} />
          </a>
          {me.devAuth && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                try {
                  await request("/auth/dev", "POST", {
                    email: data.get("email"),
                  });
                  setMe(await request("/me"));
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            >
              <Field label="Acesso local de desenvolvimento">
                <input
                  name="email"
                  type="email"
                  defaultValue="admin@local.test"
                  required
                />
              </Field>
              <button type="submit" className="secondary">
                Entrar no ambiente local
              </button>
            </form>
          )}
          {(error || location.search.includes("failed")) && (
            <p role="alert" className="error">
              {error || "Não foi possível concluir o login. Tente novamente."}
            </p>
          )}
          <small>Acesso limitado às organizações atribuídas a você.</small>
        </div>
        <footer>Cold Code Labs · Brokk</footer>
      </main>
    );
  const currentOrg = orgs.find((o) => o.id === orgId),
    shown = projects.filter(
      (p) =>
        (!orgId || p.organizationId === orgId) &&
        `${p.name} ${p.objective}`.toLowerCase().includes(query.toLowerCase()),
    ),
    role =
      workspace?.organization.role ||
      currentOrg?.role ||
      (me.user.admin ? "admin" : "reader"),
    editable = canEdit(role),
    _records = workspace?.records || [];
  const create = (kind: Kind) => setEditing({ kind });
  return (
    <div className="app">
      <aside className="sidebar">
        <Link href="/" className="brand">
          <img src={brokkLogo} alt="" className="brokk-logo" />
          <span>
            Brokk<small>DEVELOPMENT HOUSE</small>
          </span>
        </Link>
        <label className="org-select">
          <span>ORGANIZAÇÃO</span>
          <select
            aria-label="Organização"
            value={orgId}
            onChange={(e) => {
              setOrgId(e.target.value);
              navigate("/");
            }}
          >
            <option value="" disabled>
              Selecione uma organização
            </option>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
        <p className="nav-label">WORKSPACE</p>
        <Link href="/" className={`nav-item ${!projectId ? "selected" : ""}`}>
          <LayoutDashboard size={18} />
          Projetos{" "}
          <span>
            {projects.filter((p) => p.organizationId === orgId).length}
          </span>
        </Link>
        {workspace && (
          <>
            <div className="project-nav-label">
              <span className="tiny-square" />
              {workspace.project.name}
            </div>
            <nav>
              {tabs.map((t) => (
                <Link
                  key={t.id}
                  href={`/projects/${projectId}/${t.id}`}
                  className={`nav-item ${tab === t.id ? "selected" : ""}`}
                >
                  <t.icon size={17} />
                  {t.label}
                </Link>
              ))}
            </nav>
          </>
        )}
        <div className="sidebar-bottom">
          <div className="secure-note">
            <ShieldCheck size={16} />
            <span>
              Produto nas suas mãos.
              <br />
              Acesso técnico protegido.
            </span>
          </div>
          {me.user.admin && (
            <button
              type="button"
              className="nav-item"
              onClick={() => setModal("organization")}
            >
              <Plus size={17} />
              Nova organização
            </button>
          )}
          <div className="user-card">
            <span className="avatar">
              {me.user.name.slice(0, 2).toUpperCase()}
            </span>
            <div>
              <b>{me.user.name}</b>
              <small>{roleLabels[role]}</small>
            </div>
            <button
              type="button"
              className="icon-btn"
              aria-label="Sair"
              onClick={async () => {
                await request("/auth/logout", "POST", {});
                setMe(await request("/me"));
              }}
            >
              ↗
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            {currentOrg?.name || "Seu workspace"}
            <span>/</span>
            <b>{workspace?.project.name || "Projetos"}</b>
          </div>
          <span className="topbar-chip">
            <Circle size={7} fill="currentColor" /> Brokk workspace
          </span>
        </header>
        <main className="content">
          {error && (
            <div role="alert" className="banner error">
              <span>{error}</span>
              <button
                type="button"
                aria-label="Fechar aviso"
                onClick={() => setError("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {notice && (
            <div role="status" className="banner success">
              <Check size={16} />
              {notice}
            </div>
          )}
          {!projectId ? (
            <>
              <div className="page-heading">
                <div>
                  <p className="eyebrow">SEU ESPAÇO DE CONSTRUÇÃO</p>
                  <h1>Projetos</h1>
                  <p>
                    Da primeira conversa à próxima entrega. Tudo no mesmo
                    contexto.
                  </p>
                </div>
                {editable && (
                  <button
                    type="button"
                    className="primary"
                    onClick={() => setModal("project")}
                  >
                    <Plus size={17} />
                    Novo projeto
                  </button>
                )}
              </div>
              <div className="stats">
                <Stat
                  number={shown.length}
                  label="Projetos nesta organização"
                  note="Uma visão de cada entrega"
                />
                <Stat
                  number={shown.filter((p) => p.status === "building").length}
                  label="Em desenvolvimento"
                  note="Do escopo à implementação"
                />
                <Stat
                  number={shown.filter((p) => p.status === "review").length}
                  label="Em revisão"
                  note="Prontos para sua decisão"
                />
              </div>
              <div className="section-head">
                <h2>
                  Carteira de projetos <span>{shown.length}</span>
                </h2>
                <label className="search">
                  <Search size={16} />
                  <input
                    aria-label="Buscar projetos"
                    placeholder="Buscar projeto…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
              </div>
              {shown.length ? (
                <div className="project-grid">
                  {shown.map((p, i) => (
                    <Link
                      key={p.id}
                      href={`/projects/${p.id}`}
                      className="project-card"
                    >
                      <div className="project-card-top">
                        <span className={`project-symbol tone-${i % 3}`}>
                          <Folder size={21} />
                        </span>
                        <Badge status={p.status} />
                        <ArrowUpRight size={18} />
                      </div>
                      <h3>{p.name}</h3>
                      <p>
                        {p.objective ||
                          "Defina o objetivo e comece pelo escopo do projeto."}
                      </p>
                      <div className="project-card-foot">
                        <span>Atualizado em {fmt(p.updatedAt)}</span>
                        <span className="avatar small">
                          {p.name.slice(0, 2).toUpperCase()}
                        </span>
                      </div>
                    </Link>
                  ))}
                </div>
              ) : (
                <Empty
                  title={
                    orgs.length
                      ? "O próximo projeto começa aqui."
                      : "Primeiro, uma organização."
                  }
                  body={
                    orgs.length
                      ? "Transforme uma necessidade em escopo, telas e entregas que o cliente pode acompanhar."
                      : "A administração atribui organizações e pessoas. Cada projeto fica no contexto certo."
                  }
                  action={
                    editable ? (
                      <button
                        type="button"
                        className="primary"
                        onClick={() => setModal("project")}
                      >
                        <Plus size={16} />
                        Criar primeiro projeto
                      </button>
                    ) : me.user.admin ? (
                      <button
                        type="button"
                        className="primary"
                        onClick={() => setModal("organization")}
                      >
                        Criar organização
                      </button>
                    ) : undefined
                  }
                />
              )}
              <div className="journey">
                <div>
                  <p className="eyebrow">UM FLUXO, DO COMEÇO AO FIM</p>
                  <h3>
                    Clareza para construir.
                    <br />
                    Contexto para evoluir.
                  </h3>
                </div>
                {[
                  "Alinhar o escopo",
                  "Desenhar a experiência",
                  "Desenvolver com contexto",
                  "Revisar com o cliente",
                ].map((s, i) => (
                  <div className="journey-step" key={s}>
                    <span>0{i + 1}</span>
                    <b>{s}</b>
                    <ArrowRight size={18} />
                  </div>
                ))}
              </div>
            </>
          ) : workspace ? (
            <>
              <div className="page-heading">
                <div>
                  <p className="eyebrow">
                    {workspace.organization.name.toUpperCase()} ·{" "}
                    {tabs.find((t) => t.id === tab)?.label.toUpperCase()}
                  </p>
                  <h1>
                    {tab === "overview"
                      ? workspace.project.name
                      : tabs.find((t) => t.id === tab)?.label}
                  </h1>
                  <p>
                    {tab === "overview"
                      ? workspace.project.objective
                      : tabCopy[tab]}
                  </p>
                </div>
                <Badge status={workspace.project.status} />
              </div>
              <div className="project-tabs">
                {tabs.slice(0, 8).map((t) => (
                  <Link
                    key={t.id}
                    href={`/projects/${projectId}/${t.id}`}
                    className={tab === t.id ? "active" : ""}
                  >
                    {t.label}
                  </Link>
                ))}
              </div>
              {tab === "overview" && (
                <Overview ws={workspace} editable={editable} create={create} />
              )}{" "}
              {["scope", "tasks", "screens", "reviews"].includes(tab) && (
                <Records
                  tab={tab}
                  ws={workspace}
                  editable={editable}
                  create={create}
                  edit={(r) => setEditing({ kind: r.kind, record: r })}
                  perform={perform}
                  busy={busy}
                />
              )}{" "}
              {tab === "design" && (
                <DesignSystem
                  ws={workspace}
                  editable={editable}
                  perform={perform}
                  busy={busy}
                />
              )}
              {tab === "activity" && <Activity ws={workspace} />}{" "}
              {tab === "development" && (
                <Development
                  ws={workspace}
                  editable={editable}
                  connected={Boolean(me.integrations?.devin)}
                  perform={perform}
                  busy={busy}
                />
              )}{" "}
              {tab === "calls" && (
                <Calls
                  ws={workspace}
                  editable={editable}
                  create={() => create("call")}
                  perform={perform}
                  busy={busy}
                />
              )}{" "}
              {tab === "settings" && (
                <Settings ws={workspace} perform={perform} busy={busy} />
              )}
            </>
          ) : (
            <div className="loading">
              <Clock3 />
              <p>{error ? "Projeto indisponível." : "Carregando o projeto…"}</p>
            </div>
          )}
        </main>
        <footer className="workspace-footer">
          <span>Brokk · Cold Code Labs</span>
          <span>Um projeto. Todo o contexto.</span>
        </footer>
      </div>
      {modal && (
        <Modal
          title={modal === "project" ? "Novo projeto" : "Nova organização"}
          close={() => setModal(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              void perform(async () => {
                if (modal === "organization") {
                  const org = await request<Organization>(
                    "/organizations",
                    "POST",
                    { name: data.get("name") },
                  );
                  setOrgId(org.id);
                  navigate("/");
                } else {
                  const p = await request<Project>("/projects", "POST", {
                    organizationId: data.get("organizationId"),
                    name: data.get("name"),
                    objective: data.get("objective"),
                  });
                  navigate(`/projects/${p.id}`);
                }
                setModal(null);
              });
            }}
          >
            {modal === "project" && (
              <Field label="Organização">
                <select name="organizationId" defaultValue={orgId} required>
                  {orgs
                    .filter((o) => canEdit(o.role))
                    .map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                </select>
              </Field>
            )}
            <Field label="Nome">
              <input
                name="name"
                placeholder={
                  modal === "project"
                    ? "Ex.: Portal de atendimento"
                    : "Ex.: Cold Code Labs"
                }
                maxLength={200}
                required
              />
            </Field>
            {modal === "project" && (
              <Field label="Objetivo do projeto">
                <textarea
                  name="objective"
                  placeholder="Que problema vamos resolver? Para quem?"
                  required
                  maxLength={12000}
                />
              </Field>
            )}
            <div className="form-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => setModal(null)}
              >
                Cancelar
              </button>
              <button type="submit" disabled={busy} className="primary">
                {busy ? "Criando…" : "Criar"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {editing && workspace && (
        <RecordEditor
          editing={editing}
          ws={workspace}
          busy={busy}
          close={() => setEditing(null)}
          perform={perform}
        />
      )}
    </div>
  );
}
const tabCopy: Record<Tab, string> = {
  overview: "",
  scope: "O que vamos construir, por quê e como saber que ficou pronto.",
  tasks:
    "Pequenas entregas, com critérios claros e prioridades compartilhadas.",
  screens: "A experiência do usuário, tela por tela.",
  design: "Uma linguagem visual consistente para todo o produto.",
  reviews: "Feedback e decisões vinculados à versão que o cliente revisou.",
  development:
    "Direcione o trabalho e acompanhe o Devin no contexto do projeto.",
  calls:
    "Converse com o cliente, registre decisões e transforme ajustes em trabalho.",
  activity: "Cada mudança com autoria e contexto.",
  settings: "Pessoas autorizadas e conexões administradas para este projeto.",
};
function Stat({
  number,
  label,
  note,
}: {
  number: number;
  label: string;
  note: string;
}) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{number.toString().padStart(2, "0")}</strong>
      <small>{note}</small>
    </div>
  );
}
function Overview({
  ws,
  editable,
  create,
}: {
  ws: Workspace;
  editable: boolean;
  create: (kind: Kind) => void;
}) {
  const tasks = ws.records.filter((r) => r.kind === "task"),
    scope = ws.records.find((r) => r.kind === "scope");
  return (
    <>
      <div className="stats">
        <Stat
          number={tasks.filter((t) => t.status !== "done").length}
          label="Entregas em aberto"
          note="Trabalho com critérios de aceite"
        />
        <Stat
          number={ws.records.filter((r) => r.kind === "screen").length}
          label="Telas planejadas"
          note="Uma experiência com intenção"
        />
        <Stat
          number={
            ws.records.filter(
              (r) => r.kind === "review" && r.status === "review",
            ).length
          }
          label="Decisões pendentes"
          note="O cliente participa da evolução"
        />
      </div>
      <div className="overview-grid">
        <section className="panel">
          <div className="section-head">
            <div>
              <p className="eyebrow">PONTO DE PARTIDA</p>
              <h2>Um escopo que guia o trabalho</h2>
            </div>
            <FileText size={22} />
          </div>
          {scope ? (
            <>
              <Badge status={scope.status} />
              <h3>{scope.title}</h3>
              <p className="prose">{scope.data.body}</p>
              <Link
                href={`/projects/${ws.project.id}/scope`}
                className="text-link"
              >
                Revisar o escopo <ArrowRight size={15} />
              </Link>
            </>
          ) : (
            <>
              <p>
                Defina objetivos, entregas e limites antes de começar a
                desenvolver. O aceite deixa todos na mesma página.
              </p>
              {editable && (
                <button
                  type="button"
                  className="primary"
                  onClick={() => create("scope")}
                >
                  <Plus size={16} />
                  Definir escopo
                </button>
              )}
            </>
          )}
        </section>
        <section className="panel flow-panel">
          <p className="eyebrow">SEU PROJETO EM MOVIMENTO</p>
          <h2>Construir, revisar, evoluir.</h2>
          {[
            {
              label: "Escopo alinhado",
              done: scope?.status === "approved",
              to: "scope",
            },
            {
              label: "Experiência desenhada",
              done: ws.records.some((r) => r.kind === "screen"),
              to: "screens",
            },
            {
              label: "Trabalho em desenvolvimento",
              done: ws.records.some((r) => r.kind === "run"),
              to: "development",
            },
            {
              label: "Feedback do cliente",
              done: ws.records.some(
                (r) => r.kind === "review" && r.status === "approved",
              ),
              to: "reviews",
            },
          ].map((s, i) => (
            <Link
              className="flow-step"
              href={`/projects/${ws.project.id}/${s.to}`}
              key={s.label}
            >
              <span className={s.done ? "complete" : ""}>
                {s.done ? <Check size={14} /> : i + 1}
              </span>
              <b>{s.label}</b>
              <ArrowRight size={16} />
            </Link>
          ))}
        </section>
      </div>
      <div className="section-head">
        <h2>Últimas movimentações</h2>
        <Link
          className="text-link"
          href={`/projects/${ws.project.id}/activity`}
        >
          Ver atividade <ArrowRight size={15} />
        </Link>
      </div>
      <Activity ws={{ ...ws, events: ws.events.slice(0, 5) }} />
    </>
  );
}
function Activity({ ws }: { ws: Workspace }) {
  return (
    <section className="panel activity">
      {ws.events.length ? (
        ws.events.map((e) => (
          <div className="activity-row" key={e.id}>
            <span className="activity-dot" />
            <div>
              <strong>{e.detail}</strong>
              <p>
                {e.actor} · {e.action.replaceAll(".", " / ")}
              </p>
            </div>
            <time>{fmt(e.at)}</time>
          </div>
        ))
      ) : (
        <p>A atividade deste projeto aparece aqui.</p>
      )}
    </section>
  );
}
function Records({
  tab,
  ws,
  editable,
  create,
  edit,
  perform,
  busy,
}: {
  tab: Tab;
  ws: Workspace;
  editable: boolean;
  create: (k: Kind) => void;
  edit: (r: Artifact) => void;
  perform: (fn: () => Promise<unknown>, m?: string) => Promise<void>;
  busy: boolean;
}) {
  const kind: Kind =
      tab === "scope"
        ? "scope"
        : tab === "tasks"
          ? "task"
          : tab === "screens"
            ? "screen"
            : tab === "reviews"
              ? "review"
              : "token",
    rows = ws.records.filter((r) =>
      tab === "design"
        ? ["token", "component"].includes(r.kind)
        : r.kind === kind,
    );
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  return (
    <>
      <div className="section-head">
        <h2>
          {tab === "design" ? "Tokens e componentes" : kindLabels[kind]}{" "}
          <span>{rows.length}</span>
        </h2>
        <div className="inline-actions">
          {editable && tab === "design" && (
            <button
              type="button"
              className="secondary"
              onClick={() => create("component")}
            >
              <Plus size={16} />
              Componente
            </button>
          )}
          {editable && !(kind === "scope" && rows.length > 0) && (
            <button
              type="button"
              className="primary"
              onClick={() => create(kind)}
            >
              <Plus size={16} />
              {tab === "reviews"
                ? "Solicitar revisão"
                : tab === "design"
                  ? "Novo token"
                  : `Adicionar ${kindLabels[kind].toLowerCase()}`}
            </button>
          )}
        </div>
      </div>
      {!rows.length ? (
        <Empty
          title={`Seu ${tab === "design" ? "design system" : kindLabels[kind].toLowerCase()} começa aqui.`}
          body={tabCopy[tab]}
        />
      ) : tab === "tasks" ? (
        <div className="kanban">
          {[
            ["backlog", "A fazer"],
            ["ready", "Prontas"],
            ["building", "Em desenvolvimento"],
            ["review", "Em revisão"],
            ["done", "Concluídas"],
          ].map(([status, label]) => (
            <section className="kanban-column" key={status}>
              <h3>
                <span className={`column-dot ${status}`} />
                {label}
                <small>
                  {
                    rows.filter(
                      (r) =>
                        r.status === status ||
                        (status === "done" && r.status === "approved"),
                    ).length
                  }
                </small>
              </h3>
              {rows
                .filter(
                  (r) =>
                    r.status === status ||
                    (status === "done" && r.status === "approved"),
                )
                .map((r) => (
                  <button
                    type="button"
                    className="task-card"
                    key={r.id}
                    onClick={() => editable && edit(r)}
                  >
                    <div>
                      <span className={`priority ${r.data.priority}`}>
                        {r.data.priority === "high"
                          ? "Alta"
                          : r.data.priority === "low"
                            ? "Baixa"
                            : "Normal"}
                      </span>
                      <MoreHorizontal size={15} />
                    </div>
                    <h4>{r.title}</h4>
                    <p>{r.data.body}</p>
                    <footer>
                      <span>v{r.version}</span>
                      <span className="avatar small">
                        {r.author.slice(0, 2).toUpperCase()}
                      </span>
                    </footer>
                  </button>
                ))}
            </section>
          ))}
        </div>
      ) : (
        <div className="records-grid">
          {rows.map((r) => (
            <article className={`record-card ${r.kind}`} key={r.id}>
              <div className="record-top">
                <span className="eyebrow">
                  {kindLabels[r.kind]} · v{r.version}
                </span>
                <Badge status={r.status} />
              </div>
              {r.kind === "screen" && (
                <div className="screen-schematic" aria-hidden="true">
                  <div />
                  <div>
                    <span />
                    <span />
                    <span />
                  </div>
                  <section>
                    <i />
                    <i />
                    <i />
                  </section>
                  <small>{r.title}</small>
                </div>
              )}
              {r.kind === "token" && (
                <div className="token-preview">
                  <span
                    style={{
                      backgroundColor: /^#[a-f0-9]{3,8}$/i.test(r.data.value)
                        ? r.data.value
                        : "var(--panel-2)",
                    }}
                  />
                  <code>{r.data.value}</code>
                </div>
              )}
              <h3>{r.title}</h3>
              <p className="prose">
                {r.data.body || "Sem descrição adicional."}
              </p>
              {r.data.acceptance && (
                <div className="acceptance">
                  <CheckCircle2 size={15} />
                  <span>{r.data.acceptance}</span>
                </div>
              )}
              {r.kind === "review" && (
                <>
                  <small>
                    Item v{r.data.targetVersion} ·{" "}
                    {ws.records.find((x) => x.id === r.data.targetId)?.title ||
                      "Item revisado"}
                  </small>
                  {r.status === "review" &&
                  ws.organization.role !== "reader" ? (
                    <div className="review-actions">
                      <textarea
                        aria-label={`Feedback para ${r.title}`}
                        placeholder="O que ficou bom? O que precisa mudar?"
                        value={feedback[r.id] || ""}
                        onChange={(e) =>
                          setFeedback({ ...feedback, [r.id]: e.target.value })
                        }
                      />
                      <div>
                        <button
                          type="button"
                          disabled={busy || !feedback[r.id]?.trim()}
                          className="secondary"
                          onClick={() =>
                            perform(
                              () =>
                                request(
                                  `/projects/${ws.project.id}/reviews/${r.id}/decision`,
                                  "POST",
                                  {
                                    version: r.version,
                                    decision: "changes",
                                    feedback: feedback[r.id],
                                  },
                                ),
                              "Ajustes registrados.",
                            )
                          }
                        >
                          Pedir ajustes
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          className="primary"
                          onClick={() =>
                            perform(
                              () =>
                                request(
                                  `/projects/${ws.project.id}/reviews/${r.id}/decision`,
                                  "POST",
                                  {
                                    version: r.version,
                                    decision: "approved",
                                    feedback: feedback[r.id] || "",
                                  },
                                ),
                              "Aprovação registrada.",
                            )
                          }
                        >
                          <Check size={16} />
                          Aprovar versão
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="review-receipt">
                      {r.data.reviewedBy && `Decisão por ${r.data.reviewedBy}`}
                    </p>
                  )}
                </>
              )}
              {editable && !["review", "run"].includes(r.kind) && (
                <div className="record-actions">
                  <button
                    type="button"
                    className="text-link"
                    onClick={() => edit(r)}
                  >
                    Editar especificação <ArrowRight size={14} />
                  </button>
                  {["scope", "screen", "component"].includes(r.kind) && (
                    <button
                      type="button"
                      className="text-link"
                      disabled={busy}
                      onClick={() =>
                        perform(
                          () =>
                            request(
                              `/projects/${ws.project.id}/records`,
                              "POST",
                              {
                                kind: "review",
                                title: `Revisar ${r.title}`,
                                status: "review",
                                data: {
                                  body: "",
                                  targetId: r.id,
                                  targetVersion: r.version,
                                },
                              },
                            ),
                          "Revisão solicitada.",
                        )
                      }
                    >
                      Solicitar revisão
                    </button>
                  )}
                </div>
              )}
              <small className="updated">
                Atualizado em {fmt(r.updatedAt)}
              </small>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
function RecordEditor({
  editing,
  ws,
  busy,
  close,
  perform,
}: {
  editing: { kind: Kind; record?: Artifact };
  ws: Workspace;
  busy: boolean;
  close: () => void;
  perform: (fn: () => Promise<unknown>, m?: string) => Promise<void>;
}) {
  const { kind, record } = editing,
    initial = record?.data || emptyData(),
    [target, setTarget] = useState(initial.targetId);
  const statuses =
    kind === "task"
      ? ["backlog", "ready", "building", "review", "done"]
      : kind === "call"
        ? ["scheduled"]
        : kind === "review"
          ? ["review"]
          : ["draft"];
  if (record?.data.design || ["token", "component"].includes(kind))
    return (
      <DesignEditor
        key={record?.id || kind}
        editing={editing}
        ws={ws}
        busy={busy}
        close={close}
        perform={perform}
      />
    );
  return (
    <Modal
      title={
        record
          ? `Editar ${kindLabels[kind].toLowerCase()}`
          : `${kindLabels[kind]} do projeto`
      }
      close={close}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const fields = new FormData(e.currentTarget),
            data = {
              body: String(fields.get("body") || ""),
              acceptance: String(fields.get("acceptance") || ""),
              priority: fields.get("priority") || "normal",
              screenId: fields.get("screenId") || "",
              value: fields.get("value") || "",
              category: fields.get("category") || "",
              targetId: target,
              targetVersion:
                ws.records.find((r) => r.id === target)?.version || 0,
              scheduledAt: fields.get("scheduledAt")
                ? new Date(String(fields.get("scheduledAt"))).toISOString()
                : "",
            };
          void perform(async () => {
            await request(
              `/projects/${ws.project.id}/records${record ? `/${record.id}` : ""}`,
              record ? "PATCH" : "POST",
              {
                ...(record ? { version: record.version } : { kind }),
                title: fields.get("title"),
                status: fields.get("status") || statuses[0],
                data,
              },
            );
            close();
          });
        }}
      >
        <Field label="Título">
          <input
            name="title"
            defaultValue={record?.title || ""}
            required
            maxLength={200}
          />
        </Field>
        {kind === "review" && (
          <Field label="O que vamos revisar?">
            <select
              required
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="">Selecione uma especificação</option>
              {ws.records
                .filter((r) =>
                  ["scope", "screen", "task", "component", "token"].includes(
                    r.kind,
                  ),
                )
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title} · v{r.version}
                  </option>
                ))}
            </select>
          </Field>
        )}
        <Field
          label={
            kind === "scope"
              ? "Objetivo, entregas e limites"
              : kind === "screen"
                ? "Propósito, fluxo e estados da tela"
                : kind === "call"
                  ? "Pauta e objetivo da review"
                  : "Descrição"
          }
        >
          <textarea
            name="body"
            defaultValue={initial.body}
            maxLength={12000}
            rows={5}
          />
        </Field>
        {["scope", "task", "screen", "component"].includes(kind) && (
          <Field
            label="Critérios de aceite"
            hint="Descreva como vamos verificar que esta entrega atende ao combinado."
          >
            <textarea
              name="acceptance"
              defaultValue={initial.acceptance}
              maxLength={12000}
              rows={3}
            />
          </Field>
        )}
        {["task", "component"].includes(kind) && (
          <Field label="Tela relacionada">
            <select name="screenId" defaultValue={initial.screenId}>
              <option value="">Sem tela vinculada</option>
              {ws.records
                .filter((r) => r.kind === "screen")
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title}
                  </option>
                ))}
            </select>
          </Field>
        )}
        {kind === "token" && (
          <div className="two-fields">
            <Field label="Valor">
              <input
                name="value"
                placeholder="#F88E2D, 16px, Instrument Sans"
                defaultValue={initial.value}
                maxLength={300}
                required
              />
            </Field>
            <Field label="Categoria">
              <select name="category" defaultValue={initial.category || "Cor"}>
                {[
                  "Cor",
                  "Tipografia",
                  "Espaçamento",
                  "Raio",
                  "Sombra",
                  "Outro",
                ].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </Field>
          </div>
        )}
        {kind === "call" && (
          <Field label="Agendamento">
            <input
              type="datetime-local"
              name="scheduledAt"
              defaultValue={
                initial.scheduledAt
                  ? new Date(initial.scheduledAt).toISOString().slice(0, 16)
                  : ""
              }
            />
          </Field>
        )}
        {kind === "task" && (
          <div className="two-fields">
            <Field label="Estado">
              <select
                name="status"
                defaultValue={
                  record?.status === "approved"
                    ? "done"
                    : record?.status || "backlog"
                }
              >
                {statuses.map((s) => (
                  <option key={s} value={s}>
                    {statusLabels[s]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Prioridade">
              <select name="priority" defaultValue={initial.priority}>
                <option value="normal">Normal</option>
                <option value="high">Alta</option>
                <option value="low">Baixa</option>
              </select>
            </Field>
          </div>
        )}
        <div className="form-actions">
          <button className="secondary" type="button" onClick={close}>
            Cancelar
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy
              ? "Salvando…"
              : record
                ? "Salvar nova versão"
                : "Adicionar ao projeto"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function Development({
  ws,
  editable,
  connected,
  perform,
  busy,
}: {
  ws: Workspace;
  editable: boolean;
  connected: boolean;
  perform: (fn: () => Promise<unknown>, m?: string) => Promise<void>;
  busy: boolean;
}) {
  const tasks = ws.records.filter((r) => r.kind === "task"),
    runs = ws.records.filter((r) => r.kind === "run"),
    [taskId, setTaskId] = useState(""),
    [selected, setSelected] = useState(""),
    [context, setContext] = useState<{
      prompt: string;
      maxAcu: number;
      repository: string | null;
    } | null>(null),
    [remote, setRemote] = useState<{
      status: string;
      statusDetail: string;
      messages: { event_id: string; message: string; source: string }[];
    } | null>(null),
    [providerError, setProviderError] = useState(""),
    requestKey = useRef(crypto.randomUUID());
  useEffect(() => {
    if (!selected) return;
    let live = true;
    const update = () =>
      request<typeof remote>(
        `/projects/${ws.project.id}/development/${selected}`,
      )
        .then((r) => {
          if (live) {
            setRemote(r);
            setProviderError("");
          }
        })
        .catch((e) => {
          if (live) setProviderError(e.message);
        });
    void update();
    const timer = setInterval(update, 8000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [selected, ws.project.id]);
  return (
    <>
      <div className="integration-strip">
        <div>
          <Sparkles size={21} />
          <span>
            <b>Devin · desenvolvimento assistido</b>
            <small>
              Contexto do projeto, execução limitada e pedidos em tempo real.
            </small>
          </span>
        </div>
        <span className={`connection ${connected ? "on" : ""}`}>
          <Circle size={7} fill="currentColor" />
          {connected ? "Conectado" : "Aguardando conexão"}
        </span>
      </div>
      <div className="development-grid">
        <section className="panel">
          <p className="eyebrow">PRÓXIMA ENTREGA</p>
          <h2>O que vamos desenvolver?</h2>
          <p>
            Selecione uma tarefa. O Brokk compartilha o escopo e as
            especificações deste projeto com o Devin.
          </p>
          <Field label="Tarefa">
            <select
              value={taskId}
              onChange={(e) => {
                setTaskId(e.target.value);
                setContext(null);
                requestKey.current = crypto.randomUUID();
              }}
            >
              <option value="">Selecione uma tarefa</option>
              {tasks.map((t) => (
                <option value={t.id} key={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
          </Field>
          <button
            type="button"
            className="primary"
            disabled={!editable || !taskId || busy}
            onClick={() =>
              perform(
                async () =>
                  setContext(
                    await request(
                      `/projects/${ws.project.id}/development/context`,
                      "POST",
                      { taskId },
                    ),
                  ),
                "Contexto preparado.",
              )
            }
          >
            <ArrowRight size={16} />
            Preparar desenvolvimento
          </button>
          {!connected && (
            <p className="integration-help">
              A administração conecta o Devin e define os limites. Você já pode
              organizar escopo, tarefas e telas.
            </p>
          )}
          <div className="guardrail">
            <ShieldCheck size={16} />
            <span>
              Operadores direcionam o produto. Repositórios e permissões são
              definidos pela administração.
            </span>
          </div>
        </section>
        <section className="panel">
          <div className="section-head">
            <h2>Execuções do projeto</h2>
            <span className="count">{runs.length}</span>
          </div>
          {runs.length ? (
            runs.map((r) => (
              <button
                type="button"
                key={r.id}
                className={`run-row ${selected === r.id ? "selected" : ""}`}
                onClick={() => setSelected(r.id)}
              >
                <Code2 size={18} />
                <span>
                  <b>{r.title}</b>
                  <small>{fmt(r.updatedAt)}</small>
                </span>
                <Badge status={r.status} />
              </button>
            ))
          ) : (
            <Empty
              title="Pronto para começar."
              body="As execuções do Devin e seus estados aparecem aqui."
            />
          )}
        </section>
      </div>
      {selected && (
        <section className="panel conversation">
          <div className="section-head">
            <h2>Acompanhar e direcionar</h2>
            <span className="connection on">
              {remote?.status || "Atualizando"}
            </span>
          </div>
          {providerError && (
            <p role="alert" className="error">
              {providerError}
            </p>
          )}
          {remote?.statusDetail && <p>{remote.statusDetail}</p>}
          <div className="messages">
            {remote?.messages?.length ? (
              remote.messages.map((m, i) => (
                <div
                  className={`message ${m.source === "user" ? "user" : "agent"}`}
                  key={m.event_id || i}
                >
                  <small>
                    {m.source === "user" ? "Pedido da equipe" : "Devin"}
                  </small>
                  <p>{m.message}</p>
                </div>
              ))
            ) : (
              <p>A sessão ainda não tem mensagens disponíveis.</p>
            )}
          </div>
          {editable && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const form = e.currentTarget,
                  data = new FormData(form);
                void perform(async () => {
                  await request(
                    `/projects/${ws.project.id}/development/${selected}/messages`,
                    "POST",
                    { message: data.get("message") },
                  );
                  form.reset();
                }, "Pedido enviado ao Devin.");
              }}
            >
              <Field label="Novo direcionamento">
                <textarea
                  name="message"
                  maxLength={4000}
                  placeholder="Descreva o ajuste que você quer ver…"
                  required
                />
              </Field>
              <button type="submit" disabled={busy} className="primary">
                <ArrowUpRight size={16} />
                Enviar pedido
              </button>
            </form>
          )}
        </section>
      )}
      {context && (
        <Modal
          title="Contexto do desenvolvimento"
          close={() => setContext(null)}
        >
          <div className="context-summary">
            <p>
              A execução usa o escopo aprovado, a tarefa selecionada e as
              especificações deste projeto.
            </p>
            <dl>
              <div>
                <dt>Tarefa</dt>
                <dd>{tasks.find((t) => t.id === taskId)?.title}</dd>
              </div>
              <div>
                <dt>Limite por execução</dt>
                <dd>{context.maxAcu} ACU</dd>
              </div>
              <div>
                <dt>Repositório autorizado</dt>
                <dd>{context.repository || "Não configurado"}</dd>
              </div>
            </dl>
            <details>
              <summary>Conferir contexto compartilhado</summary>
              <pre>{context.prompt}</pre>
            </details>
          </div>
          <div className="form-actions">
            <button
              type="button"
              className="secondary"
              onClick={() => setContext(null)}
            >
              Voltar
            </button>
            <button
              type="button"
              className="primary"
              disabled={!connected || busy || !context.repository}
              onClick={() =>
                perform(async () => {
                  const run = await request<Artifact>(
                    `/projects/${ws.project.id}/development`,
                    "POST",
                    { taskId, requestKey: requestKey.current },
                  );
                  setSelected(run.id);
                  setContext(null);
                }, "Desenvolvimento solicitado.")
              }
            >
              <Sparkles size={16} />
              {busy ? "Solicitando…" : "Enviar ao Devin"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
function Calls({
  ws,
  editable,
  create,
  perform,
  busy,
}: {
  ws: Workspace;
  editable: boolean;
  create: () => void;
  perform: (fn: () => Promise<unknown>, m?: string) => Promise<void>;
  busy: boolean;
}) {
  const calls = ws.records.filter((r) => r.kind === "call"),
    [selected, setSelected] = useState(""),
    [room, setRoom] = useState<{ url: string; token: string } | null>(null),
    [videoError, setVideoError] = useState(""),
    call = calls.find((r) => r.id === selected) || calls[0],
    container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!room || !container.current) return;
    let frame: import("@daily-co/daily-js").DailyCall | undefined,
      disposed = false;
    const target = container.current;
    import("@daily-co/daily-js")
      .then(async ({ default: Daily }) => {
        if (disposed) return;
        frame = Daily.createFrame(target, {
          showLeaveButton: true,
          showFullscreenButton: true,
          iframeStyle: {
            width: "100%",
            height: "100%",
            border: "0",
            borderRadius: "12px",
          },
        });
        await frame.join({ url: room.url, token: room.token });
      })
      .catch(() =>
        setVideoError(
          "Não foi possível conectar o vídeo. As notas continuam disponíveis.",
        ),
      );
    return () => {
      disposed = true;
      void frame?.destroy();
    };
  }, [room]);
  return (
    <>
      <div className="section-head">
        <h2>
          Conversas que viram decisões <span>{calls.length}</span>
        </h2>
        {editable && (
          <button type="button" className="primary" onClick={create}>
            <Plus size={16} />
            Agendar review
          </button>
        )}
      </div>
      {!calls.length ? (
        <Empty
          title="Vamos ouvir o cliente."
          body="Uma call de review reúne telas, feedback e decisões. Os ajustes viram tarefas do mesmo projeto."
        />
      ) : (
        <>
          <div className="call-selector">
            {calls.map((c) => (
              <button
                type="button"
                className={call?.id === c.id ? "active" : ""}
                key={c.id}
                onClick={() => {
                  setSelected(c.id);
                  setRoom(null);
                }}
              >
                <Video size={16} />
                {c.title}
                <Badge status={c.status} />
              </button>
            ))}
          </div>
          {call && (
            <div className="call-workspace">
              <section className="panel call-stage">
                <div className="section-head">
                  <h2>{call.title}</h2>
                  <Badge status={call.status} />
                </div>
                <p>{call.data.body}</p>
                {call.data.scheduledAt && (
                  <small>
                    Agendada para{" "}
                    {new Date(call.data.scheduledAt).toLocaleString("pt-BR")}
                  </small>
                )}
                <div className="video-container" ref={container}>
                  {!room && (
                    <div className="video-placeholder">
                      <Video size={36} />
                      <h3>A review acontece aqui.</h3>
                      <p>
                        Compartilhe a tela e revise o projeto com o cliente.
                        Você escolhe quando ligar câmera e microfone.
                      </p>
                      {call.status !== "closed" && (
                        <button
                          type="button"
                          disabled={busy}
                          className="primary"
                          onClick={() =>
                            perform(async () => {
                              setVideoError("");
                              setRoom(
                                await request(
                                  `/projects/${ws.project.id}/calls/${call.id}/join`,
                                  "POST",
                                  {},
                                ),
                              );
                            }, "Sala pronta.")
                          }
                        >
                          <Video size={16} />
                          Entrar na sala de review
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {videoError && (
                  <p role="alert" className="error">
                    {videoError}
                  </p>
                )}
                <div className="call-context">
                  <p className="eyebrow">TELAS DESTE PROJETO</p>
                  {ws.records
                    .filter((r) => r.kind === "screen")
                    .map((r) => (
                      <div key={r.id}>
                        <Folder size={15} />
                        <b>{r.title}</b>
                        <span>v{r.version}</span>
                      </div>
                    ))}
                  {!ws.records.some((r) => r.kind === "screen") && (
                    <p>
                      Adicione telas para relacionar cada feedback à
                      experiência.
                    </p>
                  )}
                </div>
                {room && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setRoom(null)}
                  >
                    Sair da sala
                  </button>
                )}
                {call.status === "closed" && (
                  <div className="call-summary">
                    <h3>Decisões da review</h3>
                    <p className="prose">
                      {call.data.summary || "Review encerrada sem observações."}
                    </p>
                  </div>
                )}
              </section>
              <section className="panel call-notes">
                <div className="section-head">
                  <h2>Feedback e decisões</h2>
                  <MessageSquare size={18} />
                </div>
                {call.status !== "closed" &&
                  ws.organization.role !== "reader" && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const form = e.currentTarget,
                          data = new FormData(form);
                        void perform(async () => {
                          await request(
                            `/projects/${ws.project.id}/calls/${call.id}/notes`,
                            "POST",
                            {
                              version: call.version,
                              body: data.get("body"),
                              category: data.get("category"),
                              screenId: data.get("screenId"),
                            },
                          );
                          form.reset();
                        }, "Observação registrada.");
                      }}
                    >
                      <Field label="Tipo de observação">
                        <select name="category">
                          <option value="change">Precisa mudar</option>
                          <option value="liked">Gostou</option>
                          <option value="question">Dúvida</option>
                          <option value="decision">Decisão</option>
                        </select>
                      </Field>
                      <Field label="Tela relacionada">
                        <select name="screenId">
                          <option value="">Sobre o projeto</option>
                          {ws.records
                            .filter((r) => r.kind === "screen")
                            .map((r) => (
                              <option value={r.id} key={r.id}>
                                {r.title}
                              </option>
                            ))}
                        </select>
                      </Field>
                      <Field label="O que o cliente disse?">
                        <textarea
                          name="body"
                          placeholder="Registre a observação com o contexto da conversa…"
                          required
                          maxLength={4000}
                        />
                      </Field>
                      <button type="submit" className="primary" disabled={busy}>
                        <Plus size={16} />
                        Registrar observação
                      </button>
                    </form>
                  )}
                <div className="note-list">
                  {call.data.notes.map((n) => (
                    <article key={n.id} className={`call-note ${n.category}`}>
                      <span className="eyebrow">
                        {
                          {
                            liked: "GOSTOU",
                            change: "AJUSTE",
                            question: "DÚVIDA",
                            decision: "DECISÃO",
                          }[n.category]
                        }
                      </span>
                      <p>{n.body}</p>
                      <small>
                        {n.screenId &&
                          `${ws.records.find((r) => r.id === n.screenId)?.title} · `}
                        {n.author}
                      </small>
                    </article>
                  ))}
                </div>
                {editable && call.status !== "closed" && (
                  <div className="close-call">
                    <p>
                      Ao encerrar, cada observação de ajuste vira uma tarefa
                      rastreável. As notas originais ficam no histórico.
                    </p>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        perform(async () => {
                          await request(
                            `/projects/${ws.project.id}/calls/${call.id}/close`,
                            "POST",
                            { version: call.version },
                          );
                          setRoom(null);
                        }, "Review encerrada e ajustes adicionados ao trabalho.")
                      }
                    >
                      <CheckCircle2 size={16} />
                      Encerrar e organizar ajustes
                    </button>
                  </div>
                )}
              </section>
            </div>
          )}
        </>
      )}
    </>
  );
}
function Settings({
  ws,
  perform,
  busy,
}: {
  ws: Workspace;
  perform: (fn: () => Promise<unknown>, m?: string) => Promise<void>;
  busy: boolean;
}) {
  const admin = ws.organization.role === "admin";
  return (
    <div className="settings-grid">
      <section className="panel">
        <p className="eyebrow">PESSOAS E RESPONSABILIDADES</p>
        <h2>Acesso à organização</h2>
        <p>
          Permissões valem para os projetos desta organização. Operadores
          direcionam o trabalho; clientes participam das revisões.
        </p>
        {admin ? (
          <>
            <div className="members">
              {ws.members.map((m) => (
                <div key={m.email}>
                  <span className="avatar small">
                    {m.email.slice(0, 2).toUpperCase()}
                  </span>
                  <b>{m.email}</b>
                  <small>{roleLabels[m.role]}</small>
                </div>
              ))}
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const form = e.currentTarget,
                  data = new FormData(form);
                void perform(async () => {
                  await request(
                    `/organizations/${ws.organization.id}/members`,
                    "POST",
                    { email: data.get("email"), role: data.get("role") },
                  );
                  form.reset();
                }, "Acesso atualizado.");
              }}
            >
              <Field label="E-mail da pessoa">
                <input
                  type="email"
                  name="email"
                  required
                  placeholder="pessoa@empresa.com"
                />
              </Field>
              <Field label="Papel">
                <select name="role">
                  <option value="operator">Operador</option>
                  <option value="client">Cliente</option>
                  <option value="reader">Leitor</option>
                  <option value="admin">Administrador da organização</option>
                </select>
              </Field>
              <button type="submit" className="primary" disabled={busy}>
                <Users size={16} />
                Atribuir acesso
              </button>
            </form>
          </>
        ) : (
          <div className="guardrail">
            <ShieldCheck />
            <span>
              A administração gerencia pessoas e papéis. Seu acesso:{" "}
              {roleLabels[ws.organization.role]}.
            </span>
          </div>
        )}
      </section>
      <section className="panel">
        <p className="eyebrow">CONEXÕES CONTROLADAS</p>
        <h2>Repositório do projeto</h2>
        <p>
          O Devin trabalha apenas no repositório vinculado pela administração
          técnica. O workspace não oferece terminal ou acesso ao banco.
        </p>
        {admin ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              void perform(
                () =>
                  request(`/projects/${ws.project.id}/repository`, "PUT", {
                    repository: data.get("repository"),
                  }),
                "Repositório atualizado.",
              );
            }}
          >
            <Field
              label="Repositório autorizado"
              hint="Formato organização/repositório, conforme o cadastro no Devin."
            >
              <input
                name="repository"
                defaultValue={ws.project.repository || ""}
                placeholder="organizacao/projeto"
                maxLength={200}
              />
            </Field>
            <button type="submit" className="primary" disabled={busy}>
              Salvar vínculo
            </button>
          </form>
        ) : (
          <p className="connection-help">
            {ws.project.repository
              ? "Repositório vinculado pela administração."
              : "Aguardando a administração vincular o repositório."}
          </p>
        )}
        <div className="guardrail">
          <ShieldCheck size={20} />
          <span>
            Credenciais e limites de provedor são configurados no servidor. Não
            são compartilhados com o navegador.
          </span>
        </div>
      </section>
      {canEdit(ws.organization.role) && (
        <section className="panel">
          <h2>Informações do projeto</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              void perform(
                () =>
                  request(`/projects/${ws.project.id}`, "PATCH", {
                    version: ws.project.version,
                    name: data.get("name"),
                    objective: data.get("objective"),
                    status: data.get("status"),
                  }),
                "Projeto atualizado.",
              );
            }}
          >
            <Field label="Nome">
              <input name="name" defaultValue={ws.project.name} required />
            </Field>
            <Field label="Objetivo">
              <textarea name="objective" defaultValue={ws.project.objective} />
            </Field>
            <Field label="Fase do projeto">
              <select name="status" defaultValue={ws.project.status}>
                {Object.entries(projectLabels).map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <button type="submit" className="primary" disabled={busy}>
              Salvar projeto
            </button>
          </form>
        </section>
      )}
    </div>
  );
}
