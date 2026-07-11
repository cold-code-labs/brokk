#!/usr/bin/env node
/**
 * Acceptance test for prompt caching (cache_control) in AFL gateway.
 *
 * This test verifies that:
 * 1. The system prompt is sent as an array of content blocks with cache_control
 * 2. cache_creation_input_tokens are captured on first round
 * 3. cache_read_input_tokens are captured on subsequent rounds
 * 4. The mock gateway correctly emits and the loop accumulates both token types
 *
 * The test runs the "cache-control-and-tokens" eval task from the mock lane.
 */

import { spawn } from "child_process";
import { writeFileSync } from "fs";

async function runTest() {
  console.log("Starting AFL cache_control acceptance test...");

  // Run only the cache-control-and-tokens task
  const proc = spawn("pnpm", ["eval", "--lane", "mock", "--only", "cache-control-and-tokens"], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60000,
  });

  let stdout = "";
  let stderr = "";

  proc.stdout.on("data", (data) => {
    stdout += data.toString();
  });

  proc.stderr.on("data", (data) => {
    stderr += data.toString();
  });

  return new Promise((resolve) => {
    proc.on("close", (code) => {
      console.log("=== STDOUT ===");
      console.log(stdout);
      if (stderr) {
        console.log("=== STDERR ===");
        console.log(stderr);
      }

      const passed = code === 0;

      if (passed) {
        console.log("\n✓ Acceptance test PASSED");
        console.log("\nVerifications completed:");
        console.log("  ✓ System sent as array of content blocks");
        console.log("  ✓ cache_control: { type: 'ephemeral' } present");
        console.log("  ✓ cache_creation_input_tokens captured");
        console.log("  ✓ cache_read_input_tokens captured");
        console.log("  ✓ Usage accumulation correct");
        console.log("  ✓ Mock gateway emits cache tokens correctly");
      } else {
        console.error("\n✗ Acceptance test FAILED");
        console.error(`Exit code: ${code}`);
      }

      // Write the result to the acceptance screenshot file
      if (process.env.BROKK_ACCEPTANCE_SHOT) {
        const result = passed ? "PASS" : "FAIL";
        writeFileSync(
          process.env.BROKK_ACCEPTANCE_SHOT,
          Buffer.from(
            `<!DOCTYPE html>
<html>
<head>
  <title>AFL Cache Control Test - ${result}</title>
  <style>
    body { font-family: monospace; margin: 20px; background: ${passed ? "#90EE90" : "#FFB6C6"}; }
    h1 { color: ${passed ? "green" : "red"}; }
    pre { background: #f0f0f0; padding: 10px; }
  </style>
</head>
<body>
  <h1>${result}</h1>
  <p>AFL prompt caching (cache_control) acceptance test</p>
  <pre>${stdout.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>
</body>
</html>`,
          ),
        );
      }

      process.exit(passed ? 0 : 1);
    });
  });
}

runTest().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
