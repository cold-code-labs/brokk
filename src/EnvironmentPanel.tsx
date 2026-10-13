import { useEffect, useId, useState } from "react";
import type { Workspace } from "../shared/domain.ts";
import { canEdit } from "../shared/domain.ts";
import type { ProjectEnvironment } from "../shared/environment.ts";
import { request } from "./api.ts";

type Delivery = {
  number: number;
  url: string;
  title: string;
  head: string;
  ciState: string;
};
const labels: Record<string, string> = {
  configured: "Receita definida",
  preparing: "Preparando ambiente",
  waiting: "Aguardando validação",
  ready: "Preview saudável",
  uncertain: "Verificar preparação",
};
export function EnvironmentPanel({
  ws,
  perform,
  busy,
}: {
  ws: Workspace;
  perform: (fn: () => Promise<unknown>, message?: string) => Promise<void>;
  busy: boolean;
}) {
  const [value, setValue] = useState<{
    connected: boolean;
    environment: ProjectEnvironment | null;
  } | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [error, setError] = useState("");
  const [configuring, setConfiguring] = useState(false);
  const formId = useId(),
    editable = canEdit(ws.organization.role);
  useEffect(() => {
    let live = true;
    const update = async () => {
      try {
        const next = await request<typeof value>(
          `/projects/${ws.project.id}/environment`,
        );
        if (!live) return;
        if (
          next?.connected &&
          next.environment &&
          editable &&
          next.environment.state !== "preparing" &&
          next.environment.state !== "configured"
        ) {
          next.environment = await request(
            `/projects/${ws.project.id}/environment/refresh`,
            "POST",
            {},
          );
        }
        const rows =
          next?.connected && next.environment
            ? await request<Delivery[]>(
                `/projects/${ws.project.id}/environment/deliveries`,
              )
            : [];
        if (live) {
          setValue(next);
          setDeliveries(rows);
          setError("");
        }
      } catch (e) {
        if (live)
          setError(
            e instanceof Error
              ? e.message
              : "Não foi possível atualizar a preview.",
          );
      }
    };
    void update();
    const timer = setInterval(update, 10000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [ws.project.id, editable]);
  const env = value?.environment;
  async function action(path: string, body: unknown = {}) {
    const result = await request<ProjectEnvironment>(
      `/projects/${ws.project.id}/environment/${path}`,
      "POST",
      body,
    );
    if (path !== "integrate")
      setValue({ connected: true, environment: result });
  }
  return (
    <section className="panel preview-panel">
      <div className="section-head">
        <div>
          <p className="eyebrow">AMBIENTE DO PROJETO</p>
          <h2>Da ideia à preview.</h2>
        </div>
        <span className="connection">
          {env
            ? labels[env.state]
            : value?.connected
              ? "Pronto para preparar"
              : "Aguardando conexão"}
        </span>
      </div>
      <p>
        O Brokk prepara o ambiente de desenvolvimento e publica as entregas
        validadas para revisão.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {env && (
        <>
          <p>
            {env.detail || "Prepare o ambiente para começar a desenvolver."}
          </p>
          <div className="preview-checks">
            <span>
              Ambiente{" "}
              <b>
                {env.step === "configured"
                  ? "A preparar"
                  : env.state === "preparing"
                    ? "Preparando"
                    : "Vinculado"}
              </b>
            </span>
            <span>
              Backend de dev <b>{env.dataReady ? "Pronto" : "Preparando"}</b>
            </span>
            <span>
              Validação do código{" "}
              <b>
                {env.ciState === "success"
                  ? "Passou"
                  : env.ciState === "failure"
                    ? "Precisa de ajustes"
                    : "Aguardando"}
              </b>
            </span>
          </div>
          <div className="preview-actions">
            <a
              className="secondary"
              href={env.previewUrl}
              target="_blank"
              rel="noreferrer"
            >
              Abrir preview ↗
            </a>
            {editable && (
              <button
                type="button"
                className="secondary"
                disabled={busy || env.state === "preparing"}
                onClick={() =>
                  perform(() => action("refresh"), "Ambiente atualizado.")
                }
              >
                Verificar ambiente
              </button>
            )}
            {editable && (
              <button
                type="button"
                className="primary"
                disabled={
                  busy ||
                  env.state === "preparing" ||
                  env.ciState !== "success" ||
                  !env.dataReady
                }
                onClick={() =>
                  perform(
                    () => action("publish"),
                    "Publicação da preview solicitada.",
                  )
                }
              >
                Publicar preview validada
              </button>
            )}
          </div>
          {env.deployedCommit && (
            <p className="integration-help">
              Revisão publicada: <code>{env.deployedCommit.slice(0, 12)}</code>
            </p>
          )}
          {env.productionUrl && (
            <p className="integration-help">
              Destino de produção:{" "}
              <a href={env.productionUrl} target="_blank" rel="noreferrer">
                {env.productionUrl}
              </a>
            </p>
          )}
        </>
      )}
      {editable &&
        value?.connected &&
        (!env ||
          env.state === "configured" ||
          env.state === "uncertain" ||
          env.step === "data.waiting") && (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() =>
              perform(() => action("prepare"), "Preparação solicitada.")
            }
          >
            {env?.state === "uncertain"
              ? "Verificar preparação existente"
              : "Preparar preview"}
          </button>
        )}
      {ws.organization.role === "admin" && value?.connected && !env && (
        <>
          <button
            type="button"
            className="text-button"
            onClick={() => setConfiguring(!configuring)}
          >
            Definir receita para repositório existente
          </button>
          {configuring && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                void perform(async () => {
                  const recipe = await request<ProjectEnvironment>(
                    `/projects/${ws.project.id}/environment`,
                    "PUT",
                    {
                      slug: data.get("slug"),
                      hostname: data.get("hostname") || undefined,
                      productionUrl: data.get("productionUrl") || "",
                      profile: data.get("profile"),
                    },
                  );
                  setValue({ connected: true, environment: recipe });
                  setConfiguring(false);
                }, "Receita vinculada ao projeto.");
              }}
            >
              <label htmlFor={`${formId}slug`}>Identidade do ambiente</label>
              <input
                id={`${formId}slug`}
                name="slug"
                pattern="[a-z][a-z0-9-]{2,47}"
                maxLength={48}
                required
                placeholder="nfcs"
              />
              <label htmlFor={`${formId}host`}>
                Endereço de preview (opcional)
              </label>
              <input
                id={`${formId}host`}
                name="hostname"
                maxLength={200}
                placeholder="nfcs-preview.coldcodelabs.com"
              />
              <label htmlFor={`${formId}prod`}>
                Destino de produção (opcional)
              </label>
              <input
                id={`${formId}prod`}
                name="productionUrl"
                type="url"
                maxLength={200}
                placeholder="https://nfcs.coldcodelabs.com"
              />
              <label htmlFor={`${formId}profile`}>Tipo de projeto</label>
              <select id={`${formId}profile`} name="profile">
                <option value="static">Site público</option>
                <option value="application">Aplicação SPA com Hauldr</option>
              </select>
              <button type="submit" className="primary" disabled={busy}>
                Vincular receita
              </button>
            </form>
          )}
        </>
      )}
      {!!deliveries.length && (
        <div className="preview-deliveries">
          <h3>Entregas para integrar</h3>
          {deliveries.map((pr) => {
            const run = ws.records.find(
              (r) => r.kind === "run" && r.data.resultUrl === pr.url,
            );
            return (
              <div className="run-row" key={pr.number}>
                <span>
                  <a href={pr.url} target="_blank" rel="noreferrer">
                    <b>{pr.title}</b>
                  </a>
                  <small>
                    Validação:{" "}
                    {pr.ciState === "success" ? "passou" : pr.ciState}
                  </small>
                </span>
                {editable && run && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || pr.ciState !== "success"}
                    onClick={() =>
                      perform(
                        () =>
                          action("integrate", { runId: run.id, head: pr.head }),
                        "Entrega integrada à preview.",
                      )
                    }
                  >
                    Integrar entrega validada
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
