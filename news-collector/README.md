# Navigate AI 资讯采集

本目录从 `songuu/agent` 的新闻子系统迁移，保留 canonical URL 身份、八层生态分类、正文抽取、可选 LLM 富化和中文翻译。`src/data/` 沿用可移植仓库契约；当前生产 writer 只使用 PostgreSQL。`src/notion/` 仅保留共享数据类型和离线测试样本，不启动 Notion 同步。

运行环境为 Node.js 22.18+ 或 24，依赖见仓库根 `backend-dependencies.json`。不要把该文件独立当作 package.json；将其中 scripts、dependencies、devDependencies 合入根包后安装。

```sh
npm run backend:typecheck
npm run backend:test
npm run news:smoke
```

上述 smoke 与回归测试均无需数据库、外网或模型密钥。`news:collect` 和 `news:cron` 读取根 `.env`；部署在 systemd 时直接使用 `EnvironmentFile`，不需要在源码目录保存密钥：

```sh
node --experimental-transform-types news-collector/src/cli-collect.ts
node --experimental-transform-types news-collector/src/cron.ts
```

配置模板见 `ops/news-collector.env.example`。生产必须配置 `CONTENT_REPOSITORY_POSTGRES_ONLY=true`、`CONTENT_REPOSITORY_DRIVER=postgres` 和写入 URL；读 API 使用单独只读凭据。正文与译文分别保存，模型调用开关与限额从原部署迁移，不能把示例关闭值覆盖到生产。

推荐调度为 `ops/navigate-news-collector.timer`，明确指定 `Asia/Shanghai`，每日 08:00 触发一次性 CLI。不要与 `news:cron`、旧 PM2 或旧 timer 并行启用。单源抓取失败会记录报告并继续，其它源可正常入库；只有全部来源失败或管线/数据库异常才返回非零。CLI 成功不等于所有来源都成功，应结合日志检查来源报告。

数据库和任务迁移步骤见 `ops/NEWS-MIGRATION.md`。新闻自然键为 canonical URL SHA-256 前 32 位；重复采集不会新建重复记录，首次 `collected_at/collected_date` 不变，失败重抓不会覆盖已有成功正文或译文。页面日历按采集日期筛选，原发布时间单独显示。

本目录及根 `scripts/content-api`、`src/shared` 中迁入代码沿用上游 MIT 许可，见 `UPSTREAM-LICENSE`。
