import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import { createCalendarSnapshotPublisher, type CalendarSnapshotPublication } from "./calendar-snapshot.ts";

const generatedAtMs = Date.parse("2026-10-26T01:00:00Z");
const expiresAtMs = generatedAtMs + 120_000;
const calendar = (articleCount: number) => ({
  buckets: [{ date: "2026-10-26", ecosystemLayer: "模型与平台✨", articleCount }],
  sourceCounts: [{ ecosystemLayer: "all", sourceCount: 1 }],
});
const publication = (articleCount: number): CalendarSnapshotPublication => ({
  bytes: Buffer.from(`${JSON.stringify(calendar(articleCount))}\n`, "utf8"), generatedAtMs, expiresAtMs,
});

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "navigate-calendar-test-"));
  // Cleanup may recurse only into this test's freshly created temporary folder.
  assert.equal(dirname(directory), resolve(tmpdir()));
  assert.match(basename(directory), /^navigate-calendar-test-/);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("calendar asset preserves Unicode and public counts with explicit expiry metadata", async (t) => {
  const directory = await temporaryDirectory(t);
  const target = join(directory, "calendar.json");
  const input = publication(2);
  const originalBytes = Buffer.from(input.bytes);
  await createCalendarSnapshotPublisher(target)(input);
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), {
    ...calendar(2), snapshotGeneratedAt: "2026-10-26T01:00:00.000Z", snapshotExpiresAt: "2026-10-26T01:02:00.000Z",
  });
  assert.deepEqual(input.bytes, originalBytes, "asset metadata must not alter the API buffer");
  assert.deepEqual(await readdir(directory), ["calendar.json"]);
  if (process.platform !== "win32") assert.equal((await stat(target)).mode & 0o777, 0o644);
});

test("calendar asset stays complete until one atomic replacement publishes the next generation", async (t) => {
  const directory = await temporaryDirectory(t);
  const target = join(directory, "calendar.json");
  await createCalendarSnapshotPublisher(target)(publication(1));
  let release: (() => void) | undefined;
  let markReplacing: (() => void) | undefined;
  let temporary = "";
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const replacing = new Promise<void>((resolveReplacing) => { markReplacing = resolveReplacing; });
  const publish = createCalendarSnapshotPublisher(target, {
    async replaceFile(from, to) {
      temporary = from;
      markReplacing?.();
      await gate;
      await rename(from, to);
    },
  });
  const pending = publish(publication(2));
  await replacing;
  try {
    assert.equal(dirname(temporary), directory, "atomic rename requires the same directory");
    assert.equal(JSON.parse(await readFile(target, "utf8")).buckets[0].articleCount, 1);
    assert.equal(JSON.parse(await readFile(temporary, "utf8")).buckets[0].articleCount, 2);
  } finally { release?.(); await pending; }
  assert.equal(JSON.parse(await readFile(target, "utf8")).buckets[0].articleCount, 2);
  assert.deepEqual(await readdir(directory), ["calendar.json"]);
});

test("a failed replacement preserves the previous full file and removes its own temporary file", async (t) => {
  const directory = await temporaryDirectory(t);
  const target = join(directory, "calendar.json");
  await createCalendarSnapshotPublisher(target)(publication(1));
  const previous = await readFile(target);
  const failure = new Error("simulated rename failure");
  const publish = createCalendarSnapshotPublisher(target, { async replaceFile() { throw failure; } });
  await assert.rejects(publish(publication(2)), (error) => error instanceof AggregateError && error.errors.includes(failure));
  assert.deepEqual(await readFile(target), previous);
  assert.deepEqual(await readdir(directory), ["calendar.json"]);
});

test("concurrent preparations use distinct temporary files and publish complete generations in order", async (t) => {
  const directory = await temporaryDirectory(t);
  const target = join(directory, "calendar.json");
  await createCalendarSnapshotPublisher(target)(publication(1));
  const temporaryFiles = new Set<string>();
  let releaseFirst: (() => void) | undefined;
  let releaseSecond: (() => void) | undefined;
  let markBoth: (() => void) | undefined;
  const firstGate = new Promise<void>((resolveGate) => { releaseFirst = resolveGate; });
  const secondGate = new Promise<void>((resolveGate) => { releaseSecond = resolveGate; });
  const both = new Promise<void>((resolveBoth) => { markBoth = resolveBoth; });
  const publish = createCalendarSnapshotPublisher(target, {
    async replaceFile(from, to) {
      const generation = JSON.parse(await readFile(from, "utf8")).buckets[0].articleCount;
      assert.ok(generation === 2 || generation === 3);
      temporaryFiles.add(from);
      if (temporaryFiles.size === 2) markBoth?.();
      // Both files are prepared concurrently. Commit them separately so the
      // test observes atomicity without Windows' same-target rename race.
      await (generation === 2 ? firstGate : secondGate);
      await rename(from, to);
    },
  });
  const first = publish(publication(2));
  const second = publish(publication(3));
  const completed = Promise.allSettled([first, second]);
  try {
    await both;
    assert.equal(temporaryFiles.size, 2);
    assert.equal(JSON.parse(await readFile(target, "utf8")).buckets[0].articleCount, 1);
    releaseFirst?.();
    await first;
    assert.equal(JSON.parse(await readFile(target, "utf8")).buckets[0].articleCount, 2);
    releaseSecond?.();
    await second;
  } finally {
    releaseFirst?.();
    await first.catch(() => undefined);
    releaseSecond?.();
    await completed;
  }
  const result = JSON.parse(await readFile(target, "utf8"));
  assert.equal(result.buckets[0].articleCount, 3);
  assert.equal(result.snapshotExpiresAt, "2026-10-26T01:02:00.000Z");
  assert.deepEqual(await readdir(directory), ["calendar.json"]);
});

test("publisher rejects invalid JSON, non-public top-level fields and invalid timestamp ranges before writing", async (t) => {
  const directory = await temporaryDirectory(t);
  const publish = createCalendarSnapshotPublisher(join(directory, "calendar.json"));
  const invalid = [
    { ...publication(1), bytes: Buffer.from("{broken}") },
    { ...publication(1), bytes: Buffer.from("[]") },
    { ...publication(1), bytes: Buffer.from(JSON.stringify({ ...calendar(1), credentials: "must not publish" })) },
    { ...publication(1), generatedAtMs: Number.NaN },
    { ...publication(1), expiresAtMs: generatedAtMs },
    { ...publication(1), expiresAtMs: generatedAtMs + 120_001 },
  ];
  for (const item of invalid) await assert.rejects(publish(item), /calendar snapshot/i);
  assert.deepEqual(await readdir(directory), []);
});

test("publisher requires an absolute file path and an existing state directory", async (t) => {
  const directory = await temporaryDirectory(t);
  assert.throws(() => createCalendarSnapshotPublisher("relative/calendar.json"), /absolute/i);
  const parent = join(directory, "not-created");
  await assert.rejects(createCalendarSnapshotPublisher(join(parent, "calendar.json"))(publication(1)), /calendar snapshot/i);
  await assert.rejects(stat(parent), { code: "ENOENT" });
});
