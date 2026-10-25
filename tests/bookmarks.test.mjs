import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildCatalog, buildOrganizedChrome, chromeChecksums, classifyBookmark,
  exportBookmarksHtml, inspectBookmarkUrl, applyChromePlan, createChromePlan,
  restoreChromeBackup,
} from '../scripts/bookmarks.mjs';

const leaf = (id, name, url) => ({ id: String(id), name, type: 'url', url, guid: `leaf-${id}`, date_added: '123' });
const folder = (id, name, children = []) => ({ id: String(id), name, type: 'folder', children, guid: `folder-${id}`, date_added: '123' });
const source = (children) => ({ version: 1, roots: { bookmark_bar: folder(1, '书签栏', children), other: folder(2, '其他书签'), synced: folder(3, '移动书签') } });

test('编辑器内嵌文档和协作房间只保留在本机，普通页面锚点仍公开',()=>{
  for(const url of ['https://mermaid.live/edit#pako:synthetic-document','https://excalidraw.com/#json=synthetic-document','https://excalidraw.com/#room=synthetic-room','https://app.diagrams.net/#Rsynthetic-document'])assert.equal(inspectBookmarkUrl(url).private,true);
  assert.equal(inspectBookmarkUrl('https://example.com/article#section-two').private,false);
});
test('个人工作区和未知分享文件不进入公开导航',()=>{
  for(const url of ['https://example.feishu.cn/base/synthetic-id?table=example','https://example.feishu.cn/wiki/synthetic-id','https://www.processon.com/diagrams','https://discord.com/channels/123/456','https://pan.baidu.com/share/link?shareid=123&uk=456','https://vdisk.weibo.com/s/synthetic'])assert.equal(inspectBookmarkUrl(url).private,true);
  assert.equal(inspectBookmarkUrl('https://open.feishu.cn/document/').private,false);
});

test('AI 两个旧目录合并分类，保留有业务意义的子组', () => {
  assert.equal(classifyBookmark({ name: 'LangChain', url: 'https://www.langchain.com/', folder_path: ['书签栏', 'ai工具'] }).category, 'ai');
  assert.equal(classifyBookmark({ name: '模型研究', url: 'https://example.com/research', folder_path: ['书签栏', 'ai'] }).category, 'ai');
  assert.equal(classifyBookmark({ name: 'MCP Servers', url: 'https://mcp.so/', folder_path: ['书签栏', 'ai'] }).group, '开发与 Agent');
  assert.equal(classifyBookmark({ name: 'Raphael 图像生成', url: 'https://raphael.app/', folder_path: ['书签栏', 'ai工具'] }).group, '创作与设计');
});

test('公开目录阻断内网、凭据、个人控制台和 API 密钥链接', () => {
  const links = [
    leaf(10, '公开网站', 'https://example.com/'),
    leaf(11, '内网', 'http://172.16.10.12/'),
    leaf(12, 'localhost', 'http://localhost:3000/'),
    leaf(13, '订单', 'https://shop.example/order?token=private-value'),
    leaf(14, '凭据', 'https://user:pass@example.com/'),
    leaf(15, 'API Keys', 'https://console.groq.com/keys'),
    leaf(16, '云服务器', 'https://swasnext.console.aliyun.com/'),
    leaf(17, '笔记', 'https://notebooklm.google.com/notebook/12345678-abcd-1234-abcd-123456789abc'),
    leaf(18, '脚本', 'javascript:alert(1)'),
  ];
  const result = buildCatalog(source(links));
  assert.equal(result.publicCatalog.total, 1);
  assert.equal(result.privateCatalog.total, 8);
  assert.equal(JSON.stringify(result.publicCatalog).includes('private-value'), false);
  assert.equal(JSON.stringify(result.publicCatalog).includes('172.16'), false);
  assert.equal(JSON.stringify(result.publicCatalog).includes('user:pass'), false);
  assert.equal(result.publicCatalog.links[0].public, true);
});

test('带查询凭据的 URL 脱敏，公开文章长 slug 不误判私有', () => {
  const inspected = inspectBookmarkUrl('https://example.com/?api_key=secret&utm_source=mail&page=2');
  assert.equal(inspected.private, true);
  assert.equal(inspected.url, 'https://example.com/?page=2');
  assert.equal(inspectBookmarkUrl('https://aws.amazon.com/blogs/machine-learning/shared-infrastructure-isolated-tenants-pool-model-multi-tenancy/').private, false);
});

test('会话与签名别名、个人对话和模型控制台不进入公开目录', () => {
  for (const url of [
    'https://example.com/?sid=synthetic-secret',
    'https://example.com/?sig=synthetic-secret',
    'https://chatgpt.com/c/12345678-abcd-1234-abcd-123456789abc',
    'https://claude.ai/chat/12345678-abcd-1234-abcd-123456789abc',
    'https://cloud.siliconflow.cn/me/account/ak',
    'https://platform.moonshot.ai/console/account',
  ]) assert.equal(inspectBookmarkUrl(url).private, true);
  assert.equal(inspectBookmarkUrl('https://cloud.tencent.com/developer/article/123456').private, false);
  assert.equal(inspectBookmarkUrl('https://platform.openai.com/docs/overview').private, false);
});

test('个人工作区对话、简历页面和账户费率不公开', () => {
  for (const url of ['https://aiaw.app/workspaces/example/dialogs/synthetic-id', 'https://ppresume.com/example/test', 'https://www.bybit.com/en/my-fee-rate']) {
    assert.equal(inspectBookmarkUrl(url).private, true);
  }
  assert.equal(inspectBookmarkUrl('https://aiaw.app/').private, false);
  assert.equal(inspectBookmarkUrl('https://ppresume.com/').private, false);
});

test('明确站点用途优先于旧 AI 和购物文件夹', () => {
  const cases = {
    dev: ['30secondsofcode.org', 'reactbits.dev', 'www.home-assistant.io', 'koolshare.cn'],
    travel: ['back-on-track.eu'],
    tools: ['publicdomainvectors.org', 'mermaid.live', 'json.uiboy.com', 'stitch.withgoogle.com', 'www.chongbuluo.com'],
    community: ['simonwillison.net'],
    news: ['www.producthunt.com', 'aihot.virxact.com', 'news-digest-nine.vercel.app', 'informedainews.com', 'tophub.today', 'www.gsmarena.com', 'www.notebookcheck.net', 'www.anandtech.com'],
    fun: ['www.gcores.com', 'www.epicgames.com', 'ali213.fhyx.hk', 'www.cbaigui.com'],
    reading: ['ebook.huzerui.com', 'orzbook.com'],
  };
  for (const [category, hosts] of Object.entries(cases)) for (const host of hosts) {
    assert.equal(classifyBookmark({name:'旧书签',url:`https://${host}/`,folder_path:['书签栏','ai']}).category, category, host);
    assert.equal(classifyBookmark({name:'旧书签',url:`https://${host}/`,folder_path:['书签栏','购物']}).category, category, host);
  }
});

test('去重忽略追踪参数和末尾斜杠，同时保留全部来源 ID', () => {
  const result = buildCatalog(source([
    leaf(10, '示例', 'https://example.com/docs/?utm_source=test'),
    leaf(11, '示例副本', 'https://example.com/docs'),
    leaf(12, '第二网站', 'https://other.example/'),
  ]));
  assert.equal(result.publicCatalog.total, 2);
  assert.equal(result.publicCatalog.stats.sourceTotal, 3);
  assert.equal(result.publicCatalog.stats.duplicates, 1);
  assert.deepEqual(result.publicCatalog.links[0].sourceIds, ['10', '11']);
});

test('去重保留不同 hash 路由及文章锚点，不能合并不同目的地', () => {
  const urls = ['https://example.com/#/a', 'https://example.com/#/b', 'https://example.com/#!a', 'https://example.com/#!b', 'https://example.com/docs#first', 'https://example.com/docs#second'];
  const result = buildCatalog(source(urls.map((url, index) => leaf(20 + index, `目的地 ${index}`, url))));
  assert.equal(result.publicCatalog.total, urls.length);
  assert.deepEqual(result.publicCatalog.links.map(link => link.url), urls);
  assert.equal(result.publicCatalog.stats.duplicates, 0);
});

test('匿名根书签补齐可读名称，并清除不可见控制字符', () => {
  const result = buildCatalog(source([leaf(10, '', 'https://developer.mozilla.org/'), leaf(11, '\u200b示例\u202e', 'https://example.com/')]));
  assert.equal(result.publicCatalog.links[0].title, 'MDN Web Docs');
  assert.equal(result.publicCatalog.links[1].title, '示例');
});

test('Chrome 归类保留每个原始链接、重复项和元数据，且不改源对象', () => {
  const original = source([folder(10, 'ai工具', [leaf(11, 'MCP', 'https://mcp.so/')]), leaf(12, '重复', 'https://mcp.so/'), leaf(13, '私有', 'https://example.com/?token=secret')]);
  const before = JSON.stringify(original);
  const organized = buildOrganizedChrome(original);
  assert.equal(JSON.stringify(original), before);
  const all = (n) => n.type === 'url' ? [n] : (n.children || []).flatMap(all);
  const leaves = Object.values(organized.roots).flatMap(all);
  assert.equal(leaves.length, 3);
  assert.deepEqual(leaves.map(n => n.id).sort(), ['11', '12', '13']);
  assert.equal(leaves.find(n => n.id === '13').url, 'https://example.com/?token=secret');
  assert.equal(leaves.find(n => n.id === '11').guid, 'leaf-11');
  assert.equal(organized.checksum, chromeChecksums(organized).md5);
});

test('HTML 导出转义注入字符，私有导出只在明确要求时包含原始链接', () => {
  const input = source([leaf(10, '<img onerror=alert(1)>', 'https://example.com/?a=1&b=2'), leaf(11, '内网', 'http://localhost/')]);
  const html = exportBookmarksHtml(input);
  assert.match(html, /&lt;img onerror=alert\(1\)&gt;/);
  assert.equal(html.includes('http://localhost/'), false);
  assert.equal(exportBookmarksHtml(input, { includePrivate: true }).includes('http://localhost/'), true);
});

test('apply 拒绝运行中的 Chrome，也拒绝计划后源文件被改动', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'navigate-bookmarks-'));
  const file = path.join(dir, 'Bookmarks');
  await writeFile(file, JSON.stringify(source([leaf(10, '示例', 'https://example.com/')])));
  const plan = await createChromePlan(file);
  await assert.rejects(applyChromePlan(plan, { backupDir: path.join(dir, 'backups'), isChromeRunning: async () => true }), /Chrome/);
  await writeFile(file, JSON.stringify(source([leaf(10, '新变化', 'https://example.com/')])));
  await assert.rejects(applyChromePlan(plan, { backupDir: path.join(dir, 'backups'), isChromeRunning: async () => false }), /changed|变化/);
});

test('apply 创建字节一致备份，restore 可回到原文件', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'navigate-bookmarks-'));
  const file = path.join(dir, 'Bookmarks');
  const original = JSON.stringify(source([leaf(10, '示例', 'https://example.com/')]), null, 2);
  await writeFile(file, original);
  const plan = await createChromePlan(file);
  const options = { backupDir: path.join(dir, 'backups'), isChromeRunning: async () => false };
  const result = await applyChromePlan(plan, options);
  assert.equal(await readFile(result.backupFile, 'utf8'), original);
  assert.notEqual(await readFile(file, 'utf8'), original);
  await restoreChromeBackup(file, result.backupFile, options);
  assert.equal(await readFile(file, 'utf8'), original);
});

test('apply 拒绝数量相同但链接或元数据被篡改的计划', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'navigate-bookmarks-'));
  const file = path.join(dir, 'Bookmarks');
  await writeFile(file, JSON.stringify(source([leaf(10, '示例', 'https://example.com/')])));
  const plan = await createChromePlan(file);
  plan.organized.roots.bookmark_bar.children[0].children[0].children[0].url = 'https://replacement.example/';
  plan.organized.checksum = chromeChecksums(plan.organized).md5;
  await assert.rejects(applyChromePlan(plan, { backupDir: path.join(dir, 'backups'), isChromeRunning: async () => false }), /原始链接|metadata/);
});

test('apply 拒绝修改其他书签根目录的计划', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'navigate-bookmarks-'));
  const file = path.join(dir, 'Bookmarks');
  await writeFile(file, JSON.stringify(source([leaf(10, '示例', 'https://example.com/')])));
  const plan = await createChromePlan(file);
  plan.organized.roots.other.name = '不应更改';
  plan.organized.checksum = chromeChecksums(plan.organized).md5;
  await assert.rejects(applyChromePlan(plan, { backupDir: path.join(dir, 'backups'), isChromeRunning: async () => false }), /其他书签/);
});
