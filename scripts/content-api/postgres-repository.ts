import type { PostgresConnectionConfig } from "../../news-collector/src/data/repository-config.ts";
import { isPublicAssetContentType, type ContentAsset, type ContentAssetReadRepository, type ContentAssetRequest } from "./assets.ts";
import {
  contentTable,
  type ContentPage,
  type ContentReadRepository,
  type NewsCalendarBucket,
  type NewsCalendarSourceCount,
  type NewsCalendarSummary,
} from "./contract.ts";

export interface PostgresQueryExecutor {
  execute(sql: string, values: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
  close?(): Promise<void>;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function parseCount(rows: readonly Record<string, unknown>[]): number {
  const value = rows[0]?.total_count;
  const total = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("PostgreSQL content count was invalid.");
  return total;
}

export function createPostgresContentReadRepository(
  executor: PostgresQueryExecutor,
): ContentReadRepository {
  return {
    async read(request): Promise<ContentPage> {
      const table = contentTable(request.resource);
      const fields = request.fields.map((field) => {
        const identifier = quoteIdentifier(field);
        // PG DATE is a calendar day. Return text before the driver can turn
        // local midnight into a Date whose JSON value falls on another UTC day.
        return table === "news_items" && (field === "published_date" || field === "collected_date")
          ? `to_char(${identifier}, 'YYYY-MM-DD') AS ${identifier}`
          : identifier;
      }).join(", ");
      const filterValues = request.filters.map((filter) => filter.value);
      const where = request.filters.length
        ? ` WHERE ${request.filters.map((filter, index) =>
          `${quoteIdentifier(filter.field)} = $${index + 1}`
        ).join(" AND ")}`
        : "";
      const order = request.sort.length
        ? ` ORDER BY ${request.sort.map((sort) =>
          // Qualify columns so a text projection's same-name output alias
          // cannot replace native DATE ordering and its usable index.
          `${quoteIdentifier(table)}.${quoteIdentifier(sort.field)} ${sort.direction.toUpperCase()}`
        ).join(", ")}`
        : "";
      const limitPosition = filterValues.length + 1;
      const rows = await executor.execute(
        `SELECT ${fields} FROM ${quoteIdentifier(table)}${where}${order} LIMIT $${limitPosition} OFFSET $${limitPosition + 1}`,
        [...filterValues, request.limit, request.offset],
      );
      const totalCount = request.includeTotal
        ? parseCount(
          await executor.execute(
            `SELECT COUNT(*) AS total_count FROM ${quoteIdentifier(table)}${where}`,
            filterValues,
          ),
        )
        : null;
      return {
        items: rows,
        totalCount,
        hasMore: totalCount === null
          ? rows.length === request.limit
          : request.offset + rows.length < totalCount,
      };
    },
    async readNewsCalendar(): Promise<NewsCalendarSummary> {
      // Read both transactionally maintained rollups in one MVCC snapshot.
      // A cache miss must never aggregate the much larger article archive.
      const rows = await executor.execute(
        [
          'SELECT \'bucket\'::text AS "kind", to_char("collected_date", \'YYYY-MM-DD\') AS "date",',
          '       "ecosystem_layer", "article_count", NULL::bigint AS "source_count"',
          'FROM public."news_calendar_buckets" WHERE "article_count" > 0',
          'UNION ALL',
          'SELECT \'source\'::text, NULL::text, "ecosystem_layer", NULL::bigint, COUNT(*)',
          'FROM public."news_calendar_sources" WHERE "article_count" > 0',
          'GROUP BY "ecosystem_layer"',
          'UNION ALL',
          'SELECT \'source\'::text, NULL::text, \'all\'::text, NULL::bigint, COUNT(DISTINCT "source_name")',
          'FROM public."news_calendar_sources" WHERE "article_count" > 0',
          'ORDER BY "kind" ASC, "date" DESC NULLS LAST, "ecosystem_layer" ASC',
        ].join(" "),
        [],
      );
      const bucketRows: Record<string, unknown>[] = [];
      const sourceRows: Record<string, unknown>[] = [];
      for (const row of rows) {
        if (row.kind === "bucket") bucketRows.push(row);
        else if (row.kind === "source") sourceRows.push(row);
        else throw new Error("PostgreSQL calendar row kind was invalid.");
      }
      const allSources = sourceRows.filter((row) => row.ecosystem_layer === "all");
      if (allSources.length !== 1) throw new Error("PostgreSQL calendar global source total was invalid.");
      return {
        buckets: bucketRows.map(normalizeNewsCalendarBucket),
        sourceCounts: [
          normalizeNewsCalendarSourceCount(allSources[0]!),
          ...sourceRows.filter((row) => row.ecosystem_layer !== "all").map(normalizeNewsCalendarSourceCount),
        ],
      };
    },
  };
}

function normalizeNewsCalendarBucket(row: Record<string, unknown>): NewsCalendarBucket {
  const date = stringField(row, "date");
  const parsedDate = new Date(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsedDate.getTime())
    || parsedDate.toISOString().slice(0, 10) !== date) {
    throw new Error("PostgreSQL calendar bucket date was invalid.");
  }
  return {
    date,
    ecosystemLayer: stringField(row, "ecosystem_layer"),
    articleCount: numericField(row, "article_count"),
  };
}

function normalizeNewsCalendarSourceCount(row: Record<string, unknown>): NewsCalendarSourceCount {
  return {
    ecosystemLayer: stringField(row, "ecosystem_layer"),
    sourceCount: numericField(row, "source_count"),
  };
}

function stringField(row: Record<string, unknown> | undefined, field: string): string {
  const value = row?.[field];
  if (typeof value !== "string" || !value.trim()) throw new Error(`PostgreSQL calendar ${field} was invalid.`);
  return value;
}

function numericField(row: Record<string, unknown> | undefined, field: string): number {
  const value = row?.[field];
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value))) {
    throw new Error(`PostgreSQL calendar ${field} was invalid.`);
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`PostgreSQL calendar ${field} was invalid.`);
  return parsed;
}

/**
 * Asset reads use parameter binding and a fixed public bucket from the request
 * parser. The database never receives arbitrary identifiers from a URL.
 */
export function createPostgresContentAssetReadRepository(
  executor: PostgresQueryExecutor,
): ContentAssetReadRepository {
  return {
    async readAsset(request: ContentAssetRequest): Promise<ContentAsset | null> {
      const rows = await executor.execute(
        [
          'SELECT "content_type", "data"',
          'FROM "content_assets"',
          'WHERE "bucket" = $1 AND "object_key" = $2',
          'LIMIT 1',
        ].join(" "),
        [request.bucket, request.objectKey],
      );
      const row = rows[0];
      if (!row) return null;
      const contentType = row.content_type;
      if (!isPublicAssetContentType(contentType)) {
        throw new Error("PostgreSQL asset has an unsupported content type.");
      }
      const value = row.data;
      if (!(value instanceof Uint8Array)) {
        throw new Error("PostgreSQL asset payload was not binary.");
      }
      return { contentType, bytes: value };
    },
  };
}

interface PgPool {
  query(sql: string, values?: readonly unknown[]): Promise<{
    readonly rows: readonly Record<string, unknown>[];
  }>;
  end(): Promise<void>;
}

interface PgModule {
  Pool: new (options: {
    readonly connectionString: string;
    readonly ssl?: { readonly rejectUnauthorized: true };
    readonly max: number;
    readonly idleTimeoutMillis: number;
    readonly connectionTimeoutMillis: number;
    readonly statement_timeout: number;
    readonly query_timeout: number;
    readonly application_name: string;
  }) => PgPool;
}

// The public API is usually quiet between page loads. Retain a small pool long
// enough to avoid repeatedly paying a cold PostgreSQL connection during those
// gaps; max=5 still bounds the process's database footprint.
const CONTENT_API_PG_IDLE_TIMEOUT_MS = 300_000;

/** Runtime driver boundary for the read-only Content API process. */
export async function openPgExecutor(
  config: PostgresConnectionConfig,
): Promise<PostgresQueryExecutor> {
  const moduleName = "pg";
  let pg: PgModule;
  try {
    pg = await import(moduleName) as unknown as PgModule;
  } catch (error) {
    throw new Error(
      `PostgreSQL content adapter requires pg: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const pool = new pg.Pool({
    connectionString: config.url,
    ssl: config.ssl ? { rejectUnauthorized: true } : undefined,
    max: 5,
    idleTimeoutMillis: CONTENT_API_PG_IDLE_TIMEOUT_MS,
    // Keep failed refreshes bounded so a broken connection cannot occupy the
    // single-flight slot forever. Client timeout also covers lost responses.
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    query_timeout: 12_000,
    application_name: "navigate-content-api",
  });
  return {
    async execute(sql, values) {
      return (await pool.query(sql, values)).rows;
    },
    close: async () => pool.end(),
  };
}
