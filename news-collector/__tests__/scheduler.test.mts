import assert from "node:assert/strict";
import test from "node:test";
import { createNonOverlappingRunner } from "../src/scheduler.ts";

test("boot collection and scheduled collection share one pending run", async () => {
  let calls = 0;
  let skips = 0;
  let finish: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const run = createNonOverlappingRunner(async () => { calls += 1; await pending; }, () => { skips += 1; });

  const boot = run();
  const scheduled = run();
  assert.equal(boot, scheduled, "scheduler must see the actual pending collection Promise");
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(skips, 1);
  finish?.();
  await boot;
  await run();
  assert.equal(calls, 2, "the next collection is allowed once the active one finishes");
});

test("a rejected collection releases the overlap lock for the next trigger", async () => {
  let calls = 0;
  const run = createNonOverlappingRunner(async () => {
    calls += 1;
    if (calls === 1) throw new Error("temporary database failure");
  });
  await assert.rejects(run(), /temporary database failure/);
  await run();
  assert.equal(calls, 2);
});
