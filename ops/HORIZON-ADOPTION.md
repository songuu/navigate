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
