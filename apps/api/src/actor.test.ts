import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import {
  canSeeProject,
  listScope,
  requestActor,
  resolveLogtoOrgId,
  type Actor,
} from "./actor.js";

const staff: Actor = { email: "v@ccl", orgIds: ["d5qacs8kwh79"], isStaff: true };
const client: Actor = { email: "ti@acme", orgIds: ["org-acme"], isStaff: false };

function fakeCtx(headers: Record<string, string>) {
  return {
    req: {
      header: (name: string) => headers[name.toLowerCase()] ?? headers[name] ?? undefined,
    },
  } as never;
}

describe("actor tenancy (ADR 0064)", () => {
  afterEach(() => {
    delete process.env.BROKK_ORG_TENANCY;
  });

  it("staff always sees null and foreign orgs when tenancy on", () => {
    process.env.BROKK_ORG_TENANCY = "1";
    assert.equal(canSeeProject(staff, null), true);
    assert.equal(canSeeProject(staff, "org-other"), true);
    assert.deepEqual(listScope(staff), { isStaff: true });
  });

  it("client never sees null; only own org", () => {
    process.env.BROKK_ORG_TENANCY = "1";
    assert.equal(canSeeProject(client, null), false);
    assert.equal(canSeeProject(client, "org-acme"), true);
    assert.equal(canSeeProject(client, "org-other"), false);
    assert.deepEqual(listScope(client), { isStaff: false, orgIds: ["org-acme"] });
  });

  it("tenancy off → everyone staff-scoped (legado dogfood)", () => {
    delete process.env.BROKK_ORG_TENANCY;
    assert.equal(canSeeProject(client, null), true);
    assert.deepEqual(listScope(client), { isStaff: true });
  });

  it("resolveLogtoOrgId stamps client org", () => {
    process.env.BROKK_ORG_TENANCY = "1";
    const ok = resolveLogtoOrgId(client, null);
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.logtoOrgId, "org-acme");
    const denied = resolveLogtoOrgId({ ...client, orgIds: [] }, null);
    assert.equal(denied.ok, false);
  });

  it("requestActor elevates forge runner bearer to staff", () => {
    process.env.BROKK_ORG_TENANCY = "1";
    const secret = "runner-secret-for-test-32chars!!";
    const elevated = requestActor(
      fakeCtx({ authorization: `Bearer ${secret}` }),
      secret,
    );
    assert.equal(elevated.isStaff, true);
    assert.equal(canSeeProject(elevated, null), true);

    const plain = requestActor(fakeCtx({ authorization: "Bearer wrong" }), secret);
    assert.equal(plain.isStaff, false);
    assert.equal(canSeeProject(plain, null), false);
  });
});
