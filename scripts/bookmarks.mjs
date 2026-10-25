import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sensitiveKey = /token|secret|password|passwd|api.?key|access.?key|credential|session|authorization|auth|ticket|signature|email|phone|userid|^uid$|^code$|^key$|^sid$|^sig$|^hmac$|^jwt$|^bearer$/i;
const trackingKey = /^(utm_.+|spm|from|ref|source|fbclid|gclid)$/i;
const invisible = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;

export const categories = [
  { id: 'ai', name: 'AI 与智能体', icon: 'sparkles', description: '模型、开发工具与创作灵感' },
  { id: 'dev', name: '开发与架构', icon: 'code', description: '框架文档、系统设计与行业实践' },
  { id: 'community', name: '技术社区与博客', icon: 'messages', description: '开发者交流与值得反复阅读的文章' },
  { id: 'tools', name: '效率与设计', icon: 'wrench', description: '画图、办公与日常效率工具' },
  { id: 'news', name: '资讯与媒体', icon: 'newspaper', description: '新闻、科技动态与播客' },
  { id: 'reading', name: '阅读与图书', icon: 'book', description: '书籍、知识与人文阅读' },
  { id: 'learning', name: '学习与求职', icon: 'graduation', description: '课程、面试与职业成长' },
  { id: 'travel', name: '旅行与生活', icon: 'compass', description: '发现目的地与生活方式' },
  { id: 'shopping', name: '购物与消费', icon: 'bag', description: '购物、品牌与消费服务' },
  { id: 'fun', name: '娱乐与灵感', icon: 'play', description: '影视、艺术、壁纸与有趣的网站' },
  { id: 'private', name: '个人与内网', icon: 'lock', description: '仅保存在本机的账户、工作区与内部服务' },
];

const knownNames = new Map(Object.entries({
  'reddit.com': 'Reddit', 'juejin.im': '掘金', 'linux.do': 'LINUX DO',
  'aihot.virxact.com': 'AI 热点', 'bestblogs.dev': 'BestBlogs', 'nodeseek.com': 'NodeSeek',
  'codepen.io': 'CodePen', 'developer.mozilla.org': 'MDN Web Docs',
  'keepscreenon.com': 'Keep Screen On', 'deepwiki.com': 'DeepWiki', 'revezone.com': 'Revezone',
  'oschina.net': '开源中国', 'segmentfault.com': 'SegmentFault', 'excalidraw.com': 'Excalidraw',
  'infoq.cn': 'InfoQ', 'cyzone.cn': '创业邦', 'tech.meituan.com': '美团技术团队',
  'newsnow.busiyi.world': 'NewsNow 热榜', 'moemail.app': 'MoeMail 临时邮箱',
  'swasnext.console.aliyun.com': '阿里云轻量应用服务器',
}));

// Explicit destinations outrank historical folder names, which often contain
// unrelated saved pages after years of collecting links.
const domainCategories = new Map(Object.entries({
  '30secondsofcode.org': 'dev', 'reactbits.dev': 'dev', 'home-assistant.io': 'dev', 'koolshare.cn': 'dev',
  'back-on-track.eu': 'travel',
  'publicdomainvectors.org': 'tools', 'mermaid.live': 'tools', 'smart-mermaid.aizhi.site': 'tools',
  'json.uiboy.com': 'tools', 'stitch.withgoogle.com': 'tools', 'chongbuluo.com': 'tools',
  'simonwillison.net': 'community',
  'producthunt.com': 'news', 'aihot.virxact.com': 'news', 'news-digest-nine.vercel.app': 'news',
  'informedainews.com': 'news', 'tophub.today': 'news', 'gsmarena.com': 'news',
  'notebookcheck.net': 'news', 'anandtech.com': 'news',
  'gcores.com': 'fun', 'epicgames.com': 'fun', 'ali213.fhyx.hk': 'fun', 'fhyx.hk': 'fun', 'cbaigui.com': 'fun',
  'ebook.huzerui.com': 'reading', 'orzbook.com': 'reading',
}));

const checksum = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
const safeName = (value) => String(value || '').replace(invisible, '').trim();
const has = (text, terms) => terms.some(term => text.includes(term));

/** Inspect every source, including old snapshots: imported flags must never bypass privacy checks. */
export function inspectBookmarkUrl(raw) {
  const reasons = [];
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!['http:', 'https:'].includes(parsed.protocol)) reasons.push('non-public-scheme');
    if (parsed.username || parsed.password) reasons.push('embedded-credentials');
    if (!host || host === 'localhost' || (!host.includes('.') && !isIP(host)) || /\.(local|internal|lan|test)$/.test(host)) reasons.push('local-or-internal-host');
    if (isIP(host)) reasons.push('ip-address');
    if (/^(console|dash|dashboard)\./.test(host) || /\.(console\.aliyun\.com|console\.cloud\.tencent\.com)$/.test(host)
      || ['accounts.google.com', 'myaccount.google.com', 'console.cloud.google.com', 'vercel.com', 'app.netlify.com', 'supabase.com', 'app.supabase.com', 'web.telegram.org', 'mail.google.com', 'outlook.live.com', 'outlook.office.com'].includes(host)) reasons.push('personal-account-or-console');
    if (/\/(admin|wp-admin|phpmyadmin|manage|auth|login|api-?keys?|settings|account)(\/|$)/i.test(parsed.pathname)) reasons.push('management-or-auth-url');
    if (['cloud.siliconflow.cn', 'cloud.siliconflow.com', 'cloud.siliconflow.io'].includes(host)
      || (['platform.moonshot.cn', 'platform.moonshot.ai', 'platform.deepseek.com', 'platform.openai.com'].includes(host) && !/^\/(docs|documentation|api-reference)(\/|$)/i.test(parsed.pathname))) reasons.push('personal-account-or-console');
    if ((host === 'notebooklm.google.com' && parsed.pathname.includes('/notebook/'))
      || (host === 'chat.deepseek.com' && parsed.pathname.includes('/chat/'))
      || (['chatgpt.com', 'chat.openai.com'].includes(host) && /^\/c\//.test(parsed.pathname))
      || (host === 'claude.ai' && /^\/chat\//.test(parsed.pathname))
      || (host === 'gemini.google.com' && /^\/app\/.+/.test(parsed.pathname))
      || (host === 'smith.langchain.com' && parsed.pathname !== '/')
      || (['notion.so', 'www.notion.so', 'railway.app', 'color-muse.tbonesoft.com'].includes(host) && /[a-z0-9_-]{28,}/i.test(parsed.pathname))) reasons.push('personal-workspace');
    if ((host === 'aiaw.app' && /^\/workspaces\//i.test(parsed.pathname))
      || (host.replace(/^www\./, '') === 'ppresume.com' && parsed.pathname !== '/')
      || (host.replace(/^www\./, '') === 'bybit.com' && /\/my-fee-rate(?:\/|$)/i.test(parsed.pathname))) reasons.push('personal-workspace');
    if ((host === 'mermaid.live' && /^#(?:pako|base64|json):/i.test(parsed.hash))
      || (host === 'excalidraw.com' && /^#(?:json|room)=/i.test(parsed.hash))
      || (['app.diagrams.net','draw.io'].includes(host) && /^#[RU]/.test(parsed.hash))) reasons.push('embedded-document');
    if ((host.endsWith('.feishu.cn') && /^\/(base|wiki)\//i.test(parsed.pathname))
      || (host.replace(/^www\./,'') === 'processon.com' && /^\/diagrams(?:\/|$)/i.test(parsed.pathname))
      || (host === 'discord.com' && /^\/channels\//i.test(parsed.pathname))
      || (host === 'pan.baidu.com' && (parsed.searchParams.has('shareid') || /^\/s\//i.test(parsed.pathname)))
      || (host === 'vdisk.weibo.com' && parsed.pathname !== '/')) reasons.push('private-or-unverified-share');
    parsed.username = ''; parsed.password = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (sensitiveKey.test(key)) { reasons.push('sensitive-query'); parsed.searchParams.delete(key); }
      else if (trackingKey.test(key)) parsed.searchParams.delete(key);
    }
    if (sensitiveKey.test(parsed.hash) && /[=/:]/.test(parsed.hash)) { reasons.push('sensitive-fragment'); parsed.hash = ''; }
    return { url: parsed.href, domain: host, private: reasons.length > 0, reasons: [...new Set(reasons)] };
  } catch {
    return { url: '', domain: '', private: true, reasons: ['invalid-url'] };
  }
}

function canonicalUrl(url) {
  try {
    const parsed = new URL(url);
    // A fragment can be a SPA route or a deliberate article anchor. Removing
    // it would silently merge distinct destinations and discard one bookmark.
    parsed.searchParams.sort();
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return parsed.href;
  } catch { return String(url); }
}

export function classifyBookmark(bookmark) {
  const inspected = inspectBookmarkUrl(bookmark.url);
  const folder = (bookmark.folder_path || []).slice(1).join(' / ');
  const text = `${bookmark.name || bookmark.title || ''} ${inspected.domain} ${folder}`.toLowerCase();
  let category;
  if (bookmark.private || inspected.private || /api keys?|账户控制台|订单查询/i.test(bookmark.name || '')) return { category: 'private', group: '账户与内部服务' };
  const domainCategory = domainCategories.get(inspected.domain.replace(/^www\./, ''));
  if (domainCategory) category = domainCategory;
  else if (/^(ai|ai工具)(\s*\/|$)/i.test(folder) || has(text, ['aihot.', 'deepwiki.', 'zread.', 'reclaude.', 'bolt.new', 'manus.im', 'color-muse.', 'news-digest'])) category = 'ai';
  else if (/架构实现|行业案例/.test(folder) || has(text, ['codepen.', 'developer.mozilla.', 'digpangolin.', 'containers', 'matrixmultiplication', 'how to make a cpu', 'npmjs.', 'mithril.', 'bluebirdjs.', 'omijs.'])) category = 'dev';
  else if (/博客相关/.test(folder) || has(text, ['reddit.', 'juejin.', 'linux.do', 'bestblogs.', 'nodeseek.', 'oschina.', 'segmentfault.', 'infoq.', 'tech.meituan.', 'v2ex.', 'toptal.', 'loongnix.', 'aotu.io', 'robertelder.', 'hothardware.'])) category = 'community';
  else if (/工具/.test(folder) || has(text, ['keepscreenon.', 'revezone.', 'excalidraw.', 'moemail.', 'cend.me', 'nona.de', 'devtool.tech', 'mathsolver.'])) category = 'tools';
  else if (/媒体/.test(folder) || has(text, ['newsnow.', 'cyzone.', 'huxiu.', 'hackernews.', 'tech.163.', 'newscientist.', 'xiaoyuzhou', 'laosheng.', 'chedongxi.', 'biliob.', 'planecrashinfo.'])) category = 'news';
  else if (/图书/.test(folder) || has(text, ['ctext.', 'rejoiceblog.', 'wufazhuce.', 'changhai.'])) category = 'reading';
  else if (/面试/.test(folder) || has(text, ['eleduck.', 'digitaling.', 'lib-pku.', 'egghead.'])) category = 'learning';
  else if (/旅游/.test(folder)) category = 'travel';
  else if (/购物/.test(folder) || has(text, ['bybit.', 'ldcstore.'])) category = 'shopping';
  else category = 'fun';
  let group;
  if (category === 'ai') {
    if (has(text, ['mcp', 'agent', 'skill', 'langchain', 'cursor', 'milvus', 'midscene', 'weknora', 'harness', 'learn claude', 'openrouter', 'silicon', 'moonshot', 'groq', 'langsmith'])) group = '开发与 Agent';
    else if (has(text, ['图像', '图片', '视频', '绘画', '设计', 'image', 'raphael', 'stitch', 'audio', 'voice', 'mermaid', 'flowchart', 'saas landing', 'react bits', 'robo', 'replit'])) group = '创作与设计';
    else if (has(text, ['news', '资讯', 'hot.', '研究', 'research', 'hugging', '魔搭', 'year in llm', '应用开发体系'])) group = '研究与资讯';
    else group = '模型与效率';
  } else {
    const groups = {
      dev: /行业案例/.test(folder) ? '行业案例' : /架构实现/.test(folder) ? '架构实践' : '开发文档与工具',
      community: /博客相关/.test(folder) ? '技术博客' : '开发者社区',
      tools: '日常工具', news: '新闻与播客', reading: '图书与知识',
      learning: /面试/.test(folder) ? '面试准备' : '课程与职业', travel: '旅行发现',
      shopping: '品牌与服务', fun: '影视与灵感',
    };
    group = groups[category];
  }
  return { category, group };
}

function selectedRoots(source, profile) {
  if (source.roots && typeof source.roots === 'object') return source.roots;
  if (Array.isArray(source.profiles)) {
    const selected = profile ? source.profiles.find(item => item.profile === profile) : source.profiles[0];
    if (selected?.roots) return selected.roots;
    throw new Error(`书签快照中找不到 profile: ${profile || '(first)'}`);
  }
  throw new Error('书签源必须为 Chrome Bookmarks JSON 或带 profiles 的快照');
}

function flattenRoots(roots) {
  const result = [];
  function visit(node, trail) {
    if (node.type === 'url') result.push({ ...node, folder_path: node.folder_path || trail });
    else if (node.type === 'folder') for (const child of node.children || []) visit(child, [...trail, node.name || '']);
  }
  for (const root of Object.values(roots)) visit(root, []);
  return result;
}

function catalogFromLinks(links, stats, generatedAt) {
  return {
    version: 1, generatedAt, total: links.length, stats,
    categories: categories.filter(category => links.some(link => link.category === category.id)).map(category => ({
      ...category, count: links.filter(link => link.category === category.id).length,
      groups: [...new Set(links.filter(link => link.category === category.id).map(link => link.group))].map(name => ({
        id: checksum(`${category.id}:${name}`).slice(0, 10), name,
        links: links.filter(link => link.category === category.id && link.group === name),
      })),
    })),
    links,
  };
}

export function buildCatalog(source, { profile, generatedAt = new Date().toISOString() } = {}) {
  const records = flattenRoots(selectedRoots(source, profile));
  const publicLinks = new Map(); const privateLinks = new Map();
  for (const record of records) {
    const inspected = inspectBookmarkUrl(record.url);
    const classified = classifyBookmark(record);
    const isPrivate = classified.category === 'private';
    const key = canonicalUrl(isPrivate ? record.url : inspected.url);
    const target = isPrivate ? privateLinks : publicLinks;
    const existing = target.get(key);
    if (existing) { existing.sourceIds.push(String(record.id || '')); continue; }
    const title = safeName(record.display_name || record.name) || knownNames.get(inspected.domain.replace(/^www\./, '')) || inspected.domain || '本地书签';
    target.set(key, {
      id: checksum(key).slice(0, 12), title, url: isPrivate ? record.url : inspected.url,
      domain: inspected.domain, category: classified.category, group: classified.group,
      tags: [classified.group], public: !isPrivate, sourceIds: [String(record.id || '')],
      ...(isPrivate ? { private: true, privateReasons: [...new Set([...(record.private_reasons || []), ...inspected.reasons])] } : {}),
    });
  }
  const stats = { sourceTotal: records.length, uniqueTotal: publicLinks.size + privateLinks.size, publicTotal: publicLinks.size, privateTotal: privateLinks.size, duplicates: records.length - publicLinks.size - privateLinks.size };
  return {
    publicCatalog: catalogFromLinks([...publicLinks.values()], stats, generatedAt),
    privateCatalog: catalogFromLinks([...privateLinks.values()], stats, generatedAt),
  };
}

/** Chromium hashes id (UTF-8), name (UTF-16LE), type and URL in permanent-root order. */
export function chromeChecksums(source) {
  const hashes = { md5: createHash('md5'), sha256: createHash('sha256') };
  const update = (value, encoding = 'utf8') => { for (const hash of Object.values(hashes)) hash.update(Buffer.from(String(value), encoding)); };
  function visit(node) {
    update(node.id); update(node.name || '', 'utf16le'); update(node.type);
    if (node.type === 'url') update(node.url || '');
    else for (const child of node.children || []) visit(child);
  }
  for (const key of ['bookmark_bar', 'other', 'synced']) if (source.roots[key]) visit(source.roots[key]);
  return Object.fromEntries(Object.entries(hashes).map(([key, hash]) => [key, hash.digest('hex')]));
}

export function buildOrganizedChrome(source) {
  if (!source.roots?.bookmark_bar) throw new Error('整理 Chrome 需要原始 Bookmarks 文件，不能使用脱敏快照');
  const result = structuredClone(source);
  const allNodes = [];
  const visit = (node) => { allNodes.push(node); for (const child of node.children || []) visit(child); };
  Object.values(result.roots).forEach(visit);
  let nextId = allNodes.reduce((max, node) => Math.max(max, Number(node.id) || 0), 0) + 1;
  const date = String(BigInt(Date.now()) * 1000n + 11644473600000000n);
  const makeFolder = (name, children) => ({ id: String(nextId++), name, type: 'folder', guid: randomUUID(), date_added: date, date_modified: date, children });
  const originalRecords = flattenRoots({ bookmark_bar: source.roots.bookmark_bar });
  const grouped = new Map();
  for (const record of originalRecords) {
    const classified = classifyBookmark(record);
    if (!grouped.has(classified.category)) grouped.set(classified.category, new Map());
    const groups = grouped.get(classified.category);
    if (!groups.has(classified.group)) groups.set(classified.group, []);
    // Move copies of the original nodes so credentials, sync IDs and duplicate links survive unchanged.
    const { folder_path, ...node } = record;
    groups.get(classified.group).push(node);
  }
  result.roots.bookmark_bar.children = categories.filter(category => grouped.has(category.id)).map(category => makeFolder(category.name,
    [...grouped.get(category.id)].map(([name, links]) => makeFolder(name, links))));
  result.roots.bookmark_bar.date_modified = date;
  const hashes = chromeChecksums(result); result.checksum = hashes.md5;
  if ('checksum_sha256' in result) result.checksum_sha256 = hashes.sha256;
  if (flattenRoots(result.roots).length !== flattenRoots(source.roots).length) throw new Error('整理后的链接数量变化，已拒绝保存');
  return result;
}

const escapeHtml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

export function exportBookmarksHtml(source, { includePrivate = false, profile } = {}) {
  const roots = selectedRoots(source, profile);
  const records = flattenRoots(roots).filter(record => includePrivate || classifyBookmark(record).category !== 'private');
  const lines = ['<!DOCTYPE NETSCAPE-Bookmark-file-1>', '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">', '<TITLE>Songuu 整理书签</TITLE>', '<H1>Songuu 整理书签</H1>', '<DL><p>'];
  for (const category of categories) {
    const selected = records.filter(record => classifyBookmark(record).category === category.id);
    if (!selected.length) continue;
    lines.push(`<DT><H3>${escapeHtml(category.name)}</H3>`, '<DL><p>');
    for (const group of [...new Set(selected.map(record => classifyBookmark(record).group))]) {
      lines.push(`<DT><H3>${escapeHtml(group)}</H3>`, '<DL><p>');
      for (const record of selected.filter(item => classifyBookmark(item).group === group)) {
        const inspected = inspectBookmarkUrl(record.url);
        const title = safeName(record.display_name || record.name) || knownNames.get(inspected.domain.replace(/^www\./, '')) || inspected.domain || '本地书签';
        lines.push(`<DT><A HREF="${escapeHtml(includePrivate ? record.url : inspected.url)}">${escapeHtml(title)}</A>`);
      }
      lines.push('</DL><p>');
    }
    lines.push('</DL><p>');
  }
  return `${lines.join('\n')}\n</DL><p>\n`;
}

async function readJson(filename) {
  try { return JSON.parse((await readFile(filename, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { throw new Error(`读取书签 JSON 失败: ${filename}`, { cause: error }); }
}

async function writeJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export async function createChromePlan(sourceFile) {
  const sourcePath = path.resolve(sourceFile);
  const original = await readFile(sourcePath);
  const source = JSON.parse(original.toString('utf8').replace(/^\uFEFF/, ''));
  const organized = buildOrganizedChrome(source);
  return { version: 1, createdAt: new Date().toISOString(), sourcePath, sourceSha256: checksum(original), linkCount: flattenRoots(source.roots).length, organized };
}

async function chromeRunning() {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await run('tasklist.exe', ['/FI', 'IMAGENAME eq chrome.exe', '/FO', 'CSV', '/NH'], { windowsHide: true });
      return /"chrome\.exe"/i.test(stdout);
    }
    const { stdout } = await run('pgrep', ['-x', 'chrome']); return Boolean(stdout.trim());
  } catch (error) {
    if (process.platform !== 'win32' && error.code === 1) return false;
    throw new Error('无法确认 Chrome 是否已关闭，拒绝修改书签', { cause: error });
  }
}

async function assertChromeClosed(isChromeRunning) {
  if (await isChromeRunning()) throw new Error('Chrome 正在运行，请先完全关闭 Chrome 再应用或恢复书签');
}

async function replaceWithBackup(sourceFile, content, backupDir, expectedSha256, isChromeRunning) {
  await assertChromeClosed(isChromeRunning);
  const original = await readFile(sourceFile);
  if (expectedSha256 && checksum(original) !== expectedSha256) throw new Error('Bookmarks changed / 计划后书签源文件发生变化，请重新生成 plan');
  await mkdir(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, `Bookmarks-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
  await writeFile(backupFile, original, { flag: 'wx', mode: 0o600 });
  if (checksum(await readFile(backupFile)) !== checksum(original)) throw new Error('书签备份校验失败，拒绝修改');
  const temporary = path.join(path.dirname(sourceFile), `.Bookmarks-navigate-${randomUUID()}.tmp`);
  await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
  // Recheck immediately before replacement: Chrome Sync must not race the offline edit.
  await assertChromeClosed(isChromeRunning);
  if (checksum(await readFile(sourceFile)) !== checksum(original)) throw new Error('Bookmarks changed / 保存前书签发生变化，已保留备份并停止');
  await rename(temporary, sourceFile);
  if (checksum(await readFile(sourceFile)) !== checksum(content)) throw new Error(`书签写入校验失败，可用备份恢复: ${backupFile}`);
  return { sourceFile, backupFile, sha256: checksum(content) };
}

export async function applyChromePlan(plan, { backupDir = path.join(projectRoot, '.local', 'chrome-backups'), isChromeRunning = chromeRunning } = {}) {
  if (plan.version !== 1 || !plan.sourcePath || !plan.sourceSha256 || !plan.organized?.roots) throw new Error('无效的 Chrome 书签计划');
  if (flattenRoots(plan.organized.roots).length !== plan.linkCount) throw new Error('书签计划链接数量校验失败');
  const hashes = chromeChecksums(plan.organized);
  if (hashes.md5 !== plan.organized.checksum) throw new Error('书签计划 checksum 校验失败');
  const originalBytes = await readFile(plan.sourcePath);
  if (checksum(originalBytes) !== plan.sourceSha256) throw new Error('Bookmarks changed / 计划后书签源文件发生变化，请重新生成 plan');
  const original = JSON.parse(originalBytes.toString('utf8').replace(/^\uFEFF/, ''));
  const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  const fingerprints = (roots) => flattenRoots(roots).map(({ folder_path, ...leaf }) => checksum(JSON.stringify(stable(leaf)))).sort().join('\n');
  if (fingerprints(original.roots) !== fingerprints(plan.organized.roots)) throw new Error('计划未完整保留原始链接和 metadata，拒绝应用');
  for (const root of ['other', 'synced']) {
    if (JSON.stringify(original.roots[root]) !== JSON.stringify(plan.organized.roots[root])) throw new Error('计划修改了其他书签或移动书签，拒绝应用');
  }
  return replaceWithBackup(plan.sourcePath, Buffer.from(`${JSON.stringify(plan.organized, null, 3)}\n`), backupDir, plan.sourceSha256, isChromeRunning);
}

export async function restoreChromeBackup(sourceFile, backupFile, { backupDir = path.join(projectRoot, '.local', 'chrome-backups'), isChromeRunning = chromeRunning } = {}) {
  const backup = await readFile(backupFile);
  const parsed = JSON.parse(backup.toString('utf8').replace(/^\uFEFF/, ''));
  if (!parsed.roots?.bookmark_bar || parsed.version !== 1) throw new Error('备份不是有效的 Chrome Bookmarks 文件');
  return replaceWithBackup(path.resolve(sourceFile), backup, backupDir, null, isChromeRunning);
}

function argumentsFrom(argv) {
  const result = { command: argv[0] || 'help' };
  for (let index = 1; index < argv.length; index++) {
    if (!argv[index].startsWith('--') || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`参数需要值: ${argv[index]}`);
    result[argv[index].slice(2)] = argv[++index];
  }
  return result;
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  if (options.command === 'help') {
    console.log('export --source <Chrome Bookmarks 或快照> [--out public/data/bookmarks.json] [--private-out .local/private-bookmarks.json] [--html-out .local/bookmarks-organized.html] [--profile Default]\nplan --source <原始 Chrome Bookmarks> [--out .local/chrome-bookmarks.plan.json]\napply --plan <plan JSON> [--backup-dir .local/chrome-backups]\nrestore --source <Chrome Bookmarks> --backup <备份 JSON> [--backup-dir .local/chrome-backups]\nexport/plan 只读原始书签；apply/restore 仅在 Chrome 完全关闭时修改，并先创建可校验的完整备份。主页与启动页请通过 Chrome 设置界面设置为 https://songuu.top/。');
    return;
  }
  if (options.command === 'export') {
    if (!options.source) throw new Error('export 需要 --source');
    const source = await readJson(options.source);
    const result = buildCatalog(source, { profile: options.profile });
    const output = path.resolve(options.out || path.join(projectRoot, 'public/data/bookmarks.json'));
    const privateOutput = path.resolve(options['private-out'] || path.join(projectRoot, '.local/private-bookmarks.json'));
    const htmlOutput = path.resolve(options['html-out'] || path.join(projectRoot, '.local/bookmarks-organized.html'));
    await writeJson(output, result.publicCatalog);
    await writeJson(privateOutput, result.privateCatalog);
    await mkdir(path.dirname(htmlOutput), { recursive: true });
    await writeFile(htmlOutput, exportBookmarksHtml(source, { includePrivate: true, profile: options.profile }), { mode: 0o600 });
    console.log(JSON.stringify({ ...result.publicCatalog.stats, publicOutput: output, privateOutput, htmlOutput }));
  } else if (options.command === 'plan') {
    if (!options.source) throw new Error('plan 需要 --source');
    const plan = await createChromePlan(options.source);
    const output = path.resolve(options.out || path.join(projectRoot, '.local/chrome-bookmarks.plan.json'));
    await writeJson(output, plan);
    console.log(JSON.stringify({ planFile: output, linkCount: plan.linkCount, sourceSha256: plan.sourceSha256 }));
  } else if (options.command === 'apply') {
    if (!options.plan) throw new Error('apply 需要 --plan');
    console.log(JSON.stringify(await applyChromePlan(await readJson(options.plan), { backupDir: options['backup-dir'] })));
  } else if (options.command === 'restore') {
    if (!options.source || !options.backup) throw new Error('restore 需要 --source 和 --backup');
    console.log(JSON.stringify(await restoreChromeBackup(options.source, options.backup, { backupDir: options['backup-dir'] })));
  } else throw new Error(`未知命令: ${options.command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`书签操作失败: ${error.message}`); process.exitCode = 1; });
}
