import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractPlanIdFromPrBody,
  extractTaskIdFromPrBody,
  normalizePrUrl,
  prNumberFromUrl,
  repoFullNameFromPrUrl,
  selectTaskForMergedPr,
  shouldMarkDoneOnPrClose,
} from "./pr-close.js";

test("normalizePrUrl strips trailing slashes", () => {
  assert.equal(
    normalizePrUrl("https://github.com/o/r/pull/1/"),
    "https://github.com/o/r/pull/1",
  );
});

test("prNumberFromUrl + repoFullNameFromPrUrl", () => {
  const u = "https://github.com/cold-code-labs/markuplab/pull/6";
  assert.equal(prNumberFromUrl(u), 6);
  assert.equal(repoFullNameFromPrUrl(u), "cold-code-labs/markuplab");
});

test("extractTaskIdFromPrBody reads forge stamp", () => {
  const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const body = ["desc", "", "---", `🔨 Forged by **Brokk** · task \`${id}\``].join("\n");
  assert.equal(extractTaskIdFromPrBody(body), id);
  assert.equal(extractTaskIdFromPrBody("no stamp"), null);
});

test("extractPlanIdFromPrBody reads plan stamp", () => {
  const id = "11111111-2222-4333-8444-555555555555";
  assert.equal(extractPlanIdFromPrBody(`plan \`${id}\``), id);
});

test("shouldMarkDoneOnPrClose requires merged", () => {
  assert.equal(shouldMarkDoneOnPrClose({ merged: true }), true);
  assert.equal(shouldMarkDoneOnPrClose({ merged: false }), false);
  assert.equal(shouldMarkDoneOnPrClose({}), false);
});

test("selectTaskForMergedPr prefers URL, then same-repo number, then review", () => {
  const url = "https://github.com/acme/app/pull/3";
  const hit = selectTaskForMergedPr(
    [
      {
        id: "other-repo",
        status: "review",
        prUrl: null,
        prNumber: 3,
        repoFullName: "acme/other",
      },
      {
        id: "url-match",
        status: "running",
        prUrl: url + "/",
        prNumber: 99,
        repoFullName: "acme/app",
      },
      {
        id: "num-review",
        status: "review",
        prUrl: null,
        prNumber: 3,
        repoFullName: "acme/app",
      },
    ],
    { prUrl: url, prNumber: 3, repoFullName: "acme/app" },
  );
  assert.equal(hit?.id, "url-match");
});

test("selectTaskForMergedPr does not cross repos on bare prNumber", () => {
  const hit = selectTaskForMergedPr(
    [
      {
        id: "foreign",
        status: "review",
        prUrl: null,
        prNumber: 1,
        repoFullName: "acme/other",
      },
    ],
    {
      prUrl: "https://github.com/acme/app/pull/1",
      prNumber: 1,
      repoFullName: "acme/app",
    },
  );
  assert.equal(hit, null);
});

test("selectTaskForMergedPr finds review card by repo-scoped number", () => {
  const hit = selectTaskForMergedPr(
    [
      {
        id: "card",
        status: "review",
        prUrl: "https://github.com/acme/app/pull/5",
        prNumber: 5,
        repoFullName: "acme/app",
      },
    ],
    {
      prUrl: "https://github.com/acme/app/pull/5",
      prNumber: 5,
      repoFullName: "acme/app",
    },
  );
  assert.equal(hit?.id, "card");
});
