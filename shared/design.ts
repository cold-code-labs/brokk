import { z } from "zod";
import type { Artifact, Workspace } from "./domain.ts";

export const tokenTypes = [
  "color",
  "dimension",
  "fontFamily",
  "fontWeight",
  "number",
  "duration",
  "cubicBezier",
  "shadow",
  "typography",
] as const;
export const layers = ["primitive", "semantic", "component"] as const;
export const previews = [
  "button",
  "text",
  "surface",
  "choice",
  "navigation",
  "input",
  "badge",
  "section",
  "list",
  "media",
] as const;
export const designStates = [
  "hover",
  "focus",
  "active",
  "disabled",
  "selected",
  "error",
] as const;
export const bindingTypes = {
  color: "color",
  backgroundColor: "color",
  borderColor: "color",
  outlineColor: "color",
  fontFamily: "fontFamily",
  fontSize: "dimension",
  fontWeight: "fontWeight",
  lineHeight: "number",
  letterSpacing: "dimension",
  padding: "dimension",
  paddingInline: "dimension",
  paddingBlock: "dimension",
  gap: "dimension",
  borderRadius: "dimension",
  borderWidth: "dimension",
  minHeight: "dimension",
  maxWidth: "dimension",
  outlineWidth: "dimension",
  opacity: "number",
  boxShadow: "shadow",
  transitionDuration: "duration",
  transitionTimingFunction: "cubicBezier",
  typography: "typography",
} as const;
export type BindingProperty = keyof typeof bindingTypes;
const key = z
  .string()
  .max(100)
  .regex(/^[a-z][a-z0-9]*(?:\.[a-z0-9]+)+$/)
  .refine(
    (x) =>
      !x
        .split(".")
        .some((s) => ["__proto__", "constructor", "prototype"].includes(s)),
  );
const text = z.string().trim().max(2000);
export const sourceSchema = z
  .object({
    url: z
      .string()
      .max(1000)
      .refine((v) => {
        if (!v) return true;
        try {
          const u = new URL(v);
          return u.protocol === "https:" && !u.username && !u.password;
        } catch {
          return false;
        }
      })
      .default(""),
    path: z.string().max(300).default(""),
    note: text.default(""),
    capturedAt: z
      .union([z.iso.datetime({ offset: true }), z.literal("")])
      .default(""),
  })
  .strict();
const typography = z
  .object({
    fontFamily: z.string().max(300),
    fontSize: z.string().max(100),
    fontWeight: z.union([z.string().max(100), z.number()]),
    letterSpacing: z.string().max(100),
    lineHeight: z.union([z.string().max(100), z.number()]),
  })
  .strict();
const shadow = z
  .object({
    color: z.string().max(100),
    offsetX: z.string().max(100),
    offsetY: z.string().max(100),
    blur: z.string().max(100),
    spread: z.string().max(100),
    inset: z.boolean().default(false),
  })
  .strict();
const tokenSchema = z
  .object({
    kind: z.literal("token"),
    key,
    type: z.enum(tokenTypes),
    layer: z.enum(layers),
    value: z.union([
      z.string().max(500),
      z.number().finite(),
      typography,
      z.array(shadow).min(1).max(4),
    ]),
    source: sourceSchema.default({
      url: "",
      path: "",
      note: "",
      capturedAt: "",
    }),
  })
  .strict();
const binding = z
  .object({
    property: z.enum(
      Object.keys(bindingTypes) as [BindingProperty, ...BindingProperty[]],
    ),
    token: key,
  })
  .strict();
const bindings = z
  .array(binding)
  .max(40)
  .refine(
    (a) => new Set(a.map((x) => x.property)).size === a.length,
    "Propriedade repetida.",
  );
const property = z
  .object({
    name: z
      .string()
      .regex(/^[a-z][a-zA-Z0-9]{0,39}$/)
      .refine((x) => !["constructor", "prototype"].includes(x)),
    type: z.enum(["text", "boolean", "enum"]),
    options: z.array(z.string().max(100)).max(20).default([]),
    defaultValue: z.union([z.string().max(300), z.boolean()]).default(""),
    required: z.boolean().default(false),
  })
  .strict()
  .transform((p) =>
    p.type === "boolean" && ["true", "false"].includes(String(p.defaultValue))
      ? {
          ...p,
          defaultValue: p.defaultValue === true || p.defaultValue === "true",
        }
      : p,
  );
const componentSchema = z
  .object({
    kind: z.literal("component"),
    key,
    preview: z.enum(previews),
    bindings: bindings.min(1),
    variants: z
      .array(
        z
          .object({ name: z.string().regex(/^[a-z][a-z0-9]{0,39}$/), bindings })
          .strict(),
      )
      .max(20)
      .default([]),
    states: z
      .array(z.object({ name: z.enum(designStates), bindings }).strict())
      .max(6)
      .default([]),
    properties: z.array(property).max(20).default([]),
    children: z.array(key).max(20).default([]),
    accessibility: text.default(""),
    responsive: text.default(""),
    source: sourceSchema.default({
      url: "",
      path: "",
      note: "",
      capturedAt: "",
    }),
  })
  .strict();
const screenSchema = z
  .object({
    kind: z.literal("screen"),
    key,
    components: z.array(key).min(1).max(50),
    accessibility: text.default(""),
    responsive: text.default(""),
    source: sourceSchema.default({
      url: "",
      path: "",
      note: "",
      capturedAt: "",
    }),
  })
  .strict();
export const designSchema = z.discriminatedUnion("kind", [
  tokenSchema,
  componentSchema,
  screenSchema,
]);
export type DesignSpec = z.infer<typeof designSchema>;
export type TokenSpec = Extract<DesignSpec, { kind: "token" }>;
export type ComponentSpec = Extract<DesignSpec, { kind: "component" }>;
export type ScreenSpec = Extract<DesignSpec, { kind: "screen" }>;
export type Binding = z.infer<typeof binding>;
export type TokenValue = TokenSpec["value"];
export const manifestSchema = z
  .object({
    schemaVersion: z.literal("brokk.design-system/1"),
    name: z.string().trim().min(1).max(200),
    sourceUrl: sourceSchema.shape.url,
    items: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(200),
            body: z.string().max(12000).default(""),
            acceptance: z.string().max(12000).default(""),
            design: designSchema,
          })
          .strict(),
      )
      .min(1)
      .max(250),
  })
  .strict()
  .refine(
    (m) => new Set(m.items.map((x) => x.design.key)).size === m.items.length,
    "O manifesto possui chaves repetidas.",
  );
export type DesignManifest = z.infer<typeof manifestSchema>;
export type Issue = {
  severity: "error" | "warning";
  key: string;
  code: string;
  message: string;
};
export type DesignEntry = { record: Artifact; spec: DesignSpec };
export const reference = (value: unknown): string | null =>
  typeof value === "string"
    ? /^\{([a-z][a-z0-9]*(?:\.[a-z0-9]+)+)\}$/.exec(value)?.[1] || null
    : null;
export const variableName = (path: string) =>
  `--ds-${path.replaceAll(".", "-")}`;
const compositeFields = {
  fontFamily: "fontFamily",
  fontSize: "dimension",
  fontWeight: "fontWeight",
  letterSpacing: "dimension",
  lineHeight: "number",
} as const;
const shadowFields = {
  color: "color",
  offsetX: "dimension",
  offsetY: "dimension",
  blur: "dimension",
  spread: "dimension",
} as const;
const dimension = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem)$/;
const duration = /^(?:\d+(?:\.\d+)?|\.\d+)(?:ms|s)$/;
const color = /^#(?:[a-f0-9]{3}|[a-f0-9]{4}|[a-f0-9]{6}|[a-f0-9]{8})$/i;
export function references(value: TokenValue): string[] {
  if (reference(value)) return [reference(value) as string];
  if (Array.isArray(value))
    return value.flatMap((x) =>
      Object.values(x).flatMap((v) =>
        reference(v) ? [reference(v) as string] : [],
      ),
    );
  if (typeof value === "object")
    return Object.values(value).flatMap((v) =>
      reference(v) ? [reference(v) as string] : [],
    );
  return [];
}
export function entriesOf(records: Artifact[]): DesignEntry[] {
  return records
    .filter((x) => x.data.design)
    .map((record) => ({
      record,
      spec: designSchema.parse(record.data.design),
    }));
}
function literalOk(type: string, v: unknown): boolean {
  if (reference(v)) return true;
  switch (type) {
    case "color":
      return typeof v === "string" && color.test(v);
    case "dimension":
      return (
        typeof v === "string" &&
        dimension.test(v) &&
        Math.abs(parseFloat(v)) <= 10000
      );
    case "duration":
      return (
        typeof v === "string" && duration.test(v) && parseFloat(v) <= 60000
      );
    case "fontFamily":
      return typeof v === "string" && /^[\w\s",'-]+$/.test(v) && v.length > 0;
    case "fontWeight":
      return Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 1000;
    case "number":
      return (
        typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 10000
      );
    case "cubicBezier": {
      if (typeof v !== "string") return false;
      const m =
        /^cubic-bezier\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)$/.exec(
          v,
        );
      return (
        !!m &&
        m.slice(1).every((x) => Number.isFinite(Number(x))) &&
        Number(m[1]) >= 0 &&
        Number(m[1]) <= 1 &&
        Number(m[3]) >= 0 &&
        Number(m[3]) <= 1
      );
    }
    case "typography":
      return (
        !!v &&
        !Array.isArray(v) &&
        typeof v === "object" &&
        Object.entries(compositeFields).every(([k, t]) =>
          literalOk(t, (v as Record<string, unknown>)[k]),
        )
      );
    case "shadow":
      return (
        Array.isArray(v) &&
        v.length > 0 &&
        v.every(
          (x) =>
            Object.entries(shadowFields).every(([k, t]) =>
              literalOk(t, x[k]),
            ) &&
            (reference(x.blur) !== null || parseFloat(x.blur) >= 0),
        )
      );
    default:
      return false;
  }
}
export function designGraph(records: Artifact[]) {
  const issues: Issue[] = [];
  const add = (
    severity: Issue["severity"],
    key: string,
    code: string,
    message: string,
  ) => {
    if (
      !issues.some(
        (x) =>
          x.severity === severity &&
          x.key === key &&
          x.code === code &&
          x.message === message,
      )
    )
      issues.push({ severity, key, code, message });
  };
  const entries: DesignEntry[] = [];
  for (const r of records.filter((r) =>
    ["token", "component", "screen"].includes(r.kind),
  )) {
    if (!r.data.design) {
      add(
        "warning",
        r.title,
        "legacy",
        "Registro descritivo: estruture este item para incluí-lo no contrato.",
      );
      continue;
    }
    const parsed = designSchema.safeParse(r.data.design);
    if (!parsed.success || parsed.data.kind !== r.kind) {
      add(
        "error",
        r.title,
        "schema",
        "Especificação inválida ou tipo incompatível com o registro.",
      );
      continue;
    }
    entries.push({ record: r, spec: parsed.data });
  }
  const byKey = new Map<string, DesignEntry>();
  for (const x of entries) {
    if (byKey.has(x.spec.key))
      add(
        "error",
        x.spec.key,
        "duplicate",
        "Chave já utilizada neste projeto.",
      );
    byKey.set(x.spec.key, x);
  }
  const tokens = new Map<string, TokenSpec>();
  const components = new Map<string, ComponentSpec>();
  for (const x of entries) {
    if (x.spec.kind === "token") tokens.set(x.spec.key, x.spec);
    if (x.spec.kind === "component") components.set(x.spec.key, x.spec);
  }
  const checkReference = (owner: string, target: string, type: string) => {
    const token = tokens.get(target);
    if (!token)
      add(
        "error",
        owner,
        "missing-token",
        `Token ${target} não existe neste projeto.`,
      );
    else if (token.type !== type)
      add(
        "error",
        owner,
        "type",
        `${target} é ${token.type}; a propriedade exige ${type}.`,
      );
  };
  for (const t of tokens.values()) {
    for (const other of tokens.keys())
      if (other !== t.key && other.startsWith(`${t.key}.`))
        add(
          "error",
          t.key,
          "path-collision",
          "Um token não pode ser pai de outro token no arquivo de intercâmbio.",
        );
    if (!literalOk(t.type, t.value))
      add(
        "error",
        t.key,
        "value",
        `Valor inválido para ${t.type}. Use um valor tipado ou uma referência completa.`,
      );
    if (t.layer === "primitive" && references(t.value).length)
      add(
        "error",
        t.key,
        "layer",
        "Primitivos guardam valores; referências pertencem às camadas semântica ou de componente.",
      );
    if (reference(t.value))
      checkReference(t.key, reference(t.value) as string, t.type);
    else if (
      t.type === "typography" &&
      typeof t.value === "object" &&
      !Array.isArray(t.value)
    ) {
      for (const [field, type] of Object.entries(compositeFields)) {
        const target = reference((t.value as Record<string, unknown>)[field]);
        if (target) checkReference(t.key, target, type);
      }
    } else if (t.type === "shadow" && Array.isArray(t.value)) {
      for (const shadow of t.value)
        for (const [field, type] of Object.entries(shadowFields)) {
          const target = reference((shadow as Record<string, unknown>)[field]);
          if (target) checkReference(t.key, target, type);
        }
    }
  }
  function detectCycles(nodes: Map<string, string[]>, code: string) {
    const done = new Set<string>(),
      visiting = new Set<string>();
    const visit = (k: string) => {
      if (visiting.has(k)) {
        add(
          "error",
          k,
          code,
          "Referência circular: o conjunto não pode ser resolvido.",
        );
        return;
      }
      if (done.has(k)) return;
      visiting.add(k);
      for (const next of nodes.get(k) || []) if (nodes.has(next)) visit(next);
      visiting.delete(k);
      done.add(k);
    };
    for (const k of nodes.keys()) visit(k);
  }
  detectCycles(
    new Map([...tokens].map(([k, t]) => [k, references(t.value)])),
    "token-cycle",
  );
  detectCycles(
    new Map([...components].map(([k, c]) => [k, c.children])),
    "component-cycle",
  );
  for (const c of components.values()) {
    if (
      new Set(c.variants.map((x) => x.name)).size !== c.variants.length ||
      new Set(c.states.map((x) => x.name)).size !== c.states.length ||
      new Set(c.properties.map((x) => x.name)).size !== c.properties.length
    )
      add(
        "error",
        c.key,
        "duplicate-option",
        "Nomes de variantes, estados e propriedades devem ser únicos.",
      );
    for (const p of c.properties) {
      if (p.type !== "boolean" && typeof p.defaultValue !== "string")
        add(
          "error",
          c.key,
          "property",
          "Texto e escolhas exigem um valor padrão de texto.",
        );
      if (
        p.type === "enum" &&
        (!p.options.length ||
          typeof p.defaultValue !== "string" ||
          !p.options.includes(p.defaultValue) ||
          new Set(p.options).size !== p.options.length)
      )
        add(
          "error",
          c.key,
          "property",
          "Uma propriedade de escolha precisa de opções e valor padrão válido.",
        );
      if (p.type === "boolean" && typeof p.defaultValue !== "boolean")
        add(
          "error",
          c.key,
          "property",
          "Propriedade booleana exige true ou false como valor tipado.",
        );
    }
    for (const list of [
      c.bindings,
      ...c.variants.map((x) => x.bindings),
      ...c.states.map((x) => x.bindings),
    ])
      for (const b of list)
        checkReference(c.key, b.token, bindingTypes[b.property]);
    for (const child of c.children)
      if (!components.has(child))
        add(
          "error",
          c.key,
          "missing-component",
          `Componente ${child} não existe neste projeto.`,
        );
    if (!c.accessibility)
      add(
        "warning",
        c.key,
        "accessibility",
        "Registre o comportamento de teclado, foco e leitura assistiva.",
      );
  }
  for (const x of entries)
    if (x.spec.kind === "screen")
      for (const component of x.spec.components)
        if (!components.has(component))
          add(
            "error",
            x.spec.key,
            "screen-link",
            `Componente ${component} não existe neste projeto.`,
          );
  const resolve = (path: string, seen = new Set<string>()): TokenValue => {
    if (seen.has(path)) throw new Error(`Ciclo em ${path}`);
    const t = tokens.get(path);
    if (!t) throw new Error(`Token ausente: ${path}`);
    seen.add(path);
    const ref = reference(t.value);
    if (ref) return resolve(ref, seen);
    const field = (v: unknown) =>
      reference(v) ? resolve(reference(v) as string, new Set(seen)) : v;
    if (Array.isArray(t.value))
      return t.value.map((s) =>
        Object.fromEntries(Object.entries(s).map(([k, v]) => [k, field(v)])),
      ) as TokenValue;
    if (typeof t.value === "object")
      return Object.fromEntries(
        Object.entries(t.value).map(([k, v]) => [k, field(v)]),
      ) as TokenValue;
    return t.value;
  };
  const resolved: Record<string, TokenValue> = Object.create(null);
  if (!issues.some((x) => x.severity === "error"))
    for (const key of tokens.keys()) resolved[key] = resolve(key);
  for (const t of tokens.values()) {
    const value = resolved[t.key];
    if (
      t.type === "typography" &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      if (
        parseDimension(value.fontSize) < 1 ||
        parseDimension(value.fontSize) > 512 ||
        Number(value.lineHeight) <= 0
      )
        add(
          "error",
          t.key,
          "typography-value",
          "Objeto tipográfico com dimensão ou entrelinha inválida.",
        );
    }
    if (
      t.type === "shadow" &&
      Array.isArray(value) &&
      value.some(
        (s) => parseDimension(s.blur) < 0 || parseDimension(s.blur) > 512,
      )
    )
      add(
        "error",
        t.key,
        "shadow-value",
        "Blur da sombra deve estar entre 0 e 512px.",
      );
  }
  const usages: Record<
    string,
    { key: string; kind: string; location: string }[]
  > = Object.create(null);
  for (const k of byKey.keys()) usages[k] = [];
  const use = (target: string, key: string, kind: string, location: string) => {
    if (usages[target]) usages[target].push({ key, kind, location });
  };
  for (const t of tokens.values())
    for (const ref of references(t.value))
      use(ref, t.key, "token", "Referência");
  for (const c of components.values()) {
    for (const b of c.bindings) use(b.token, c.key, "component", b.property);
    for (const v of c.variants)
      for (const b of v.bindings)
        use(b.token, c.key, "component", `${v.name} · ${b.property}`);
    for (const v of c.states)
      for (const b of v.bindings)
        use(b.token, c.key, "component", `${v.name} · ${b.property}`);
    for (const child of c.children)
      use(child, c.key, "component", "Composição");
  }
  for (const x of entries)
    if (x.spec.kind === "screen")
      for (const c of x.spec.components) use(c, x.spec.key, "screen", "Tela");
  for (const k of tokens.keys())
    if (!usages[k]?.length)
      add(
        "warning",
        k,
        "unused",
        "Token ainda sem consumidor. A biblioteca pode mantê-lo como reserva.",
      );
  if (!entries.length)
    add(
      "warning",
      "design",
      "empty",
      "Importe ou cadastre tokens, componentes e telas para validar um sistema real.",
    );
  const contrast: {
    component: string;
    variant: string;
    state: string;
    ratio: number;
    minimum: number;
    pass: boolean;
  }[] = [];
  if (Object.keys(resolved).length)
    for (const c of components.values())
      for (const variant of ["", ...c.variants.map((x) => x.name)])
        for (const state of ["", ...c.states.map((x) => x.name)]) {
          const style = componentStyle(c, resolved, variant, state);
          for (const [property, value] of Object.entries(style)) {
            if (
              property === "opacity" &&
              (Number(value) < 0 || Number(value) > 1)
            )
              add(
                "error",
                c.key,
                "property-value",
                "Opacidade deve estar entre 0 e 1.",
              );
            if (property === "lineHeight" && Number(value) <= 0)
              add(
                "error",
                c.key,
                "property-value",
                "Altura de linha deve ser positiva.",
              );
            if (
              [
                "fontSize",
                "padding",
                "paddingInline",
                "paddingBlock",
                "gap",
                "borderRadius",
                "borderWidth",
                "minHeight",
                "maxWidth",
                "outlineWidth",
              ].includes(property) &&
              parseDimension(value) < 0
            )
              add(
                "error",
                c.key,
                "property-value",
                `${property} não pode ser negativo.`,
              );
            if (
              property === "fontSize" &&
              (parseDimension(value) < 1 || parseDimension(value) > 512)
            )
              add(
                "error",
                c.key,
                "property-value",
                "Fonte fora do intervalo de 1 a 512px.",
              );
          }
          if (
            state !== "disabled" &&
            typeof style.color === "string" &&
            typeof style.backgroundColor === "string"
          ) {
            const ratio = contrastRatio(style.color, style.backgroundColor);
            if (ratio !== null) {
              const size = parseDimension(style.fontSize);
              const large =
                size >= 24 ||
                (size >= 18.66 && Number(style.fontWeight) >= 700);
              const minimum = large ? 3 : 4.5;
              const pass = ratio >= minimum;
              contrast.push({
                component: c.key,
                variant: variant || "default",
                state: state || "default",
                ratio: Math.round(ratio * 100) / 100,
                minimum,
                pass,
              });
              if (!pass)
                add(
                  "error",
                  c.key,
                  "contrast",
                  `Contraste ${ratio.toFixed(2)}:1 em ${variant || "padrão"}/${state || "padrão"}; mínimo ${minimum}:1.`,
                );
            }
          }
        }
  return {
    entries,
    tokens,
    components,
    resolved,
    usages,
    issues,
    contrast,
    valid: entries.length > 0 && !issues.some((x) => x.severity === "error"),
  };
}
export function cssValue(type: string, value: TokenValue): string {
  if (type === "shadow" && Array.isArray(value))
    return value
      .map(
        (s) =>
          `${s.inset ? "inset " : ""}${s.offsetX} ${s.offsetY} ${s.blur} ${s.spread} ${s.color}`,
      )
      .join(", ");
  return String(value);
}
export function componentStyle(
  component: ComponentSpec,
  resolved: Record<string, TokenValue>,
  variant = "",
  state = "",
) {
  const style: Record<string, string | number> = {};
  const all = [
    ...component.bindings,
    ...(component.variants.find((x) => x.name === variant)?.bindings || []),
    ...(component.states.find((x) => x.name === state)?.bindings || []),
  ];
  for (const b of all) {
    const value = resolved[b.token];
    if (value === undefined) continue;
    if (
      b.property === "typography" &&
      typeof value === "object" &&
      !Array.isArray(value)
    )
      Object.assign(style, value);
    else
      style[b.property] = ["opacity", "fontWeight", "lineHeight"].includes(
        b.property,
      )
        ? Number(value)
        : cssValue(bindingTypes[b.property], value);
  }
  return style;
}
function parseDimension(value: unknown) {
  if (typeof value !== "string") return 0;
  return parseFloat(value) * (value.endsWith("rem") ? 16 : 1);
}
export function hexColor(value: string) {
  if (!color.test(value)) return null;
  let raw = value.slice(1);
  if (raw.length < 5) raw = [...raw].map((x) => x + x).join("");
  return {
    components: [0, 2, 4].map((i) => parseInt(raw.slice(i, i + 2), 16) / 255),
    alpha: raw.length === 8 ? parseInt(raw.slice(6, 8), 16) / 255 : 1,
  };
}
export function contrastRatio(fg: string, bg: string) {
  const f = hexColor(fg),
    b = hexColor(bg);
  if (!f || !b || b.alpha !== 1) return null;
  const composite = f.components.map(
    (x, i) => x * f.alpha + b.components[i] * (1 - f.alpha),
  );
  const luminance = (c: number[]) =>
    c
      .map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
      .reduce((s, x, i) => s + x * [0.2126, 0.7152, 0.0722][i], 0);
  const l1 = luminance(composite),
    l2 = luminance(b.components);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
const kebab = (property: string) =>
  property.replace(/[A-Z]/g, (x) => `-${x.toLowerCase()}`);
function dtcgValue(type: string, value: TokenValue): unknown {
  if (reference(value)) return value;
  if (type === "color") {
    const c = hexColor(String(value));
    return c
      ? { colorSpace: "srgb", components: c.components, alpha: c.alpha }
      : value;
  }
  if (type === "dimension" || type === "duration") {
    const s = String(value);
    return {
      value: parseFloat(s),
      unit: s.replace(/^-?(?:\d+(?:\.\d+)?|\.\d+)/, ""),
    };
  }
  if (type === "fontFamily")
    return String(value)
      .split(",")
      .map((x) => x.trim().replace(/^["']|["']$/g, ""));
  if (type === "fontWeight") return Number(value);
  if (type === "cubicBezier")
    return String(value).slice(13, -1).split(",").map(Number);
  if (
    type === "typography" &&
    typeof value === "object" &&
    !Array.isArray(value)
  )
    return Object.fromEntries(
      Object.entries(compositeFields).map(([k, t]) => [
        k,
        dtcgValue(t, (value as Record<string, TokenValue>)[k]),
      ]),
    );
  if (type === "shadow" && Array.isArray(value))
    return value.map((s) => ({
      ...Object.fromEntries(
        Object.entries(shadowFields).map(([k, t]) => [
          k,
          dtcgValue(t, s[k as keyof typeof shadowFields]),
        ]),
      ),
      inset: s.inset,
    }));
  return value;
}
function cssTokenValue(type: string, value: TokenValue): string {
  const ref = reference(value);
  if (ref) return `var(${variableName(ref)})`;
  if (type === "shadow" && Array.isArray(value))
    return value
      .map(
        (s) =>
          `${s.inset ? "inset " : ""}${["offsetX", "offsetY", "blur", "spread", "color"].map((k) => cssTokenValue(k === "color" ? "color" : "dimension", s[k as keyof typeof shadowFields])).join(" ")}`,
      )
      .join(", ");
  return cssValue(type, value);
}
export function buildDesignContract(workspace: Workspace) {
  const graph = designGraph(workspace.records);
  const scope = `[data-design-system="${workspace.project.id}"]`;
  const dtcg: Record<string, unknown> = Object.create(null);
  const declarations: string[] = [];
  for (const t of [...graph.tokens.values()].sort((a, b) =>
    a.key.localeCompare(b.key),
  )) {
    const entry = graph.entries.find(
      (x) => x.spec.key === t.key,
    ) as DesignEntry;
    let node = dtcg;
    const parts = t.key.split(".");
    for (const k of parts.slice(0, -1)) {
      if (!node[k]) node[k] = Object.create(null);
      node = node[k] as Record<string, unknown>;
    }
    node[parts.at(-1) as string] = {
      $type: t.type,
      $value: dtcgValue(t.type, t.value),
      $description: entry.record.data.body,
      $extensions: {
        "com.coldcodelabs.brokk": {
          layer: t.layer,
          source: t.source,
          recordId: entry.record.id,
          version: entry.record.version,
        },
      },
    };
    if (t.type === "typography") {
      const alias = reference(t.value);
      const value = graph.resolved[t.key];
      if (value && typeof value === "object" && !Array.isArray(value))
        for (const [field, type] of Object.entries(compositeFields)) {
          const raw =
            !alias && typeof t.value === "object" && !Array.isArray(t.value)
              ? (t.value as Record<string, TokenValue>)[field]
              : (value as Record<string, TokenValue>)[field];
          declarations.push(
            `  ${variableName(t.key)}--${kebab(field)}: ${alias ? `var(${variableName(alias)}--${kebab(field)})` : cssTokenValue(type, raw)};`,
          );
        }
    } else
      declarations.push(
        `  ${variableName(t.key)}: ${cssTokenValue(t.type, t.value)};`,
      );
  }
  const rules = [`${scope} {\n${declarations.join("\n")}\n}`];
  const bindingCss = (list: Binding[]) =>
    list
      .flatMap((b) =>
        b.property === "typography"
          ? Object.keys(compositeFields).map(
              (p) =>
                `  ${kebab(p)}: var(${variableName(b.token)}--${kebab(p)});`,
            )
          : [`  ${kebab(b.property)}: var(${variableName(b.token)});`],
      )
      .join("\n");
  for (const c of graph.components.values()) {
    const selector = `${scope} [data-component="${c.key}"]`;
    rules.push(`${selector} {\n${bindingCss(c.bindings)}\n}`);
    for (const v of c.variants)
      rules.push(
        `${selector}[data-variant="${v.name}"] {\n${bindingCss(v.bindings)}\n}`,
      );
    for (const s of c.states) {
      const pseudo = ["hover", "focus", "active", "disabled"].includes(s.name)
        ? `,\n${selector}:${s.name === "focus" ? "focus-visible" : s.name}`
        : "";
      rules.push(
        `${selector}[data-state="${s.name}"]${pseudo} {\n${bindingCss(s.bindings)}\n}`,
      );
    }
  }
  const manifest: DesignManifest = {
    schemaVersion: "brokk.design-system/1",
    name: workspace.project.name,
    sourceUrl:
      graph.entries.find((x) => x.spec.source.url)?.spec.source.url || "",
    items: graph.entries.map((x) => ({
      title: x.record.title,
      body: x.record.data.body,
      acceptance: x.record.data.acceptance,
      design: x.spec,
    })),
  };
  return {
    schemaVersion: "brokk.design-system/1",
    project: { id: workspace.project.id, name: workspace.project.name },
    versions: graph.entries
      .map((x) => ({
        id: x.record.id,
        key: x.spec.key,
        version: x.record.version,
        status: x.record.status,
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    validation: {
      valid: graph.valid,
      issues: graph.issues,
      contrast: graph.contrast,
      counts: {
        tokens: graph.tokens.size,
        components: graph.components.size,
        screens: graph.entries.filter((x) => x.spec.kind === "screen").length,
        bindings: [...graph.components.values()].reduce(
          (n, c) =>
            n +
            c.bindings.length +
            c.variants.reduce((s, v) => s + v.bindings.length, 0) +
            c.states.reduce((s, v) => s + v.bindings.length, 0),
          0,
        ),
      },
    },
    tokens: dtcg,
    resolvedTokens: graph.resolved,
    components: graph.entries
      .filter(
        (x): x is { record: Artifact; spec: ComponentSpec } =>
          x.spec.kind === "component",
      )
      .map((x) => ({
        title: x.record.title,
        description: x.record.data.body,
        acceptance: x.record.data.acceptance,
        ...x.spec,
      })),
    screens: graph.entries
      .filter(
        (x): x is { record: Artifact; spec: ScreenSpec } =>
          x.spec.kind === "screen",
      )
      .map((x) => ({
        title: x.record.title,
        description: x.record.data.body,
        acceptance: x.record.data.acceptance,
        ...x.spec,
      })),
    css: rules.join("\n\n"),
    manifest,
  };
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
