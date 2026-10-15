import type { Artifact } from "../shared/domain.ts";
export function ReviewProposals({
  call,
  editable,
  busy,
  decide,
}: {
  call: Artifact;
  editable: boolean;
  busy: boolean;
  decide: (id: string, input: Record<string, unknown>) => void;
}) {
  return (
    <section className="review-proposals">
      <h3>Alterações para confirmação</h3>
      <p>
        Confira a proposta e os critérios de aceite. Somente os itens
        confirmados entram nas tarefas; a execução é iniciada pela equipe no
        Desenvolvimento.
      </p>
      {!(call.data.reviewProposals || []).length && (
        <p>
          Nenhuma alteração proposta. As decisões e dúvidas permanecem no
          resumo.
        </p>
      )}
      {(call.data.reviewProposals || []).map((p) => (
        <article className="panel" key={p.id}>
          {p.status === "pending" && editable ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                const path = String(data.get("path") || "").trim();
                decide(p.id, {
                  decision: "accepted",
                  title: data.get("title"),
                  body: data.get("body"),
                  acceptance: data.get("acceptance"),
                  ...(path
                    ? {
                        codeReference: { path, line: Number(data.get("line")) },
                      }
                    : {}),
                });
              }}
            >
              <label>
                Título
                <input
                  name="title"
                  required
                  maxLength={200}
                  defaultValue={p.title}
                />
              </label>
              <label>
                Alteração proposta
                <textarea
                  name="body"
                  required
                  maxLength={4000}
                  defaultValue={p.body}
                />
              </label>
              <label>
                Como validar
                <textarea
                  name="acceptance"
                  required
                  maxLength={4000}
                  defaultValue={p.acceptance}
                />
              </label>
              <label>
                Arquivo indicado pela equipe (opcional)
                <input
                  name="path"
                  maxLength={300}
                  defaultValue={p.codeReference?.path || ""}
                  placeholder="src/Checkout.tsx"
                />
              </label>
              <label>
                Linha
                <input
                  name="line"
                  type="number"
                  min={1}
                  max={1000000}
                  defaultValue={p.codeReference?.line || 1}
                />
              </label>
              <div className="actions">
                <button type="submit" className="primary" disabled={busy}>
                  Confirmar e criar tarefa
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    decide(p.id, {
                      decision: "rejected",
                      title: p.title,
                      body: p.body,
                      acceptance: p.acceptance,
                    })
                  }
                >
                  Descartar proposta
                </button>
              </div>
            </form>
          ) : (
            <>
              <h4>{p.title}</h4>
              <p>{p.body}</p>
              <p>
                {p.status === "accepted"
                  ? "Confirmada · tarefa criada"
                  : p.status === "rejected"
                    ? "Descartada"
                    : "Aguardando confirmação da equipe"}
              </p>
              {p.codeReference?.path && (
                <p>
                  Referência indicada:{" "}
                  <code>
                    {p.codeReference.path}:{p.codeReference.line}
                  </code>
                </p>
              )}
            </>
          )}
          <details>
            <summary>Ver observações de origem</summary>
            {p.noteIds.map((id) => {
              const n = call.data.notes.find((n) => n.id === id);
              return n ? (
                <blockquote key={id}>
                  <p>{n.body}</p>
                  <small>
                    {n.author} · {new Date(n.at).toLocaleString("pt-BR")}
                  </small>
                </blockquote>
              ) : null;
            })}
          </details>
        </article>
      ))}
    </section>
  );
}
