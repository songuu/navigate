import { randomUUID } from "node:crypto";
import { open, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

export interface CalendarSnapshotPublication {
  readonly bytes: Readonly<Uint8Array>;
  readonly generatedAtMs: number;
  readonly expiresAtMs: number;
}

export type CalendarSnapshotPublisher = (publication: CalendarSnapshotPublication) => Promise<void>;

interface CalendarSnapshotPublisherOptions {
  /** Test seam around atomic replacement; all file writes remain real. */
  readonly replaceFile?: (from: string, to: string) => Promise<void>;
}

const MAX_SNAPSHOT_AGE_MS = 120_000;

/**
 * Publishes only public calendar statistics. The service manager owns creation
 * and permissions of the state directory; this writer never creates parents.
 */
export function createCalendarSnapshotPublisher(
  target: string,
  options: CalendarSnapshotPublisherOptions = {},
): CalendarSnapshotPublisher {
  if (!isAbsolute(target) || !basename(target)) {
    throw new Error("Calendar snapshot target must be an absolute file path.");
  }
  const directory = dirname(target);
  const replaceFile = options.replaceFile ?? rename;

  return async (publication) => {
    const bytes = createAssetBytes(publication);
    const temporary = join(directory, `.${basename(target)}.${randomUUID()}.tmp`);
    let file: FileHandle | null = null;
    let createdTemporary = false;
    try {
      file = await open(temporary, "wx", 0o644);
      createdTemporary = true;
      // This is intentionally public data, including when the host uses a
      // restrictive umask. Nginx must be able to read the final file.
      await file.chmod(0o644);
      await file.writeFile(bytes);
      await file.sync();
      await file.close();
      file = null;
      await replaceFile(temporary, target);
      createdTemporary = false;
    } catch (error) {
      const errors: unknown[] = [error];
      if (file) {
        try { await file.close(); } catch (closeError) { errors.push(closeError); }
      }
      if (createdTemporary) {
        try { await unlink(temporary); } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") errors.push(cleanupError);
        }
      }
      throw new AggregateError(errors, `Calendar snapshot publication failed: ${target}`);
    }
  };
}

function createAssetBytes(publication: CalendarSnapshotPublication): Buffer {
  const { generatedAtMs, expiresAtMs } = publication;
  const span = expiresAtMs - generatedAtMs;
  if (!Number.isSafeInteger(generatedAtMs) || !Number.isSafeInteger(expiresAtMs)
    || !Number.isFinite(new Date(generatedAtMs).getTime()) || !Number.isFinite(new Date(expiresAtMs).getTime())
    || span <= 0 || span > MAX_SNAPSHOT_AGE_MS) {
    throw new Error("Calendar snapshot timestamps must define a positive lifetime of at most 120000 milliseconds.");
  }

  // Copy once so a caller cannot change the outgoing asset during async I/O.
  const source = Buffer.from(publication.bytes);
  let end = source.length;
  while (end > 0 && [0x20, 0x09, 0x0a, 0x0d].includes(source[end - 1]!)) end--;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.subarray(0, end).toString("utf8"));
  } catch (error) {
    throw new Error("Calendar snapshot must contain valid JSON.", { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Calendar snapshot must contain a public statistics object.");
  }
  const calendar = parsed as Record<string, unknown>;
  if (!Array.isArray(calendar.buckets) || !Array.isArray(calendar.sourceCounts)
    || Object.keys(calendar).some((key) => key !== "buckets" && key !== "sourceCounts")
    || source[end - 1] !== 0x7d) {
    throw new Error("Calendar snapshot may contain only public buckets and sourceCounts.");
  }
  const metadata = JSON.stringify({
    snapshotGeneratedAt: new Date(generatedAtMs).toISOString(),
    snapshotExpiresAt: new Date(expiresAtMs).toISOString(),
  });
  // Preserve the already-encoded statistics and append only small metadata;
  // there is no second traversal/encoding of every calendar bucket.
  return Buffer.concat([source.subarray(0, end - 1), Buffer.from(`,${metadata.slice(1)}\n`, "utf8")]);
}
