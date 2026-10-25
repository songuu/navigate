# Songuu 导航

导航首页、Chrome 书签分类和 AI 资讯归档。前端使用 Vite 与原生 ES modules，资讯使用独立只读 Content API、PostgreSQL 和 systemd 每日采集任务。

## 使用

- 首页：`https://songuu.top/`
- AI 资讯：`https://songuu.top/news/`，支持分类、采集日期、已加载内容搜索、分页、双语正文及来源。
- 在线工具：`https://songuu.top/tools/`，JSON、URL 编解码、时间戳、文本统计与 UUID，内容只在浏览器处理。
- 收藏、自定义书签、排序与主题保存在当前浏览器；设置中可备份和恢复。公开书签数据位于 `public/data/bookmarks.json`。个人会话、账户控制台和内网链接只导出到忽略的 `.local/`。
- 原来主域名的八个应用保留原路径。原 `/agent-build/news/` 跳到新资讯入口；旧新闻 API 继续兼容，其他 Agent Build 内容 API 不变。

## 开发与验证

要求 Node 22.18+。

```sh
npm ci
npm test
npm run backend:typecheck
npm run backend:test
npm run news:smoke
npm run build
npm run dev
```

开发代理默认连接 `127.0.0.1:5198`；可通过 `CONTENT_PREVIEW_TARGET` 指定自己的只读资讯服务。开发机用 `ssh -N -L 127.0.0.1:5198:127.0.0.1:5196 Aliyun-Claw` 转发生产只读 API。

## 书签整理

本项目只读取 Chrome 书签，将分类结果呈现在网页中。当前任务不修改 Chrome 书签栏；首页地址由用户在 Chrome 设置中指定。

```sh
node scripts/bookmarks.mjs export --source '<Chrome Bookmarks 文件>'
```

公开目录合并重复，功能性 URL hash 保留；内嵌文档、个人工作区和未知分享文件保留在本机导出中。设置面板可导入本机 JSON 到“本机私藏”。已确认返回 404 的原链接保留并标为“待修复”，超时或被拦截不当作失效。不要提交原始书签、`.local/`、环境文件或数据库备份。

## 部署与迁移

现有服务器使用 `/opt/navigate/releases/<release>`，通过 `/opt/navigate/current` 原子切换；只读服务绑定 `127.0.0.1:5196`。新闻独立数据库为现有本机 PostgreSQL 容器内的 `navigate`，专用 reader/writer 角色，凭据仅位于服务器 `/opt/navigate/shared/*.env`。

1. 运行测试和构建，打包源码、锁文件与 `dist/`，排除私有文件、Git 与 node_modules。
2. 上传包到现有服务器，执行 `bash ops/deploy.sh /tmp/navigate-RELEASE.tar.gz RELEASE`（可先把 `ops/` 从包解压到暂存目录）。
3. 部署脚本备份旧首页、Nginx 和新闻全表；停用旧定时器；新建独立数据库；复制所有新闻并比较总数、分类日期桶及全内容 checksum；通过真实新闻 API 后才切 Nginx。未知既有目标库会被拒绝。
4. 首次切换后执行 `systemctl start --no-block navigate-news-collector.service`；检查其成功报告和真实写入，再 `systemctl enable --now navigate-news-collector.timer`。每日北京时间 08:00 自动运行；只保留新定时器一个 owner。

部署失败会恢复旧 Nginx、当前版本和原定时任务；新库和备份保留供核查。首轮新采集已写入后若需要业务回退，先备份并同步新增新闻再恢复旧 writer，避免丢失新采集记录。后续代码版本部署沿用同一个新库。

更多数据契约与迁移核对见 `ops/NEWS-MIGRATION.md`。生产环境值继承原采集程序的模型、翻译与通知设置，不使用示例值覆盖。
