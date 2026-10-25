# Songuu 导航

导航首页、Chrome 书签分类和 AI 资讯归档。前端使用 Vite 与原生 ES modules，资讯使用独立只读 Content API、PostgreSQL 和 systemd 每日采集任务。

## 使用

- 首页：`https://songuu.top/`
- AI 资讯：`https://songuu.top/news/`，支持分类、采集日期、已加载内容搜索、分页、双语正文及来源。
- 在线工具：`https://songuu.top/tools/`，可搜索的 8 类工具目录，含 39 个站内工具与 52 个明确标注的参考站外部入口。支持工具收藏、最近使用及 `?tool=<id>` 深链接。
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

## 在线工具

工具目录参考 [卡卡轻导航](https://kaka770.cn/tools) 的分类和功能选择；站内工具独立实现，未复制其代码、图像或品牌素材。`src/tools-catalogue.js` 管理参考目录与本地映射，`src/tools-core.js` 提供纯转换逻辑，`src/tools-media*.js` 处理本机文件，`src/tools-browser.js` 提供二维码、文档预览、便笺和时钟等浏览器交互。

- 开发与转换：JSON、URL、Base64、Unicode、HTML 实体、进制、时间戳、日期、字节数、UUID、SHA、JWT、随机数与密码、文本对比、cURL / Docker / 端口检查命令、Cron、ASCII 和 HTTP 状态码。
- 图片与文件：图片格式转换、压缩、像素画、透明边裁剪、九宫格 ZIP、长图拼接、ZIP 解压、Markdown 预览 / HTML 导出 / 浏览器打印 PDF、本机便笺。
- 日常工具：屏幕取色、颜色格式换算、世界时钟、秒表 / 倒计时、随机菜单、环境检测、浏览器文字朗读。

文件和文本均在浏览器处理，不上传至本站。Markdown 仅允许文档排版元素，禁止自动加载外部图像和资源。语音由系统或浏览器提供，部分音色可能使用系统在线服务。外部工具会打开原站，其功能与可用性由原站提供；它们并非已迁移的本站服务。

文件处理有大小与像素上限，具体以工作台提示为准。图片输入支持 PNG / JPEG / WebP / GIF / BMP，GIF 仅处理首帧，动画 PNG / WebP 不支持，输出为 PNG / JPEG / WebP；拼图不自动消除重叠；音频输入支持结构完整的 MP3 / WAV，仅裁剪并输出 PCM WAV；ZIP 只支持普通、未加密的 Store / Deflate 压缩包，并校验 CRC32。命令生成器仅输出文本，不执行命令，cURL / Docker 默认生成 POSIX shell 语法。JWT 解码不验证签名。

纯前端发布只追加新哈希资源并原子替换首页，保留旧资源以支持回退，不运行数据库迁移或修改资讯定时器。新增依赖只用于前端构建，部署静态文件无需变更在线 API 运行环境。
