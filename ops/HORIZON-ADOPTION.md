# Horizon 文章收集流程接入

参考仓库：[Thysrael/Horizon](https://github.com/Thysrael/Horizon)，核对版本 `0540481e7ce86e3b70ce11b731314f88bc10d718`（2026-10-26）。本次直接参考采集和编辑阶段的实际源码与测试，独立接入现有 TypeScript / PostgreSQL 服务，不运行额外 Python 服务。

## 对照与落点

| 环节 | Horizon 证据 | 本项目实现 |
| --- | --- | --- |
| 多源采集 | `src/scrapers/rss.py`、`hackernews.py`、`github.py` | 保留现有 RSS / Atom、HN 和 GitHub releases 适配器与单源重试 |
| 新鲜度 | `src/orchestrator.py`、各 scraper 的 UTC 截止时间 | `collect.ts`：默认 24 小时，先按发布时间过滤再每源封顶；未来超过 5 分钟拒绝，无日期保留并计数 |
| 规范化与全文 | `src/scrapers/rss.py`：保留丰富内容候选 | `rss.ts` 保留 `content:encoded`；`normalize.ts` 分开摘要和全文，丰富 RSS 正文直接复用 |
| URL 合并 | `src/orchestrator.py` URL 分组 | `dedupe.ts` 保持稳定 URL 身份和首个来源，合并更完整的正文并保存 `mergedSources` |
| 阅读类型 | `src/ai/classifier.py` | `editorial.ts`：`tech-news`、`tech-blog`、`ai-creator` 与原八层主题分类并存 |
| 结构化分析 | `src/ai/analyzer.py`、`src/models.py` | 明确 AI 相关性、0–10 分、理由、摘要和标签；模型结果校验，最多一次格式修复 |
| 编辑选取 | `src/orchestrator.py`、`src/ai/prompting/deduplication.py` | 先相关性／阈值，再保守同事件合并，最后按来源、主题和总量配额选取 |
| 成本顺序 | `src/orchestrator.py`：filter / balance 在 enrichment 前 | `collect.ts`：已入库跳过和编辑筛选均在外部正文请求、翻译、富化之前 |
| 外链边界 | `src/url_security.py`、`src/extractors/trafilatura.py` | `article-http.ts`：公网 DNS 校验并固定连接 IP、TLS 保留原主机验证、逐跳重定向与 2 MiB 响应上限 |
| 持久化 | Horizon 主要保存每日 Markdown 与配置 | 保留 PostgreSQL 幂等 upsert、首次采集日期及成功正文／译文保护，无数据库结构迁移 |

Horizon 没有被确认具备跨运行的持久已读账本或 AI 评分缓存。本次新增的 PostgreSQL `findExistingNewsIds` 是 Navigate 自身的增量优化，不将它误称为上游已有能力。原始归档保持可访问，不清理历史文章。

## 新流程

```text
现有多源抓取（隔离异常）
  → 24h UTC 发布时间窗口 / 无日期计数 / 每源数量限制
  → 标准化与条目校验 / URL 合并
  → 查询已入库 ID，跳过已处理文章
  → AI 相关性预筛 / 阅读 profile
  → 有界模型评分 / 最多一次格式修复 / 明确降级
  → 保守同事件去重 / 主题与来源配额 / 总数限制
  → 对缺少全文的入选文章抓正文
  → 原有翻译与可选富化
  → 原有 PostgreSQL upsert / 运行报告
```

评分分析只使用有限标题、摘要和正文片段，提示词将文章内容视为不可信数据。分析预算按来源和主题轮转，避免单一高产源占满模型预算。失败或超时不制造高分：仅保留有充分 AI 证据的规则候选，记录 `method=rules, score=null`，仍受数量配额限制。

编辑结果保存在原有 `metadata.editorial` 中，包含版本、阅读类型、方法、评分、理由与摘要；原始标题、摘要、正文不被分析结果覆盖。公开页面沿用现有接口和八层分类，并可显示追加的阅读类型标签；没有把任意模型输出当作网页 HTML。

## 默认预算与运维

- `NEWS_LOOKBACK_HOURS=24`；支持 1–720 小时。窗口使用 UTC 时间戳，入库采集日期仍按北京时间。
- `NEWS_SKIP_EXISTING=true`；正常增量任务在分析、取文和翻译前查询已存在 ID。需要补全文或重新编辑旧记录时，可在一次人工重处理任务中设为 `false`，并显式扩大时间窗口；不会删除旧记录。
- `NEWS_EDITORIAL_ENABLED=true`、`NEWS_EDITORIAL_MAX_ANALYZE=40`、`NEWS_EDITORIAL_THRESHOLD=7`。
- 每轮最多 40 条入选，每主题最多 10 条，每来源最多 5 条；2 个模型并发、每次 30 秒超时，格式不合格最多再请求一次。模型分析条数预算不等同于含修复在内的 HTTP 请求数上限。
- 模型复用已有 provider、凭据与模型配置；缺凭据时模型预算为 0。`NEWS_EDITORIAL_MODEL` 可覆盖，其次沿用翻译／富化模型配置。
- 原来每天北京时间 08:00 的 systemd 任务继续作为唯一调度，不增加 GitHub Actions、常驻 Horizon 服务或新的通知渠道。

真实运行报告同时记录原始条目数、窗口过滤、无日期、无效条目、URL 合并、已存跳过、分析失败、相关性排除、低分、主题合并、配额跳过和最终入选。`stored` 是本轮 upsert 数，不是净新增数；空入选不会写库，表总数显示 `unchanged`。

本轮不新增需要付费或额外凭据的 X / Reddit / 搜索服务，不把社区讨论混写为原作者正文；这些能力可沿用相同边界另行增加。Horizon 的许可和来源见 `THIRD_PARTY_NOTICES.md`。

## 生产验收

2026-10-26 使用独立的有限预算人工验收任务实跑，72 个来源中 71 个成功。URL 合并后 99 条，提前跳过已入库的 58 条；完成 6 次模型分析且无分析失败，最终入选 6 条（3 条模型评分、3 条明确标记的规则补位），正文 6/6 成功。本轮净新增 6 条，文章总量为 21003；均为中文，翻译按规则跳过。该人工任务不启用通知、不新增定时器，正常任务仍为每天北京时间 08:00。

公开文章详情和总量已在网页核对；后端 217 项测试、类型检查及 CI 通过。人工验收的分析和入选上限都是 6，区别于上面的正常运行预算。

## 日历读性能维护

原日历有三条覆盖索引，定义在 `database/001-news-items.sql`；不要在它们有效时再添加重复索引。此前重复 upsert 可使索引扫描产生较多 heap fetch。若真实执行计划确认这一点，可在采集任务空闲时以管理员运行 `database/004-calendar-maintenance.sql`，做带锁等待和资源上限的普通在线 VACUUM / ANALYZE，保留现有记录并禁止尾部截断。随后用 `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF)` 比较日历的实际耗时和 Heap Fetches，不能仅凭索引存在就宣称性能修复。

2026-10-26 的这次维护达到 5 分钟上限，PostgreSQL 日志确认 `statement_timeout` 中止；没有重复执行或提高上限，不能视为索引清理与 ANALYZE 均已完成。随后一次只读复测中，日历分桶查询的 Heap Fetches 从 4452 变为 1398，执行时间从 27.063 秒变为 14.040 秒；共享主机的负载和缓存也影响耗时，这不是冷读性能已根治的证据。该限制与上述 Horizon 采集验收分别记录。

同轮 `ops/verify-live.mjs` 接口验收通过：日历 200 / 29.032 秒，日期列表 200 / 1.411 秒，详情 200 / 0.456 秒，重复列表 200 / 0.578 秒，非法写请求 405。日历仍接近网页的 30 秒请求上限，首次读取存在超时风险；这项既有性能限制尚未消除。
