import assert from "node:assert/strict"
import { describe, it } from "node:test"

/** Mirrors apps/web/lib/house.ts — keep in sync until shared in @brokk/core. */
type OpStatus = "idle" | "queued" | "forging" | "review" | "failed" | "objective"

function opStatus(input: {
  needObjective: boolean
  running: number
  queued?: number
  review: number
  briefFailed: boolean
}): OpStatus {
  // Live work beats history — keep in sync with apps/web/lib/house.ts.
  if (input.running > 0) return "forging"
  if ((input.queued ?? 0) > 0) return "queued"
  if (input.review > 0) return "review"
  if (input.briefFailed) return "failed"
  if (input.needObjective) return "objective"
  return "idle"
}

function needsAttention(input: {
  archived?: boolean
  needObjective: boolean
  running: number
  queued?: number
  review: number
  briefFailed: boolean
}): boolean {
  if (input.archived) return false
  if (input.briefFailed) return true
  if (input.running > 0) return true
  if ((input.queued ?? 0) > 0) return true
  if (input.review > 0) return true
  return false
}

function needsObjectiveSection(input: {
  archived?: boolean
  needObjective: boolean
  running: number
  queued?: number
  review: number
  briefFailed: boolean
}): boolean {
  if (input.archived) return false
  if (needsAttention(input)) return false
  return input.needObjective
}

describe("house op status", () => {
  it("fail / forge / queue / review beat objective", () => {
    assert.equal(
      opStatus({ needObjective: true, running: 0, queued: 0, review: 0, briefFailed: true }),
      "failed",
    )
    assert.equal(
      opStatus({ needObjective: true, running: 1, queued: 2, review: 0, briefFailed: false }),
      "forging",
    )
    assert.equal(
      opStatus({ needObjective: true, running: 0, queued: 1, review: 0, briefFailed: false }),
      "queued",
    )
    assert.equal(
      opStatus({ needObjective: true, running: 0, queued: 0, review: 1, briefFailed: false }),
      "review",
    )
    assert.equal(
      opStatus({ needObjective: true, running: 0, queued: 0, review: 0, briefFailed: false }),
      "objective",
    )
  })

  it("forging and queued beat a failed brief", () => {
    assert.equal(
      opStatus({ needObjective: false, running: 1, queued: 0, review: 0, briefFailed: true }),
      "forging",
    )
    assert.equal(
      opStatus({ needObjective: false, running: 0, queued: 1, review: 0, briefFailed: true }),
      "queued",
    )
  })

  it("queue is attention — not idle, not objective-pending", () => {
    const queued = { needObjective: true, running: 0, queued: 1, review: 0, briefFailed: false }
    assert.equal(opStatus(queued), "queued")
    assert.equal(needsAttention(queued), true)
    assert.equal(needsObjectiveSection(queued), false)
  })

  it("attention is operational only — not missing objective", () => {
    assert.equal(
      needsAttention({ needObjective: true, running: 0, queued: 0, review: 0, briefFailed: false }),
      false,
    )
    assert.equal(
      needsObjectiveSection({
        needObjective: true,
        running: 0,
        queued: 0,
        review: 0,
        briefFailed: false,
      }),
      true,
    )
    assert.equal(
      needsAttention({ needObjective: false, running: 1, queued: 0, review: 0, briefFailed: false }),
      true,
    )
  })

  it("a hot project never also lands in objective-pending", () => {
    const hot = { needObjective: true, running: 0, queued: 0, review: 2, briefFailed: false }
    assert.equal(needsAttention(hot), true)
    assert.equal(needsObjectiveSection(hot), false)
  })
})
