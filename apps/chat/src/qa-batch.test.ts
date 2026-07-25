import assert from "node:assert/strict";
import { test } from "node:test";
import type { QaScenario } from "@brokk/core";
import { buildQaModuleCardBody, groupScenariosByModule } from "./forge-from-huginn.js";

// Wave 2 QA batching: the Discovery fan-out went from one card per scenario (~26)
// to one card per module (~5-6). These pin the pure grouping that makes that safe —
// all of a module's scenarios land in one card → one PR → no intra-module conflict.
const scn = (over: Partial<QaScenario>): QaScenario => ({
  id: "s",
  title: "t",
  module: "app",
  priority: "p1",
  role: "user",
  tags: [],
  preconditions: [],
  steps: [],
  expects: [],
  ...over,
});

test("collapses N scenarios into one group per module", () => {
  const groups = groupScenariosByModule([
    scn({ id: "a", module: "auth" }),
    scn({ id: "b", module: "billing" }),
    scn({ id: "c", module: "auth" }),
    scn({ id: "d", module: "billing" }),
    scn({ id: "e", module: "auth" }),
  ]);
  assert.equal(groups.length, 2); // 5 scenarios → 2 module cards
  assert.deepEqual(
    groups.map((g) => [g.module, g.scenarios.length]),
    [
      ["auth", 3],
      ["billing", 2],
    ],
  );
});

test("preserves first-seen module order", () => {
  const groups = groupScenariosByModule([
    scn({ module: "z" }),
    scn({ module: "a" }),
    scn({ module: "z" }),
  ]);
  assert.deepEqual(
    groups.map((g) => g.module),
    ["z", "a"],
  );
});

test("sorts each module's scenarios p0-first, stable within a tier", () => {
  const groups = groupScenariosByModule([
    scn({ id: "p1a", module: "m", priority: "p1" }),
    scn({ id: "p0a", module: "m", priority: "p0" }),
    scn({ id: "p2a", module: "m", priority: "p2" }),
    scn({ id: "p0b", module: "m", priority: "p0" }),
  ]);
  assert.deepEqual(
    groups[0]!.scenarios.map((s) => s.id),
    ["p0a", "p0b", "p1a", "p2a"], // p0s first, original order kept within the tier
  );
});

test("blank/missing module falls back to 'app'", () => {
  const groups = groupScenariosByModule([
    scn({ id: "x", module: "" }),
    scn({ id: "y", module: "   " }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.module, "app");
  assert.equal(groups[0]!.scenarios.length, 2);
});

test("module card body includes every scenario of the module", () => {
  const body = buildQaModuleCardBody("auth", [
    scn({ id: "login", title: "Login", steps: ["open /login", "submit"], expects: ["redirects home"] }),
    scn({ id: "logout", title: "Logout", steps: ["click logout"] }),
  ]);
  assert.match(body, /módulo \*\*auth\*\*|Módulo \*\*auth\*\*/);
  assert.match(body, /`login`/);
  assert.match(body, /`logout`/);
  assert.match(body, /ÚNICA PR/); // instructs one PR per module
  assert.match(body, /redirects home/);
});
