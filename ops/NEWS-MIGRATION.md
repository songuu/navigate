# AI 资讯迁移与回退

## 已保留的契约

采集入口为 `news-collector/src/cli-collect.ts`，只读 API 入口为 `scripts/content-api/start-production.ts`。API 进程路径不包含部署前缀，Nginx 将站点 `/api/content/v1/` 代理到内部 `/api/content/v1/`。现有接口完整保留：

```text
GET /api/content/v1/news?fields=external_id,title,title_zh,summary,summary_zh,translation_status,collected_date,published_date&sort=collected_date:desc&limit=20&offset=0
GET /api/content/v1/news?fields=external_id,title,content_text,content_text_zh,translation_status&filter=external_id:eq:ARTICLE_ID
GET /api/content/v1/news/calendar
```

过滤为重复的 `filter=field:eq:value`，排序为重复的 `sort=field:asc|desc`。分页响应为 `{items,totalCount,hasMore}`，每页最多 1000 条；`count=none` 跳过 COUNT。日历返回 `{buckets:[{date,ecosystemLayer,articleCount}],sourceCounts:[{ecosystemLayer,sourceCount}]}`。列表与日历按 `collected_date`，不能混用 `published_date`。

新闻列表、详情和日历在 API 进程内共享 60 秒新鲜期缓存；同一新闻请求的并发冷读/刷新只执行一次数据库读取。列表最多保留 128 个最近使用的查询。过期首次访问等待刷新后返回新数据；数据库暂时异常时才回退上次成功结果并记录错误，不延长旧值新鲜期，下次访问继续重试。日历要求浏览器重新验证，前端请求绕过旧浏览器缓存。其它内容资源没有该缓存。重启 API 会清空缓存。

对独立新库运行 `database/003-news-read-indexes.sql`，增加与前端真实排序 `(collected_date DESC, published_date DESC, external_id ASC)` 及分类筛选匹配的两个复合索引。脚本使用 `CREATE INDEX CONCURRENTLY`，必须在事务外逐条执行；失败后先核对 `pg_index.indisvalid`，移除同名无效索引再重跑，不能把 `IF NOT EXISTS` 跳过当作有效索引证据。

## 部署准备

原环境的已知目录是 `/opt/agent-build/shared/postgres` 和 `/opt/agent-build/worker-runtimes/news-collector-active`。部署操作前核实实际 Nginx、systemd、PM2 和 PostgreSQL 运行状态；仓库中的历史容器示例不能代替线上核验。

新应用采用 `/opt/navigate/releases/<release-id>`、`/opt/navigate/current`、`/opt/navigate/shared`。创建无登录的 `navigate` 服务账号，使它能读取 release 与仅含各自凭据的两个配置文件。`content-api.env` 和 `news-collector.env` 建议 `root:navigate 0640`；不得进入 Git、静态 dist、构建日志或前端环境变量。

`ops/navigate-content-api.service` 默认内部端口由模板配置为 5196，与原 API 5180 分开。新 API 使用只读账号，新采集使用仅能写 `news_items` 的账号。示例数据库名为 `navigate`，部署时使用核实后的实际目标。

## 数据库迁移

有两种受支持的切换方式，部署时记录选用方式：

1. 同一 PostgreSQL 实例/库继续承载现有 `news_items`，由 Navigate 接管代码、读取入口和唯一调度。此方式没有复制延迟，旧 Agent 页面可继续只读访问同一数据。保留原数据库数据与备份，不删除旧表。
2. 独立目标库：停止旧采集器、导出、恢复、校验后切换。原库保留，可随时回退。

独立库使用以下步骤。连接凭据使用仅部署账号可读的 `~/.pg_service.conf`、`.pgpass` 或受控环境变量，不将密码放入命令参数。示例 `PGSERVICE` 名称需预先配置为源库或目标库。

```sh
# 先停止旧调度并等待正在运行的旧采集完成。仅操作核实后的实际 owner。
systemctl disable --now news-collector-daily.timer
systemctl is-active news-collector-daily.service
# 如果仍为 active，等待它结束再备份；不要在源库仍写入时比较 checksum。

# 源库只读备份及基线。
umask 077
PGSERVICE=agent-source pg_dump --format=custom --table=public.news_items --file=news-items-before-cutover.dump
PGSERVICE=agent-source psql -X -f database/verify-news.sql > source-news-verification.txt

# 目标库由管理员预建，运行纯 PostgreSQL DDL；无需历史托管平台角色。
PGSERVICE=navigate-admin psql -X -v ON_ERROR_STOP=1 -f database/001-news-items.sql
# 目标 news_items 必须为空；非空时停止，不做覆盖或清空。
PGSERVICE=navigate-admin psql -X -v ON_ERROR_STOP=1 -c 'SELECT count(*) FROM public.news_items;'
PGSERVICE=navigate-admin pg_restore --single-transaction --data-only --no-owner --no-privileges --exit-on-error news-items-before-cutover.dump

# 密码以管理员安全流程设置；不要将密码写入 SQL/Git。
# 两个 LOGIN 角色预建后，仅授权新闻表：
PGSERVICE=navigate-admin psql -X -v reader_role=navigate_readonly -v writer_role=navigate_writer -f database/002-news-access.sql
PGSERVICE=navigate-admin psql -X -f database/verify-news.sql > target-news-verification.txt
diff -u source-news-verification.txt target-news-verification.txt
```

`001-news-items.sql` 用于创建当前完整表结构，不自动升级任意历史旧结构；现有完整数据库无需重放。独立库校验包括总数、唯一身份数、日期/分类分布、正文/译文数和全部可移植载荷 checksum。校验不一致不得切换 writer。导出的 `id`、`external_id`、首次采集时间、正文和译文全部原样恢复，generated `search_text` 由目标 PostgreSQL 自动计算。

## 切换顺序

1. 在新 release 安装依赖，运行 `npm run backend:typecheck`、`npm run backend:test`、`npm run news:smoke`，构建前端。原 `.env` 不进入 release 包。
2. 安装 API service 后启动。通过 loopback 检查列表、日历、真实旧文章详情；`/healthz` 仅表示 HTTP 进程存活，不能代替数据库读取验证。
3. 配置主站新前端及 `/api/content/v1/` Nginx 路由，保留其它项目子路径。`nginx -t` 成功再 reload，公网验证首页、资讯列表、分类、日期分页和旧 ID 详情。
4. 停止旧采集调度并确认旧任务结束；保留备份与源数据。新 API 可先运行，writer 只允许一个。
5. 安装新 service/timer，先手动 `systemctl start navigate-news-collector.service`。查询日志、最新日期与入库数量；确认不是 dry-run，模型开关与旧生产一致。
6. 启用 `systemctl enable --now navigate-news-collector.timer`，用 `systemctl list-timers navigate-news-collector.timer` 确认下一次北京时间 08:00。旧 timer 保持停止；若原 owner 是 PM2，停止对应 PM2 任务而非重复创建第二个 owner。

手动首轮真实采集会访问原有 RSS/原文来源，并按生产开关使用模型与通知。不得以离线 smoke 替代真实写入成功证据。可保留旧 `/agent-build/news/` 到新 `/news/` 的兼容跳转，详情携带相同 `id` 参数。

## 回退

停止新 timer，等待新 collector 退出，再恢复 Nginx 旧首页路由或旧 current symlink。只有确认新 writer 已停止后才恢复旧调度。共用原库无需数据回滚；独立库切换后如产生新数据，先备份目标库，再按 `external_id` 合并新增数据，避免直接恢复旧快照丢失新资讯。保留两个 verification 文件、备份、旧 release、旧配置和迁移时间记录。

