import {
  CheckCircle2,
  Download,
  FileUp,
  GitBranch,
  Plus,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import type { CSSProperties, ReactElement, ReactNode } from "react";
import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type Binding,
  bindingTypes,
  type buildDesignContract,
  type ComponentSpec,
  canonicalJson,
  componentStyle,
  cssValue,
  type DesignManifest,
  type DesignSpec,
  designGraph,
  designSchema,
  designStates,
  layers,
  manifestSchema,
  previews,
  reference,
  type TokenSpec,
  type TokenValue,
  tokenTypes,
} from "../shared/design.ts";
import type { Artifact, Kind, Workspace } from "../shared/domain.ts";
import { emptyData } from "../shared/domain.ts";
import { nfcsManifest } from "../shared/examples/nfcs.ts";
import { request } from "./api.ts";
import "./design-system.css";
import "@fontsource/newsreader/400.css";
import "@fontsource/newsreader/500.css";
import "@fontsource/newsreader/600.css";
import "@fontsource/public-sans/400.css";
import "@fontsource/public-sans/500.css";
import "@fontsource/public-sans/600.css";
import "@fontsource/courier-prime/400.css";
import "@fontsource/courier-prime/700.css";

type Perform = (fn: () => Promise<unknown>, message?: string) => Promise<void>;
const typeLabels: Record<string, string> = {
  color: "Cor",
  dimension: "Dimensão",
  fontFamily: "Família tipográfica",
  fontWeight: "Peso tipográfico",
  number: "Número",
  duration: "Duração",
  cubicBezier: "Curva de movimento",
  shadow: "Sombra",
  typography: "Objeto tipográfico",
};
const layerLabels = {
  primitive: "Primitivo",
  semantic: "Semântico",
  component: "Componente",
};
const kindLabels = { token: "Token", component: "Componente", screen: "Tela" };
const sourceDefault = { url: "", path: "", note: "", capturedAt: "" };
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
    <label htmlFor={id} className="field">
      <span>{label}</span>
      {Children.map(children, (child) =>
        isValidElement(child) &&
        ["input", "select", "textarea"].includes(String(child.type))
          ? cloneElement(child as ReactElement<{ id?: string }>, { id })
          : child,
      )}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function useEditorIds<T>(values: T[]) {
  const previous = useRef<{ values: T[]; ids: string[] }>({
    values: [],
    ids: [],
  });
  if (previous.current.ids.length !== values.length) {
    const old = previous.current;
    previous.current = {
      values,
      ids: values.map((value) => {
        const at = old.values.indexOf(value);
        return at >= 0 ? old.ids[at] : crypto.randomUUID();
      }),
    };
  } else previous.current.values = values;
  return previous.current.ids;
}
function editorRows<T>(values: T[], ids: string[]) {
  return values.map((value, index) => ({ value, index, id: ids[index] }));
}
function effectiveBindings(
  component: ComponentSpec,
  variant: string,
  state: string,
) {
  const bindings = [
    ...component.bindings,
    ...(component.variants.find((v) => v.name === variant)?.bindings || []),
    ...(component.states.find((v) => v.name === state)?.bindings || []),
  ];
  return [...new Map(bindings.map((b) => [b.property, b])).values()];
}
function Dialog({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    id = useId();
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      className="ds-dialog"
      ref={ref}
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <div className="modal-header">
        <div>
          <p className="eyebrow">DESIGN SYSTEM</p>
          <h2 id={id}>{title}</h2>
        </div>
        <button
          className="icon-btn"
          type="button"
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
function defaultValue(type: TokenSpec["type"]): TokenValue {
  const values: Record<TokenSpec["type"], TokenValue> = {
    color: "#1b1d20",
    dimension: "16px",
    fontFamily: '"Public Sans", sans-serif',
    fontWeight: 400,
    number: 1,
    duration: "300ms",
    cubicBezier: "cubic-bezier(0.16, 1, 0.3, 1)",
    typography: {
      fontFamily: '"Public Sans", sans-serif',
      fontSize: "16px",
      fontWeight: 400,
      letterSpacing: "0px",
      lineHeight: 1.5,
    },
    shadow: [
      {
        color: "#00000026",
        offsetX: "0px",
        offsetY: "4px",
        blur: "12px",
        spread: "0px",
        inset: false,
      },
    ],
  };
  return values[type];
}
function freshSpec(
  kind: "token" | "component" | "screen",
  ws: Workspace,
): DesignSpec {
  if (kind === "token")
    return {
      kind,
      key: "color.brand.primary",
      type: "color",
      layer: "primitive",
      value: defaultValue("color"),
      source: sourceDefault,
    };
  if (kind === "screen")
    return {
      kind,
      key: "screen.new",
      components: [],
      accessibility: "",
      responsive: "",
      source: sourceDefault,
    };
  const token = ws.records.find(
    (x) => x.data.design?.kind === "token" && x.data.design.type === "color",
  )?.data.design;
  return {
    kind,
    key: "component.new",
    preview: "button",
    bindings: token ? [{ property: "color", token: token.key }] : [],
    variants: [],
    states: [],
    properties: [
      {
        name: "label",
        type: "text",
        options: [],
        defaultValue: "Exemplo",
        required: true,
      },
    ],
    children: [],
    accessibility: "",
    responsive: "",
    source: sourceDefault,
  };
}
function TokenInput({
  type,
  value,
  onChange,
  label,
  tokens,
}: {
  type: string;
  value: string | number;
  onChange: (value: string | number) => void;
  label: string;
  tokens: TokenSpec[];
}) {
  const id = useId();
  return (
    <Field
      label={label}
      hint={
        type === "dimension"
          ? "px ou rem; referências mantêm a ligação com outro token."
          : undefined
      }
    >
      <input
        value={String(value)}
        list={id}
        onChange={(e) =>
          onChange(
            ["number", "fontWeight"].includes(type) &&
              !e.target.value.startsWith("{")
              ? Number(e.target.value)
              : e.target.value,
          )
        }
        maxLength={500}
      />
      <datalist id={id}>
        {tokens
          .filter((t) => t.type === type)
          .map((t) => (
            <option key={t.key} value={`{${t.key}}`} />
          ))}
      </datalist>
    </Field>
  );
}
function BindingsEditor({
  label,
  bindings,
  onChange,
  tokens,
}: {
  label: string;
  bindings: Binding[];
  onChange: (b: Binding[]) => void;
  tokens: TokenSpec[];
}) {
  const ids = useEditorIds(bindings);
  return (
    <fieldset className="ds-fieldset">
      <legend>{label}</legend>
      {editorRows(bindings, ids).map(({ value: b, index: i, id }) => (
        <div className="ds-binding-row" key={id}>
          <Field label={`Propriedade ${label} ${i + 1}`}>
            <select
              value={b.property}
              onChange={(e) =>
                onChange(
                  bindings.map((x, j) =>
                    j === i
                      ? {
                          property: e.target.value as Binding["property"],
                          token: "",
                        }
                      : x,
                  ),
                )
              }
            >
              {Object.keys(bindingTypes).map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </Field>
          <Field label={`Token ${label} ${i + 1}`}>
            <select
              value={b.token}
              onChange={(e) =>
                onChange(
                  bindings.map((x, j) =>
                    j === i ? { ...x, token: e.target.value } : x,
                  ),
                )
              }
            >
              <option value="">
                Selecione {typeLabels[bindingTypes[b.property]]}
              </option>
              {tokens
                .filter((t) => t.type === bindingTypes[b.property])
                .map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.key}
                  </option>
                ))}
            </select>
          </Field>
          <button
            className="icon-btn"
            type="button"
            aria-label={`Remover propriedade ${label} ${i + 1}`}
            onClick={() => onChange(bindings.filter((_, j) => j !== i))}
          >
            <X size={16} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="text-link"
        onClick={() =>
          onChange([...bindings, { property: "color", token: "" }])
        }
      >
        <Plus size={14} />
        Vincular token
      </button>
    </fieldset>
  );
}
export function DesignEditor({
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
  perform: Perform;
}) {
  const record = editing.record;
  const [spec, setSpec] = useState<DesignSpec>(
    record?.data.design ||
      freshSpec(editing.kind as "token" | "component" | "screen", ws),
  );
  const [title, setTitle] = useState(record?.title || ""),
    [body, setBody] = useState(record?.data.body || ""),
    [acceptance, setAcceptance] = useState(record?.data.acceptance || ""),
    [error, setError] = useState("");
  const variantIds = useEditorIds(
      spec.kind === "component" ? spec.variants : [],
    ),
    stateIds = useEditorIds(spec.kind === "component" ? spec.states : []),
    propertyIds = useEditorIds(
      spec.kind === "component" ? spec.properties : [],
    ),
    shadowIds = useEditorIds(
      spec.kind === "token" && Array.isArray(spec.value) ? spec.value : [],
    );
  const tokens = ws.records
    .flatMap((r) => (r.data.design?.kind === "token" ? [r.data.design] : []))
    .filter((t) => t.key !== spec.key);
  const components = ws.records
    .flatMap((r) =>
      r.data.design?.kind === "component" ? [r.data.design] : [],
    )
    .filter((c) => c.key !== spec.key);
  const update = (patch: Partial<DesignSpec>) =>
    setSpec({ ...spec, ...patch } as DesignSpec);
  const tokenUpdate = (value: TokenValue) =>
    spec.kind === "token" && setSpec({ ...spec, value });
  return (
    <Dialog
      title={`${record ? "Editar" : "Novo"} ${kindLabels[spec.kind].toLowerCase()}`}
      close={close}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError("");
          const parsed = designSchema.safeParse(spec);
          if (!parsed.success) {
            setError(
              "Revise a chave, os tipos e os vínculos. Chaves usam segmentos separados por ponto, sem espaços.",
            );
            return;
          }
          const data = {
            ...(record?.data || emptyData()),
            body,
            acceptance,
            design: parsed.data,
          };
          const candidate: Artifact = {
            id: record?.id || crypto.randomUUID(),
            projectId: ws.project.id,
            kind: spec.kind,
            title: title || spec.key,
            status: "draft",
            data,
            version: record?.version || 1,
            author: "prévia",
            updatedAt: new Date().toISOString(),
          };
          const problems = designGraph([
            ...ws.records.filter((x) => x.id !== record?.id),
            candidate,
          ]).issues.filter((x) => x.severity === "error");
          if (problems.length) {
            setError(problems.map((x) => `${x.key}: ${x.message}`).join("\n"));
            return;
          }
          void perform(async () => {
            await request(
              `/projects/${ws.project.id}/records${record ? `/${record.id}` : ""}`,
              record ? "PATCH" : "POST",
              {
                ...(record ? { version: record.version } : { kind: spec.kind }),
                title: title || spec.key,
                status: "draft",
                data: { body, acceptance, design: parsed.data },
              },
            );
            close();
          }, "Especificação salva e vínculos recalculados.");
        }}
      >
        {error && (
          <p className="banner error prose" role="alert">
            {error}
          </p>
        )}
        <div className="two-fields">
          <Field label="Nome">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Nome legível do elemento"
              maxLength={200}
            />
          </Field>
          <Field
            label="Chave"
            hint="Identidade estável para referências. Ex.: color.surface.page"
          >
            <input
              value={spec.key}
              onChange={(e) => update({ key: e.target.value })}
              required
              maxLength={100}
            />
          </Field>
        </div>
        <Field label="Descrição e regra de uso">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={12000}
            rows={3}
          />
        </Field>
        {spec.kind === "token" && (
          <>
            <div className="two-fields">
              <Field label="Tipo">
                <select
                  value={spec.type}
                  onChange={(e) => {
                    const type = e.target.value as TokenSpec["type"];
                    setSpec({ ...spec, type, value: defaultValue(type) });
                  }}
                >
                  {tokenTypes.map((t) => (
                    <option value={t} key={t}>
                      {typeLabels[t]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Camada">
                <select
                  value={spec.layer}
                  onChange={(e) =>
                    setSpec({
                      ...spec,
                      layer: e.target.value as TokenSpec["layer"],
                    })
                  }
                >
                  {layers.map((l) => (
                    <option value={l} key={l}>
                      {layerLabels[l]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="ds-mode">
              <button
                type="button"
                className={!reference(spec.value) ? "selected" : ""}
                onClick={() => tokenUpdate(defaultValue(spec.type))}
              >
                Valor
              </button>
              <button
                type="button"
                className={reference(spec.value) ? "selected" : ""}
                onClick={() =>
                  setSpec({
                    ...spec,
                    layer: spec.layer === "primitive" ? "semantic" : spec.layer,
                    value: `{${tokens.find((t) => t.type === spec.type)?.key || "token.select"}}`,
                  })
                }
              >
                Referência a outro token
              </button>
            </div>
            {reference(spec.value) ? (
              <Field label="Token de origem">
                <select
                  value={reference(spec.value) || ""}
                  required
                  onChange={(e) => tokenUpdate(`{${e.target.value}}`)}
                >
                  <option value="">Selecione um token do mesmo tipo</option>
                  {tokens
                    .filter((t) => t.type === spec.type)
                    .map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.key}
                      </option>
                    ))}
                </select>
              </Field>
            ) : spec.type === "typography" &&
              typeof spec.value === "object" &&
              !Array.isArray(spec.value) ? (
              <div className="ds-composite">
                {Object.entries({
                  fontFamily: "fontFamily",
                  fontSize: "dimension",
                  fontWeight: "fontWeight",
                  letterSpacing: "dimension",
                  lineHeight: "number",
                }).map(([field, type]) => (
                  <TokenInput
                    key={field}
                    label={field}
                    type={type}
                    value={
                      (spec.value as Record<string, string | number>)[field]
                    }
                    tokens={tokens}
                    onChange={(value) =>
                      tokenUpdate({
                        ...(spec.value as Record<string, string | number>),
                        [field]: value,
                      } as TokenValue)
                    }
                  />
                ))}
              </div>
            ) : spec.type === "shadow" && Array.isArray(spec.value) ? (
              <>
                {editorRows(spec.value, shadowIds).map(
                  ({ value: s, index: i, id }) => (
                    <fieldset className="ds-fieldset" key={id}>
                      <legend>Sombra {i + 1}</legend>
                      <div className="ds-composite">
                        {["color", "offsetX", "offsetY", "blur", "spread"].map(
                          (field) => (
                            <TokenInput
                              key={field}
                              label={`${field} ${i + 1}`}
                              type={field === "color" ? "color" : "dimension"}
                              value={s[field as keyof Omit<typeof s, "inset">]}
                              tokens={tokens}
                              onChange={(value) =>
                                tokenUpdate(
                                  (spec.value as (typeof s)[]).map((x, j) =>
                                    j === i ? { ...x, [field]: value } : x,
                                  ),
                                )
                              }
                            />
                          ),
                        )}
                      </div>
                      <label className="ds-check">
                        <input
                          type="checkbox"
                          checked={s.inset}
                          onChange={(e) =>
                            tokenUpdate(
                              (spec.value as (typeof s)[]).map((x, j) =>
                                j === i ? { ...x, inset: e.target.checked } : x,
                              ),
                            )
                          }
                        />
                        Sombra interna
                      </label>
                      {(spec.value as (typeof s)[]).length > 1 && (
                        <button
                          type="button"
                          className="text-link"
                          onClick={() =>
                            tokenUpdate(
                              (spec.value as (typeof s)[]).filter(
                                (_, j) => j !== i,
                              ),
                            )
                          }
                        >
                          Remover camada
                        </button>
                      )}
                    </fieldset>
                  ),
                )}
                <button
                  className="secondary"
                  type="button"
                  disabled={spec.value.length >= 4}
                  onClick={() =>
                    tokenUpdate([
                      ...(spec.value as Extract<TokenValue, unknown[]>),
                      ...(defaultValue("shadow") as Extract<
                        TokenValue,
                        unknown[]
                      >),
                    ])
                  }
                >
                  Adicionar camada de sombra
                </button>
              </>
            ) : (
              <TokenInput
                label="Valor"
                type={spec.type}
                value={spec.value as string | number}
                onChange={tokenUpdate}
                tokens={tokens}
              />
            )}
          </>
        )}
        {spec.kind === "component" && (
          <>
            <Field label="Tipo de prévia">
              <select
                value={spec.preview}
                onChange={(e) =>
                  setSpec({
                    ...spec,
                    preview: e.target.value as ComponentSpec["preview"],
                  })
                }
              >
                {previews.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </Field>
            <BindingsEditor
              label="Base"
              tokens={tokens}
              bindings={spec.bindings}
              onChange={(bindings) => setSpec({ ...spec, bindings })}
            />
            <h3>Variantes</h3>
            {editorRows(spec.variants, variantIds).map(
              ({ value: v, index: i, id }) => (
                <div className="ds-option" key={id}>
                  <Field label={`Nome da variante ${i + 1}`}>
                    <input
                      value={v.name}
                      onChange={(e) =>
                        setSpec({
                          ...spec,
                          variants: spec.variants.map((x, j) =>
                            j === i ? { ...x, name: e.target.value } : x,
                          ),
                        })
                      }
                      maxLength={40}
                    />
                  </Field>
                  <BindingsEditor
                    label={`Variante ${i + 1}`}
                    tokens={tokens}
                    bindings={v.bindings}
                    onChange={(bindings) =>
                      setSpec({
                        ...spec,
                        variants: spec.variants.map((x, j) =>
                          j === i ? { ...x, bindings } : x,
                        ),
                      })
                    }
                  />
                  <button
                    type="button"
                    className="text-link"
                    onClick={() =>
                      setSpec({
                        ...spec,
                        variants: spec.variants.filter((_, j) => j !== i),
                      })
                    }
                  >
                    Remover variante
                  </button>
                </div>
              ),
            )}
            <button
              type="button"
              className="secondary"
              onClick={() =>
                setSpec({
                  ...spec,
                  variants: [
                    ...spec.variants,
                    {
                      name: `variant${spec.variants.length + 1}`,
                      bindings: [],
                    },
                  ],
                })
              }
            >
              Adicionar variante
            </button>
            <h3 className="ds-editor-heading">Estados</h3>
            {editorRows(spec.states, stateIds).map(
              ({ value: v, index: i, id }) => (
                <div className="ds-option" key={id}>
                  <Field label={`Estado ${i + 1}`}>
                    <select
                      value={v.name}
                      onChange={(e) =>
                        setSpec({
                          ...spec,
                          states: spec.states.map((x, j) =>
                            j === i
                              ? { ...x, name: e.target.value as typeof v.name }
                              : x,
                          ),
                        })
                      }
                    >
                      {designStates.map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </Field>
                  <BindingsEditor
                    label={`Estado ${i + 1}`}
                    tokens={tokens}
                    bindings={v.bindings}
                    onChange={(bindings) =>
                      setSpec({
                        ...spec,
                        states: spec.states.map((x, j) =>
                          j === i ? { ...x, bindings } : x,
                        ),
                      })
                    }
                  />
                  <button
                    type="button"
                    className="text-link"
                    onClick={() =>
                      setSpec({
                        ...spec,
                        states: spec.states.filter((_, j) => j !== i),
                      })
                    }
                  >
                    Remover estado
                  </button>
                </div>
              ),
            )}
            <button
              type="button"
              className="secondary"
              disabled={spec.states.length >= 6}
              onClick={() =>
                setSpec({
                  ...spec,
                  states: [
                    ...spec.states,
                    {
                      name:
                        designStates.find(
                          (s) => !spec.states.some((x) => x.name === s),
                        ) || "hover",
                      bindings: [],
                    },
                  ],
                })
              }
            >
              Adicionar estado
            </button>
            <h3 className="ds-editor-heading">Propriedades do objeto</h3>
            {editorRows(spec.properties, propertyIds).map(
              ({ value: p, index: i, id }) => (
                <div className="ds-option" key={id}>
                  <div className="two-fields">
                    <Field label={`Nome da propriedade ${i + 1}`}>
                      <input
                        value={p.name}
                        onChange={(e) =>
                          setSpec({
                            ...spec,
                            properties: spec.properties.map((x, j) =>
                              j === i ? { ...x, name: e.target.value } : x,
                            ),
                          })
                        }
                      />
                    </Field>
                    <Field label={`Tipo da propriedade ${i + 1}`}>
                      <select
                        value={p.type}
                        onChange={(e) =>
                          setSpec({
                            ...spec,
                            properties: spec.properties.map((x, j) =>
                              j === i
                                ? {
                                    ...x,
                                    type: e.target.value as typeof p.type,
                                    defaultValue:
                                      e.target.value === "boolean"
                                        ? x.defaultValue === true ||
                                          x.defaultValue === "true"
                                        : String(x.defaultValue),
                                  }
                                : x,
                            ),
                          })
                        }
                      >
                        <option value="text">Texto</option>
                        <option value="boolean">Sim / não</option>
                        <option value="enum">Escolha</option>
                      </select>
                    </Field>
                  </div>
                  {p.type === "enum" && (
                    <Field label={`Opções ${i + 1}`}>
                      <input
                        value={p.options.join(", ")}
                        onChange={(e) =>
                          setSpec({
                            ...spec,
                            properties: spec.properties.map((x, j) =>
                              j === i
                                ? {
                                    ...x,
                                    options: e.target.value
                                      .split(",")
                                      .map((s) => s.trim())
                                      .filter(Boolean),
                                  }
                                : x,
                            ),
                          })
                        }
                      />
                    </Field>
                  )}
                  <Field label={`Valor padrão ${i + 1}`}>
                    {p.type === "boolean" ? (
                      <select
                        value={String(p.defaultValue)}
                        onChange={(e) =>
                          setSpec({
                            ...spec,
                            properties: spec.properties.map((x, j) =>
                              j === i
                                ? {
                                    ...x,
                                    defaultValue: e.target.value === "true",
                                  }
                                : x,
                            ),
                          })
                        }
                      >
                        <option value="false">Não</option>
                        <option value="true">Sim</option>
                      </select>
                    ) : (
                      <input
                        value={String(p.defaultValue)}
                        onChange={(e) =>
                          setSpec({
                            ...spec,
                            properties: spec.properties.map((x, j) =>
                              j === i
                                ? { ...x, defaultValue: e.target.value }
                                : x,
                            ),
                          })
                        }
                      />
                    )}
                  </Field>
                  <label className="ds-check">
                    <input
                      type="checkbox"
                      checked={p.required}
                      onChange={(e) =>
                        setSpec({
                          ...spec,
                          properties: spec.properties.map((x, j) =>
                            j === i ? { ...x, required: e.target.checked } : x,
                          ),
                        })
                      }
                    />
                    Obrigatória
                  </label>
                  <button
                    className="text-link"
                    type="button"
                    onClick={() =>
                      setSpec({
                        ...spec,
                        properties: spec.properties.filter((_, j) => j !== i),
                      })
                    }
                  >
                    Remover propriedade
                  </button>
                </div>
              ),
            )}
            <button
              className="secondary"
              type="button"
              onClick={() =>
                setSpec({
                  ...spec,
                  properties: [
                    ...spec.properties,
                    {
                      name: `property${spec.properties.length + 1}`,
                      type: "text",
                      options: [],
                      defaultValue: "",
                      required: false,
                    },
                  ],
                })
              }
            >
              Adicionar propriedade
            </button>
          </>
        )}
        {(spec.kind === "component" || spec.kind === "screen") && (
          <>
            <fieldset className="ds-fieldset">
              <legend>
                {spec.kind === "screen"
                  ? "Elementos desta tela"
                  : "Composição: outros componentes"}
              </legend>
              {components.map((c) => (
                <label key={c.key} className="ds-check">
                  <input
                    type="checkbox"
                    checked={(spec.kind === "screen"
                      ? spec.components
                      : spec.children
                    ).includes(c.key)}
                    onChange={(e) => {
                      const selected =
                        spec.kind === "screen"
                          ? spec.components
                          : spec.children;
                      const values = e.target.checked
                        ? [...selected, c.key]
                        : selected.filter((x) => x !== c.key);
                      setSpec(
                        spec.kind === "screen"
                          ? { ...spec, components: values }
                          : { ...spec, children: values },
                      );
                    }}
                  />
                  {c.key}
                </label>
              ))}
              {!components.length && (
                <p>Cadastre componentes antes de compor a tela.</p>
              )}
            </fieldset>
            <Field label="Acessibilidade e interação">
              <textarea
                value={spec.accessibility}
                onChange={(e) => update({ accessibility: e.target.value })}
                rows={3}
                maxLength={2000}
              />
            </Field>
            <Field label="Comportamento responsivo">
              <textarea
                value={spec.responsive}
                onChange={(e) => update({ responsive: e.target.value })}
                rows={3}
                maxLength={2000}
              />
            </Field>
            <Field label="Critérios de aceite">
              <textarea
                value={acceptance}
                onChange={(e) => setAcceptance(e.target.value)}
                maxLength={12000}
                rows={3}
              />
            </Field>
          </>
        )}
        <details className="ds-source-editor">
          <summary>Origem e evidência</summary>
          <Field label="URL de referência">
            <input
              type="url"
              value={spec.source.url}
              onChange={(e) =>
                update({ source: { ...spec.source, url: e.target.value } })
              }
              placeholder="https://"
              maxLength={1000}
            />
          </Field>
          <Field label="Origem no projeto">
            <input
              value={spec.source.path}
              onChange={(e) =>
                update({ source: { ...spec.source, path: e.target.value } })
              }
              maxLength={300}
            />
          </Field>
          <Field label="Nota de evidência">
            <textarea
              value={spec.source.note}
              onChange={(e) =>
                update({ source: { ...spec.source, note: e.target.value } })
              }
              maxLength={2000}
              rows={3}
            />
          </Field>
        </details>
        <div className="form-actions">
          <button type="button" className="secondary" onClick={close}>
            Cancelar
          </button>
          <button type="submit" className="primary" disabled={busy}>
            Salvar especificação
          </button>
        </div>
      </form>
    </Dialog>
  );
}
function Preview({
  component,
  resolved,
  variant,
  state,
  label,
}: {
  component: ComponentSpec;
  resolved: Record<string, TokenValue>;
  variant: string;
  state: string;
  label: string;
}) {
  const [choice, setChoice] = useState(0);
  const radioName = useId();
  const style = componentStyle(
    component,
    resolved,
    variant,
    state,
  ) as CSSProperties;
  if (state === "focus") style.outlineStyle = "solid";
  const common = {
    style,
    "data-component": component.key,
    "data-variant": variant || undefined,
    "data-state": state || undefined,
  };
  if (component.preview === "button")
    return (
      <button
        type="button"
        className="ds-example-button"
        disabled={state === "disabled"}
        {...common}
      >
        {label}
        <span aria-hidden="true"> →</span>
      </button>
    );
  if (component.preview === "text" || component.preview === "badge")
    return (
      <span className={`ds-example-${component.preview}`} {...common}>
        {label}
      </span>
    );
  if (component.preview === "choice")
    return (
      <fieldset className="ds-example-choices">
        <legend>Prévia de seleção</legend>
        {[label, "Outra situação"].map((name, i) => (
          <label
            key={name}
            style={
              componentStyle(
                component,
                resolved,
                variant,
                choice === i ? "selected" : state === "selected" ? "" : state,
              ) as CSSProperties
            }
          >
            <input
              type="radio"
              name={radioName}
              checked={choice === i}
              onChange={() => setChoice(i)}
            />
            0{i + 1} · {name}
          </label>
        ))}
      </fieldset>
    );
  if (component.preview === "input")
    return (
      <input
        aria-label="Campo de demonstração"
        placeholder={label}
        disabled={state === "disabled"}
        {...common}
      />
    );
  if (component.preview === "navigation")
    return (
      <nav
        aria-label="Prévia de navegação"
        className="ds-example-navigation"
        {...common}
      >
        <b>
          {component.properties.find((p) => p.name === "brand")?.defaultValue ||
            "Marca"}
        </b>
        <span>{label}</span>
      </nav>
    );
  if (component.preview === "list")
    return (
      <ol className="ds-example-list" {...common}>
        <li>{label}</li>
        <li>Próximo elemento da composição</li>
      </ol>
    );
  if (component.preview === "media")
    return (
      <div className="ds-example-media" {...common}>
        <span>{label}</span>
        <small>Asset referenciado · mídia não executada na prévia</small>
      </div>
    );
  return (
    <div className={`ds-example-${component.preview}`} {...common}>
      <b>{label}</b>
      <p>Objeto composto a partir dos tokens vinculados.</p>
    </div>
  );
}
function ImportDialog({
  ws,
  close,
  perform,
  busy,
}: {
  ws: Workspace;
  close: () => void;
  perform: Perform;
  busy: boolean;
}) {
  const [manifest, setManifest] = useState<DesignManifest | null>(null),
    [error, setError] = useState("");
  const preview = useMemo(
    () =>
      manifest
        ? designGraph([
            ...ws.records,
            ...manifest.items
              .filter((x) => {
                const old = ws.records.find(
                  (r) => r.data.design?.key === x.design.key,
                );
                return (
                  !old ||
                  old.title !== x.title ||
                  old.data.body !== x.body ||
                  old.data.acceptance !== x.acceptance ||
                  canonicalJson(designSchema.parse(old.data.design)) !==
                    canonicalJson(designSchema.parse(x.design))
                );
              })
              .map((x, i) => ({
                id: `import-${i}`,
                projectId: ws.project.id,
                kind: x.design.kind,
                title: x.title,
                status: "draft",
                version: 1,
                author: "prévia",
                updatedAt: "",
                data: {
                  ...emptyData(),
                  body: x.body,
                  acceptance: x.acceptance,
                  design: x.design,
                },
              })),
          ])
        : null,
    [manifest, ws],
  );
  return (
    <Dialog title="Importar design system" close={close}>
      <p>
        O arquivo contém decisões de design, vínculos e metadados. A importação
        é validada como um conjunto e não executa código.
      </p>
      <Field label="Arquivo de contrato Brokk (.json)">
        <input
          type="file"
          accept="application/json,.json"
          onChange={async (e) => {
            setError("");
            const file = e.target.files?.[0];
            if (!file) return;
            if (file.size > 95000) {
              setError("Use um arquivo de até 95 KB.");
              return;
            }
            try {
              setManifest(manifestSchema.parse(JSON.parse(await file.text())));
            } catch {
              setError(
                "Arquivo inválido. Use o manifesto brokk.design-system/1 exportado pelo Brokk.",
              );
              setManifest(null);
            }
          }}
        />
      </Field>
      <button
        type="button"
        className="secondary"
        onClick={() => {
          setManifest(nfcsManifest);
          setError("");
        }}
      >
        Usar referência NFCS · Aurora
      </button>
      {manifest && (
        <div className="ds-import-summary">
          <p className="eyebrow">{manifest.name}</p>
          <h3>{manifest.items.length} especificações</h3>
          <p>
            {preview?.tokens.size} tokens · {preview?.components.size}{" "}
            componentes ·{" "}
            {manifest.items.filter((x) => x.design.kind === "screen").length}{" "}
            telas
          </p>
          <a
            href={manifest.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="text-link"
          >
            Abrir referência
          </a>
          <p>
            Registros existentes com a mesma chave são preservados. Uma
            importação diferente exige resolver o conflito.
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="banner error">
          {error}
        </p>
      )}
      {preview?.issues
        .filter((x) => x.severity === "error")
        .map((x) => (
          <p key={`${x.key}-${x.code}-${x.message}`} className="banner error">
            {x.key}: {x.message}
          </p>
        ))}
      <div className="form-actions">
        <button type="button" className="secondary" onClick={close}>
          Cancelar
        </button>
        <button
          type="button"
          className="primary"
          disabled={
            !manifest ||
            busy ||
            !!preview?.issues.some((x) => x.severity === "error")
          }
          onClick={() =>
            void perform(async () => {
              const r = await request<{ imported: number; existing: number }>(
                `/projects/${ws.project.id}/design/import`,
                "POST",
                manifest,
              );
              close();
              return r;
            }, "Design system importado e validado.")
          }
        >
          Importar especificações
        </button>
      </div>
    </Dialog>
  );
}
export function DesignSystem({
  ws,
  editable,
  perform,
  busy,
}: {
  ws: Workspace;
  editable: boolean;
  perform: Perform;
  busy: boolean;
}) {
  const graph = useMemo(() => designGraph(ws.records), [ws.records]);
  const [section, setSection] = useState("tokens"),
    [selected, setSelected] = useState(""),
    [query, setQuery] = useState(""),
    [editing, setEditing] = useState<{ kind: Kind; record?: Artifact } | null>(
      null,
    ),
    [importing, setImporting] = useState(false),
    [variant, setVariant] = useState(""),
    [state, setState] = useState(""),
    [label, setLabel] = useState(""),
    [report, setReport] = useState<
      (ReturnType<typeof buildDesignContract> & { checksum: string }) | null
    >(null),
    [reportError, setReportError] = useState("");
  const signature = ws.records
    .map((x) => `${x.id}:${x.version}:${x.status}`)
    .join("|");
  useEffect(() => {
    let live = true;
    setReportError("");
    request<ReturnType<typeof buildDesignContract> & { checksum: string }>(
      `/projects/${ws.project.id}/design`,
    )
      .then((x) => {
        if (live) {
          const same = x.versions.every((v) =>
            signature.split("|").includes(`${v.id}:${v.version}:${v.status}`),
          );
          if (same) setReport(x);
          else {
            setReport(null);
            setReportError(
              "O conjunto mudou durante a validação. Atualize ou valide novamente.",
            );
          }
        }
      })
      .catch((e) => {
        if (live) {
          setReport(null);
          setReportError(e.message);
        }
      });
    return () => {
      live = false;
    };
  }, [ws.project.id, signature]);
  const records = graph.entries.filter(
    (x) =>
      (section === "tokens"
        ? x.spec.kind === "token"
        : section === "components"
          ? x.spec.kind === "component"
          : x.spec.kind === "screen") &&
      `${x.record.title} ${x.spec.key}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const active = records.find((x) => x.spec.key === selected) || records[0];
  const choose = (key: string) => {
    setSelected(key);
    setQuery("");
    setVariant("");
    setState("");
    setLabel("");
  };
  const component = active?.spec.kind === "component" ? active.spec : null;
  const currentLabel = String(
    label ||
      component?.properties.find((p) => p.name === "label")?.defaultValue ||
      active?.record.title ||
      "Exemplo",
  );
  const validate = () =>
    void perform(
      async () => setReport(await request(`/projects/${ws.project.id}/design`)),
      "Conjunto validado no servidor.",
    );
  return (
    <div className="ds-workspace">
      <div className="ds-toolbar">
        <div>
          <p className="eyebrow">BIBLIOTECA DO PROJETO</p>
          <h2>Decisões conectadas.</h2>
          <p>Primitivos → semântica → componentes → telas.</p>
        </div>
        <div className="ds-actions">
          {editable && (
            <>
              <button
                type="button"
                className="secondary"
                onClick={() => setImporting(true)}
              >
                <FileUp size={15} />
                Importar
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => setEditing({ kind: "component" })}
              >
                <Plus size={15} />
                Componente
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => setEditing({ kind: "token" })}
              >
                <Plus size={15} />
                Token
              </button>
            </>
          )}
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={validate}
          >
            <ShieldCheck size={15} />
            Validar conjunto
          </button>
        </div>
      </div>
      <div className="ds-health">
        <span className={graph.valid ? "ds-valid" : "ds-pending"}>
          <CheckCircle2 size={16} />
          {graph.valid ? "Estrutura válida" : "Estrutura em construção"}
        </span>
        <span>{graph.tokens.size} tokens</span>
        <span>{graph.components.size} componentes</span>
        <span>
          {graph.entries.filter((x) => x.spec.kind === "screen").length} telas
        </span>
        <span>{report?.validation.counts.bindings || 0} vínculos</span>
      </div>
      <div className="ds-sections" role="tablist" aria-label="Design system">
        {[
          ["tokens", "Tokens"],
          ["components", "Componentes"],
          ["screens", "Telas e composição"],
          ["validation", "Validação"],
          ["contract", "Contrato de desenvolvimento"],
        ].map(([id, name]) => (
          <button
            type="button"
            role="tab"
            aria-selected={section === id}
            key={id}
            onClick={() => {
              setSection(id);
              setSelected("");
              setQuery("");
              setVariant("");
              setState("");
              setLabel("");
            }}
          >
            {name}
          </button>
        ))}
      </div>
      {reportError && (
        <p role="alert" className="banner error">
          {reportError}
        </p>
      )}
      {section === "validation" ? (
        <div className="ds-validation">
          <section className="panel">
            <h3>Validação do contrato</h3>
            <p>
              Tipos, aliases, ciclos, vínculos, composição, consistência de
              nomes e contraste das combinações declaradas. Aprovação editorial
              e testes da tela final continuam separados.
            </p>
            <div className="ds-check-grid">
              {[
                "Tipos e valores",
                "Referências de tokens",
                "Ciclos de aliases",
                "Vínculos e composição",
                "Contraste por variante e estado",
                "Exportação reproduzível",
              ].map((x) => (
                <div key={x}>
                  <ShieldCheck size={16} />
                  {x}
                </div>
              ))}
            </div>
            <h3>
              {graph.issues.filter((x) => x.severity === "error").length} erros
              · {graph.issues.filter((x) => x.severity === "warning").length}{" "}
              observações
            </h3>
            {graph.issues.length ? (
              graph.issues.map((x) => (
                <div
                  className={`ds-issue ${x.severity}`}
                  key={`${x.key}-${x.code}-${x.message}`}
                >
                  <b>{x.key}</b>
                  <p>{x.message}</p>
                </div>
              ))
            ) : (
              <p className="success ds-issue">
                O conjunto declarado passou nas verificações.
              </p>
            )}
          </section>
          <section className="panel">
            <h3>Contraste de texto</h3>
            <p>
              {graph.contrast.length} combinações com foreground e background
              explícitos. Cores translúcidas, imagens e foco da tela final
              precisam de verificação no contexto da página.
            </p>
            <div className="ds-table-wrap">
              <table className="ds-table">
                <thead>
                  <tr>
                    <th>Componente</th>
                    <th>Variante / estado</th>
                    <th>Contraste</th>
                    <th>Resultado</th>
                  </tr>
                </thead>
                <tbody>
                  {graph.contrast.map((x) => (
                    <tr
                      key={`${x.component}-${x.variant}-${x.state}`}
                      className={!x.pass ? "ds-failed" : undefined}
                    >
                      <td>{x.component}</td>
                      <td>
                        {x.variant} / {x.state}
                      </td>
                      <td>{x.ratio}:1</td>
                      <td>
                        {x.pass ? "Passou" : "Revisar"} · ≥ {x.minimum}:1
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      ) : section === "contract" ? (
        <section className="panel">
          <p className="eyebrow">CONTRATO VERSIONADO · V1</p>
          <h3>O mesmo padrão para quem desenha e quem desenvolve.</h3>
          <p>
            Tokens de intercâmbio, CSS com aliases preservados, objetos,
            propriedades, variantes, estados e mapa das telas. O contexto do
            Devin recebe este contrato, sem iniciar execução ao exportar.
          </p>
          {report && (
            <>
              <div className="ds-contract-meta">
                <span>Revisão</span>
                <code>{report.checksum}</code>
                <span>Especificações</span>
                <b>{report.versions.length}</b>
              </div>
              <div className="ds-actions">
                {[
                  ["contract", "Contrato completo"],
                  ["tokens", "Tokens DTCG"],
                  ["css", "CSS"],
                  ["manifest", "Manifesto para reimportar"],
                ].map(([format, title]) => (
                  <a
                    key={format}
                    className="secondary"
                    href={`/api/projects/${ws.project.id}/design/export?format=${format}`}
                    download
                    aria-disabled={!report.validation.valid}
                    onClick={(e) => {
                      if (!report.validation.valid) e.preventDefault();
                    }}
                  >
                    <Download size={15} />
                    {title}
                  </a>
                ))}
              </div>
              <p className="ds-footnote">
                DTCG 2025.10 para os tipos suportados; componentes e telas
                seguem brokk.design-system/1. Os exports mantêm a origem e a
                versão de cada especificação.
              </p>
              <details>
                <summary>Ver CSS gerado</summary>
                <pre className="ds-code">{report.css}</pre>
              </details>
              <details>
                <summary>Ver objetos e relações</summary>
                <pre className="ds-code">
                  {JSON.stringify(
                    {
                      components: report.components,
                      screens: report.screens,
                      versions: report.versions,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </>
          )}
        </section>
      ) : !graph.entries.length ? (
        <section className="ds-empty">
          <GitBranch size={34} />
          <h3>Um sistema começa pelas relações.</h3>
          <p>
            Cadastre decisões tipadas ou importe a referência NFCS. Cada valor
            fica ligado aos elementos que o utilizam.
          </p>
          {editable && (
            <button
              className="primary"
              type="button"
              onClick={() => setImporting(true)}
            >
              <FileUp size={16} />
              Importar design system
            </button>
          )}
        </section>
      ) : (
        <div className="ds-library">
          <aside className="ds-catalog">
            <label className="search">
              <Search size={14} />
              <input
                aria-label="Buscar no design system"
                placeholder="Buscar chave ou nome"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            {records.map((x) => (
              <button
                type="button"
                key={x.record.id}
                aria-pressed={active?.spec.key === x.spec.key}
                className={active?.spec.key === x.spec.key ? "selected" : ""}
                onClick={() => choose(x.spec.key)}
              >
                {x.spec.kind === "token" &&
                  x.spec.type === "color" &&
                  typeof graph.resolved[x.spec.key] === "string" && (
                    <i
                      style={{
                        backgroundColor: graph.resolved[x.spec.key] as string,
                      }}
                    />
                  )}
                <span>
                  <b>{x.record.title}</b>
                  <small>{x.spec.key}</small>
                </span>
                <small>v{x.record.version}</small>
              </button>
            ))}
            {!records.length && (
              <p className="ds-footnote">Nenhum item nesta seção.</p>
            )}
          </aside>
          {active && (
            <article className="ds-inspector">
              <div className="section-head">
                <div>
                  <p className="eyebrow">
                    {kindLabels[active.spec.kind]} · V{active.record.version}
                  </p>
                  <h3>{active.record.title}</h3>
                  <code>{active.spec.key}</code>
                </div>
                {editable && (
                  <button
                    className="secondary"
                    type="button"
                    onClick={() =>
                      setEditing({
                        kind: active.spec.kind,
                        record: active.record,
                      })
                    }
                  >
                    Editar
                  </button>
                )}
              </div>
              <p>{active.record.data.body}</p>
              {active.spec.kind === "token" && (
                <>
                  <div className="ds-token-specimen">
                    {active.spec.type === "color" ? (
                      <span
                        className="ds-color-swatch"
                        style={{
                          backgroundColor: graph.resolved[
                            active.spec.key
                          ] as string,
                        }}
                      />
                    ) : active.spec.type === "typography" ? (
                      <span
                        style={graph.resolved[active.spec.key] as CSSProperties}
                      >
                        Aa · Decisões que guiam o projeto.
                      </span>
                    ) : active.spec.type === "fontFamily" ? (
                      <span
                        style={{
                          fontFamily: graph.resolved[active.spec.key] as string,
                        }}
                      >
                        Aa · 0123456789
                      </span>
                    ) : active.spec.type === "shadow" ? (
                      <span
                        className="ds-shadow-swatch"
                        style={{
                          boxShadow: cssValue(
                            "shadow",
                            graph.resolved[active.spec.key],
                          ),
                        }}
                      >
                        Objeto
                      </span>
                    ) : (
                      <strong>
                        {String(
                          graph.resolved[active.spec.key] ?? "Não resolvido",
                        )}
                      </strong>
                    )}
                  </div>
                  <dl className="ds-facts">
                    <div>
                      <dt>Tipo</dt>
                      <dd>{typeLabels[active.spec.type]}</dd>
                    </div>
                    <div>
                      <dt>Camada</dt>
                      <dd>{layerLabels[active.spec.layer]}</dd>
                    </div>
                    <div>
                      <dt>Valor / objeto</dt>
                      <dd>
                        <code>
                          {typeof active.spec.value === "object"
                            ? JSON.stringify(active.spec.value, null, 2)
                            : String(active.spec.value)}
                        </code>
                      </dd>
                    </div>
                    <div>
                      <dt>Valor resolvido</dt>
                      <dd>
                        <code>
                          {typeof graph.resolved[active.spec.key] === "object"
                            ? JSON.stringify(
                                graph.resolved[active.spec.key],
                                null,
                                2,
                              )
                            : String(
                                graph.resolved[active.spec.key] ??
                                  "Não resolvido",
                              )}
                        </code>
                      </dd>
                    </div>
                  </dl>
                </>
              )}
              {component && (
                <>
                  <div className="ds-preview-controls">
                    <Field label="Variante">
                      <select
                        value={variant}
                        onChange={(e) => setVariant(e.target.value)}
                      >
                        <option value="">Padrão</option>
                        {component.variants.map((v) => (
                          <option key={v.name}>{v.name}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Estado">
                      <select
                        value={state}
                        onChange={(e) => setState(e.target.value)}
                      >
                        <option value="">Padrão</option>
                        {component.states.map((v) => (
                          <option key={v.name}>{v.name}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Texto de exemplo">
                      <input
                        value={currentLabel}
                        onChange={(e) => setLabel(e.target.value)}
                        maxLength={300}
                      />
                    </Field>
                  </div>
                  <div
                    className="ds-preview-stage"
                    data-design-system={ws.project.id}
                    style={{
                      backgroundColor:
                        typeof graph.resolved["color.surface.page"] === "string"
                          ? (graph.resolved["color.surface.page"] as string)
                          : undefined,
                    }}
                  >
                    <Preview
                      key={component.key}
                      component={component}
                      resolved={graph.resolved}
                      variant={variant}
                      state={state}
                      label={currentLabel}
                    />
                  </div>
                  <p className="ds-footnote">
                    Prévia do contrato: tokens resolvidos e estados declarados.
                    A tela original é a referência para layout, conteúdo e
                    comportamento final.
                  </p>
                  <h4>Vínculos que controlam este objeto</h4>
                  <div className="ds-bindings">
                    {effectiveBindings(component, variant, state).map((b) => (
                      <button
                        type="button"
                        key={b.property}
                        onClick={() => {
                          setSection("tokens");
                          choose(b.token);
                        }}
                      >
                        <code>{b.property}</code>
                        <span>→ {b.token}</span>
                      </button>
                    ))}
                  </div>
                  <h4>Propriedades</h4>
                  {component.properties.map((p) => (
                    <div className="ds-property" key={p.name}>
                      <code>{p.name}</code>
                      <span>
                        {p.type}
                        {p.required ? " · obrigatória" : ""}
                      </span>
                      <b>{String(p.defaultValue)}</b>
                      {p.options.length > 0 && (
                        <small>{p.options.join(" · ")}</small>
                      )}
                    </div>
                  ))}
                  {component.children.length > 0 && (
                    <>
                      <h4>Composição</h4>
                      <div className="ds-relation-list">
                        {component.children.map((k) => (
                          <button
                            className="secondary"
                            type="button"
                            key={k}
                            onClick={() => choose(k)}
                          >
                            {k}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                  <div className="ds-guidance">
                    <h4>Acessibilidade</h4>
                    <p>{component.accessibility || "Ainda não documentada."}</p>
                    <h4>Responsividade</h4>
                    <p>{component.responsive || "Ainda não documentada."}</p>
                  </div>
                </>
              )}
              {active.spec.kind === "screen" && (
                <>
                  <h4>Elementos desta tela</h4>
                  <div className="ds-screen-map">
                    {active.spec.components.map((k, i) => (
                      <button
                        type="button"
                        key={k}
                        onClick={() => {
                          setSection("components");
                          choose(k);
                        }}
                      >
                        <span>0{i + 1}</span>
                        <b>
                          {graph.entries.find((x) => x.spec.key === k)?.record
                            .title || k}
                        </b>
                        <code>{k}</code>
                        <small>
                          {graph.components.get(k)?.bindings.length || 0} tokens
                          de base ·{" "}
                          {graph.components.get(k)?.children.length || 0} filhos
                        </small>
                      </button>
                    ))}
                  </div>
                  <div className="ds-guidance">
                    <h4>Responsividade</h4>
                    <p>{active.spec.responsive}</p>
                    <h4>Acessibilidade</h4>
                    <p>{active.spec.accessibility}</p>
                  </div>
                </>
              )}
              <h4>Onde este item é utilizado</h4>
              <div className="ds-relation-list">
                {graph.usages[active.spec.key]?.length ? (
                  graph.usages[active.spec.key].map((u) => (
                    <button
                      type="button"
                      className="secondary"
                      key={`${u.key}-${u.location}`}
                      onClick={() => {
                        setSection(
                          u.kind === "token"
                            ? "tokens"
                            : u.kind === "component"
                              ? "components"
                              : "screens",
                        );
                        choose(u.key);
                      }}
                    >
                      <span>{u.key}</span>
                      <small>{u.location}</small>
                    </button>
                  ))
                ) : (
                  <p className="ds-footnote">
                    Nenhum consumidor direto; disponível na biblioteca.
                  </p>
                )}
              </div>
              {active.spec.source.url && (
                <div className="ds-origin">
                  <h4>Origem</h4>
                  <a
                    href={active.spec.source.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-link"
                  >
                    Ver referência original ↗
                  </a>
                  <code>{active.spec.source.path}</code>
                  <p>{active.spec.source.note}</p>
                </div>
              )}
            </article>
          )}
        </div>
      )}
      {editing && (
        <DesignEditor
          key={editing.record?.id || editing.kind}
          editing={editing}
          ws={ws}
          busy={busy}
          close={() => setEditing(null)}
          perform={perform}
        />
      )}
      {importing && (
        <ImportDialog
          ws={ws}
          close={() => setImporting(false)}
          busy={busy}
          perform={perform}
        />
      )}
    </div>
  );
}
