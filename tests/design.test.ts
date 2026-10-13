import assert from "node:assert/strict";
import { test } from "node:test";
import { contextFor } from "../server/providers.ts";
import {
  buildDesignContract,
  type ComponentSpec,
  canonicalJson,
  componentStyle,
  contrastRatio,
  designGraph,
  designSchema,
  manifestSchema,
} from "../shared/design.ts";
import type { Artifact, Workspace } from "../shared/domain.ts";
import { emptyData } from "../shared/domain.ts";
import { nfcsManifest } from "../shared/examples/nfcs.ts";

function fixture(): Workspace {
  const manifest = manifestSchema.parse(nfcsManifest);
  return {
    project: {
      id: "00000000-0000-4000-8000-000000000999",
      organizationId: "00000000-0000-4000-8000-000000000998",
      name: manifest.name,
      objective: "Validar a comunicação de design até o contrato de código.",
      status: "planning",
      version: 1,
      updatedAt: "2026-10-13T00:00:00.000Z",
      repository: null,
      externalId: null,
    },
    organization: {
      id: "00000000-0000-4000-8000-000000000998",
      name: "CCL",
      role: "operator",
      externalId: null,
    },
    members: [],
    events: [],
    records: manifest.items.map((x, i) => ({
      id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      projectId: "00000000-0000-4000-8000-000000000999",
      kind: x.design.kind,
      title: x.title,
      status: "draft",
      version: 1,
      author: "fixture",
      updatedAt: "2026-10-13T00:00:00.000Z",
      data: {
        ...emptyData(),
        body: x.body,
        acceptance: x.acceptance,
        design: x.design,
      },
    })),
  };
}
function item(ws: Workspace, key: string) {
  const record = ws.records.find((x) => x.data.design?.key === key);
  assert.ok(record);
  return record;
}
const errors = (ws: Workspace) =>
  designGraph(ws.records).issues.filter((x) => x.severity === "error");
test("NFCS reference has typed primitives, aliases, composite objects, components and screen links", () => {
  const ws = fixture(),
    g = designGraph(ws.records);
  assert.equal(g.valid, true);
  assert.equal(errors(ws).length, 0);
  assert.equal(g.tokens.size, 86);
  assert.equal(g.components.size, 16);
  assert.equal(ws.records.filter((x) => x.kind === "screen").length, 6);
  assert.equal(g.resolved["color.surface.highlight"], "#f4d33b");
  assert.equal(g.resolved["color.surface.page"], "#e7e5e0");
  assert.match(String(g.resolved["font.family.body"]), /Public Sans/);
  assert.equal(
    (g.resolved["typography.hero"] as Record<string, unknown>).fontFamily,
    g.resolved["font.family.display"],
  );
  assert.ok(g.contrast.length >= 30);
  assert.ok(g.contrast.every((x) => x.pass));
  assert.ok(
    g.usages["color.highlight.yellow"].some(
      (x) => x.key === "color.surface.highlight",
    ),
  );
  assert.ok(g.usages["text.grifo"].some((x) => x.kind === "screen"));
});
test("changing a primitive propagates through aliases and changes the exact consumer preview without editing it", () => {
  const ws = fixture();
  const before = designGraph(ws.records);
  const c = before.components.get("text.grifo") as ComponentSpec;
  assert.equal(componentStyle(c, before.resolved).backgroundColor, "#f4d33b");
  const primitive = item(ws, "color.highlight.yellow");
  assert.equal(primitive.data.design?.kind, "token");
  if (primitive.data.design?.kind === "token")
    primitive.data.design.value = "#efc72e";
  const after = designGraph(ws.records);
  assert.equal(after.valid, true);
  assert.equal(componentStyle(c, after.resolved).backgroundColor, "#efc72e");
  assert.equal(
    (item(ws, "text.grifo").data.design as ComponentSpec).bindings.find(
      (x) => x.property === "backgroundColor",
    )?.token,
    "color.surface.highlight",
  );
});
test("DTCG export preserves aliases and emits native color, dimension, typography and shadow values; CSS is namespaced", () => {
  const c = buildDesignContract(fixture());
  const dtcg = c.tokens as Record<
    string,
    Record<string, Record<string, Record<string, unknown>>>
  >;
  assert.equal(dtcg.color.surface.highlight.$value, "{color.highlight.yellow}");
  assert.deepEqual(dtcg.color.paper.base.$value, {
    colorSpace: "srgb",
    components: [231 / 255, 229 / 255, 224 / 255],
    alpha: 1,
  });
  assert.deepEqual(
    (c.tokens.space as Record<string, { $value: unknown }>)["8"].$value,
    { value: 2, unit: "rem" },
  );
  assert.deepEqual(
    (c.tokens.typography as Record<string, { $value: unknown }>).hero.$value,
    {
      fontFamily: "{font.family.display}",
      fontSize: "{font.size.hero}",
      fontWeight: "{font.weight.500}",
      letterSpacing: "{font.tracking.hero}",
      lineHeight: "{font.line.hero}",
    },
  );
  assert.match(
    c.css,
    /data-design-system="00000000-0000-4000-8000-000000000999"/,
  );
  assert.match(
    c.css,
    /--ds-color-surface-highlight: var\(--ds-color-highlight-yellow\)/,
  );
  assert.match(c.css, /data-component="button.primary"/);
  assert.match(c.css, /:focus-visible/);
  assert.deepEqual(manifestSchema.parse(c.manifest), c.manifest);
});
test("missing references, alias type mismatches, cycles and key collisions are reported instead of falling back", () => {
  for (const mode of ["missing", "mismatch", "cycle", "prefix"]) {
    const ws = fixture();
    const r = item(ws, "color.surface.highlight");
    assert.equal(r.data.design?.kind, "token");
    if (r.data.design?.kind === "token")
      r.data.design.value =
        mode === "missing"
          ? "{color.unknown.value}"
          : mode === "mismatch"
            ? "{font.family.body}"
            : mode === "cycle"
              ? "{color.surface.highlight}"
              : r.data.design.value;
    if (mode === "prefix" && r.data.design) r.data.design.key = "color.surface";
    const list = errors(ws);
    assert.ok(list.length, mode);
    assert.equal(designGraph(ws.records).valid, false, mode);
  }
});
test("unsafe values, malformed objects, duplicate variants and component composition cycles cannot produce a valid contract", () => {
  const ws = fixture();
  const t = item(ws, "font.family.body");
  if (t.data.design?.kind === "token")
    t.data.design.value = "x; background:url(https://evil.example)";
  assert.ok(errors(ws).some((x) => x.code === "value"));
  const c = item(ws, "button.primary");
  if (c.data.design?.kind === "component")
    c.data.design.children = ["button.primary"];
  assert.ok(errors(ws).some((x) => x.code === "component-cycle"));
  assert.equal(
    designSchema.safeParse({
      kind: "token",
      key: "constructor.prototype",
      type: "color",
      layer: "primitive",
      value: "#000",
      source: {},
    }).success,
    false,
  );
  const type = item(ws, "typography.hero");
  if (type.data.design?.kind === "token")
    type.data.design.value = {
      fontFamily: "{font.family.display}",
      fontSize: "bad",
      fontWeight: 500,
      letterSpacing: "0px",
      lineHeight: 1,
    };
  assert.ok(
    errors(ws).some((x) => x.key === "typography.hero" && x.code === "value"),
  );
});
test("variant and state overrides are resolved deterministically; invalid contrast blocks development", () => {
  const ws = fixture(),
    g = designGraph(ws.records),
    c = g.components.get("button.primary") as ComponentSpec;
  assert.equal(
    componentStyle(c, g.resolved, "compact", "hover").minHeight,
    "2.75rem",
  );
  assert.equal(
    componentStyle(c, g.resolved, "compact", "hover").backgroundColor,
    "#3a3e43",
  );
  const ink = item(ws, "color.ink.base");
  if (ink.data.design?.kind === "token") ink.data.design.value = "#e7e5e0";
  assert.ok(errors(ws).some((x) => x.code === "contrast"));
  assert.throws(
    () => contextFor(ws, { ...ws.records[0], kind: "task" }),
    /Corrija o design system/,
  );
  assert.ok((contrastRatio("#1b1d20", "#e7e5e0") || 0) > 10);
});
test("export to manifest and reimport preserve the resolved design graph and component object contracts", () => {
  const ws = fixture(),
    exported = buildDesignContract(ws),
    m = manifestSchema.parse(JSON.parse(JSON.stringify(exported.manifest)));
  const roundtrip = {
    ...ws,
    records: m.items.map((x, i) => ({
      ...ws.records[i],
      kind: x.design.kind,
      title: x.title,
      data: {
        ...emptyData(),
        body: x.body,
        acceptance: x.acceptance,
        design: x.design,
      },
    })),
  };
  const graph = designGraph(roundtrip.records);
  assert.equal(graph.valid, true);
  assert.equal(
    canonicalJson(graph.resolved),
    canonicalJson(designGraph(ws.records).resolved),
  );
  assert.equal(
    canonicalJson(
      [...graph.components.values()].sort((a, b) => a.key.localeCompare(b.key)),
    ),
    canonicalJson(
      [...designGraph(ws.records).components.values()].sort((a, b) =>
        a.key.localeCompare(b.key),
      ),
    ),
  );
});
test("the prepared coder context contains the complete versioned contract and valid JSON, including late tokens", () => {
  const ws = fixture(),
    task: Artifact = {
      ...ws.records[0],
      id: "00000000-0000-4000-8000-000000000777",
      kind: "task",
      title: "Implementar a página",
      data: {
        ...emptyData(),
        body: "Usar o sistema Autos",
        acceptance: "Usar os vínculos e estados.",
        screenId: item(ws, "screen.hero").id,
      },
    };
  const prompt = contextFor(ws, task);
  const packet = JSON.parse(prompt.slice(prompt.indexOf('{"project"')));
  assert.equal(packet.designSystem.schemaVersion, "brokk.design-system/1");
  assert.equal(packet.designSystem.versions.length, 108);
  assert.equal(
    packet.designSystem.resolvedTokens["color.surface.highlight"],
    "#f4d33b",
  );
  assert.equal(packet.designSystem.components.length, 16);
  assert.ok(packet.designSystem.checksum.length === 64);
  assert.ok(prompt.length < 160500);
});

test("object defaults remain typed and duplicate manifest keys are rejected before persistence", () => {
  const c = buildDesignContract(fixture());
  const primary = c.components.find((x) => x.key === "button.primary");
  assert.equal(
    primary?.properties.find((x) => x.name === "external")?.defaultValue,
    false,
  );
  const duplicate = structuredClone(nfcsManifest);
  duplicate.items.push(duplicate.items[0]);
  assert.equal(manifestSchema.safeParse(duplicate).success, false);
  const ws = fixture();
  const component = item(ws, "button.primary");
  if (component.data.design?.kind === "component")
    component.data.design.variants.push(component.data.design.variants[0]);
  assert.ok(errors(ws).some((x) => x.code === "duplicate-option"));
});

test("contract identity is stable when database record order changes", () => {
  const ws = fixture();
  const before = canonicalJson(buildDesignContract(ws));
  ws.records.reverse();
  assert.equal(canonicalJson(buildDesignContract(ws)), before);
  const token = item(ws, "color.highlight.yellow").data.design;
  assert.ok(token?.kind === "token");
  token.value = "#eac72f";
  assert.notEqual(canonicalJson(buildDesignContract(ws)), before);
});
