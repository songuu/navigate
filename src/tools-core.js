const MAX_TEXT_LENGTH = 1_000_000;
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal:true});

function inputText(input, limit = MAX_TEXT_LENGTH) {
  const value = String(input ?? '');
  if (value.length > limit) throw new Error(`输入过长，最多支持 ${limit.toLocaleString('zh-CN')} 个字符。`);
  return value;
}

function integer(value, fallback, min, max, label) {
  const number = Number(value === undefined || value === '' ? fallback : value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${label}需为 ${min}–${max} 之间的整数。`);
  return number;
}

function withoutControls(value, label) {
  const text = String(value ?? '');
  if (/[\x00-\x1f\x7f]/.test(text)) throw new Error(`${label}不能包含换行或控制字符。`);
  return text;
}

function encodeBase64(value) {
  const bytes = encoder.encode(value);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

function decodeBase64(value, url = false) {
  let encoded = value.replace(/\s/g, '');
  if (url) encoded = encoded.replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1 || (encoded.includes('=') && encoded.length % 4 !== 0)) throw new Error('Base64 格式无效，请检查字符及末尾填充。');
  encoded += '='.repeat((4 - encoded.length % 4) % 4);
  let binary;
  try { binary = atob(encoded); } catch { throw new Error('Base64 格式无效，无法解码。'); }
  try { return decoder.decode(Uint8Array.from(binary, char => char.charCodeAt(0))); }
  catch { throw new Error('Base64 内容不是有效 UTF-8 文本；二进制文件请使用文件处理工具。'); }
}

export function convertBase(input, from = 10, to = 2) {
  const radixFrom = integer(from,10,2,36,'输入进制');
  const radixTo = integer(to,2,2,36,'输出进制');
  const text = inputText(input,4096).trim().toLowerCase();
  if (!/^[+-]?[a-z0-9]+$/.test(text)) throw new Error('请输入有效整数，不支持小数或进制前缀。');
  const negative = text.startsWith('-');
  const magnitude = text.replace(/^[+-]/,'');
  let value = 0n;
  for (const char of magnitude) {
    const digit = DIGITS.indexOf(char);
    if (digit < 0 || digit >= radixFrom) throw new Error(`字符“${char}”不属于 ${radixFrom} 进制。`);
    value = value * BigInt(radixFrom) + BigInt(digit);
  }
  return ((negative ? -value : value).toString(radixTo)).toUpperCase();
}

function parseDateOnly(input) {
  const text = inputText(input,10).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw new Error('日期格式应为 YYYY-MM-DD。');
  const [,year,month,day] = match.map(Number);
  const date = new Date(0);
  date.setUTCHours(0,0,0,0);
  date.setUTCFullYear(year,month - 1,day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new Error('日期不存在，请检查月份、日数及闰年。');
  return date;
}

function timestampResult(input, options) {
  let date;
  if (options.action === 'now') date = new Date();
  else {
    const text = inputText(input,256).trim();
    if (!text) throw new Error('请输入时间戳或日期时间。');
    if (/^-?\d+(?:\.\d+)?$/.test(text)) {
      const value = Number(text);
      const unit = options.unit || 'auto';
      if (!['auto','seconds','milliseconds'].includes(unit)) throw new Error('时间戳单位无效。');
      date = new Date(value * (unit === 'seconds' || (unit === 'auto' && Math.abs(value) < 100_000_000_000) ? 1000 : 1));
    } else {
      if (/^\d{4}-\d{2}-\d{2}/.test(text)) parseDateOnly(text.slice(0,10));
      date = new Date(text);
    }
  }
  if (!Number.isFinite(date.getTime())) throw new Error('时间无效，请输入秒、毫秒或 ISO 日期时间。');
  return `本地时间：${date.toLocaleString('zh-CN')}\nUTC：${date.toISOString()}\n秒：${Math.floor(date.getTime()/1000)}\n毫秒：${date.getTime()}`;
}

export function decodeJwt(input) {
  const token = inputText(input,32_768).trim();
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts.every(part => /^[A-Za-z0-9_-]*$/.test(part))) throw new Error('JWT 应为 Header.Payload.Signature 三段 Base64URL 文本。');
  let header, payload;
  try { header = JSON.parse(decodeBase64(parts[0],true)); payload = JSON.parse(decodeBase64(parts[1],true)); }
  catch (error) { throw new Error(`JWT JSON 解析失败：${error.message}`); }
  if (!header || typeof header !== 'object' || Array.isArray(header) || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('JWT Header 与 Payload 必须是 JSON 对象。');
  return {header,payload,signature:parts[2],verified:false};
}

function jwtResult(input) {
  const decoded = decodeJwt(input);
  const times = {};
  for (const key of ['iat','nbf','exp']) {
    const seconds = decoded.payload[key];
    if (typeof seconds === 'number' && Number.isFinite(seconds)) {
      const date = new Date(seconds * 1000);
      if (Number.isFinite(date.getTime())) times[key] = date.toISOString();
    }
  }
  return `仅解码，未验证签名；内容不能作为身份或权限凭证。\n\n${JSON.stringify({...decoded,timestampsUTC:times},null,2)}`;
}

function randomInteger(min, max) {
  const range = max - min + 1;
  if (range <= 0 || range > 0x1_0000_0000) throw new Error('随机数范围宽度最多为 4,294,967,296。');
  // Rejection sampling avoids the bias caused by modulo on a non-power-of-two range.
  const ceiling = Math.floor(0x1_0000_0000 / range) * range;
  const buffer = new Uint32Array(1);
  do { crypto.getRandomValues(buffer); } while (buffer[0] >= ceiling);
  return min + buffer[0] % range;
}

function randomResult(input, options) {
  if (options.action === 'password') {
    const length = integer(options.length,20,1,1000,'密码长度');
    const alphabets = {
      alphanumeric:'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789',
      digits:'0123456789',
      symbols:'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*()-_=+[]{}:,.?',
    };
    const alphabetKey = options.alphabet || 'alphanumeric';
    if (!Object.hasOwn(alphabets,alphabetKey)) throw new Error('密码字符集无效。');
    const alphabet = alphabets[alphabetKey];
    return Array.from({length},() => alphabet[randomInteger(0,alphabet.length - 1)]).join('');
  }
  const min = integer(options.min,1,-2_147_483_648,2_147_483_647,'最小值');
  const max = integer(options.max,100,-2_147_483_648,2_147_483_647,'最大值');
  if (min > max) throw new Error('最小值不能大于最大值。');
  const quantity = integer(options.quantity,1,1,1000,'随机数数量');
  return Array.from({length:quantity},() => randomInteger(min,max)).join('\n');
}

const BYTE_UNITS = {B:1,KB:1000,MB:1000**2,GB:1000**3,TB:1000**4,KiB:1024,MiB:1024**2,GiB:1024**3,TiB:1024**4};
function dataSizeResult(input, options) {
  const text = inputText(input,64).trim();
  const value = Number(text);
  if (!text || !Number.isFinite(value) || value < 0) throw new Error('请输入有限的非负数值。');
  const multiplier = BYTE_UNITS[options.from || 'B'];
  if (!multiplier) throw new Error('字节单位无效。');
  const bytes = value * multiplier;
  if (!Number.isFinite(bytes) || bytes > Number.MAX_SAFE_INTEGER) throw new Error('数值过大，换算结果超出安全整数范围。');
  return `字节：${bytes}\n${Object.entries(BYTE_UNITS).filter(([unit]) => unit !== 'B').map(([unit,multiplier]) => `${unit}：${Number((bytes/multiplier).toPrecision(12))}`).join('\n')}\n\nKB / MB 为十进制，KiB / MiB 为二进制。`;
}

function dateResult(input, options) {
  const start = parseDateOnly(input.trim());
  if (options.action === 'add') {
    const days = integer(options.days,7,-3_650_000,3_650_000,'增减天数');
    const result = new Date(start.getTime() + days * 86_400_000);
    const year = result.getUTCFullYear();
    if (year < 0 || year > 9999) throw new Error('计算结果超出 0000–9999 年范围。');
    return result.toISOString().slice(0,10);
  }
  const end = parseDateOnly(String(options.endDate || '').trim());
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  return `${start.toISOString().slice(0,10)} → ${end.toISOString().slice(0,10)}\n相差：${days} 天\n按 UTC 日历计算，不受夏令时影响；不包含起始日。`;
}

export function diffLines(before, after) {
  const left = inputText(before,100_000).replace(/\r\n/g,'\n');
  const right = inputText(after,100_000).replace(/\r\n/g,'\n');
  const a = left === '' ? [] : left.split('\n');
  const b = right === '' ? [] : right.split('\n');
  if (a.length > 500 || b.length > 500) throw new Error('为保持浏览器响应，每份文本最多比较 500 行。');
  const rows = Array.from({length:a.length + 1},() => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) rows[i][j] = a[i] === b[j] ? rows[i+1][j+1]+1 : Math.max(rows[i+1][j],rows[i][j+1]);
  }
  const output = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { output.push(`  ${a[i]}`); i++; j++; }
    else if (i < a.length && (j >= b.length || rows[i+1][j] >= rows[i][j+1])) output.push(`- ${a[i++]}`);
    else output.push(`+ ${b[j++]}`);
  }
  return output.join('\n');
}

export function shellQuote(value) {
  return `'${withoutControls(value,'命令参数').replace(/'/g,"'\\''")}'`;
}

function lines(value) { return String(value || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean); }

export function generateCurl(input, options = {}) {
  const url = withoutControls(inputText(input,8192),'请求网址').trim();
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('请求网址需为完整的 http:// 或 https:// 地址。'); }
  if (!['http:','https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('请求网址需为 http(s) 地址，且不能嵌入账号密码。');
  const method = String(options.method || 'GET').toUpperCase();
  if (!['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].includes(method)) throw new Error('HTTP 方法无效。');
  const args = ['curl','--request',shellQuote(method),'--url',shellQuote(url)];
  for (const header of lines(options.headers)) {
    if (!/^[!#$%&'*+.^_`|~\da-z-]+\s*:/i.test(header)) throw new Error('请求头应逐行填写，格式为 Header-Name: value。');
    args.push('--header',shellQuote(header));
  }
  const body = String(options.body || '');
  if (body) {
    // JSON and text bodies may span lines. Convert literal newlines to shell-safe
    // single-quoted arguments rather than treating them as command separators.
    if (/[\x00\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(body)) throw new Error('请求正文包含不支持的控制字符。');
    args.push('--data-raw',`'${body.replace(/'/g,"'\\''")}'`);
  }
  return `${args.join(' ')}\n\n# 仅生成 POSIX shell 命令，不会发送请求。`;
}

export function generateDocker(input, options = {}) {
  const image = withoutControls(inputText(input,512),'镜像名称').trim();
  if (!/^[a-z\d][a-z\d._:/@-]*$/i.test(image)) throw new Error('请输入有效镜像名称，例如 nginx:alpine。');
  const args = ['docker','run'];
  if (options.detached !== false && options.detached !== 'false') args.push('--detach');
  if (options.name) {
    const name = withoutControls(options.name,'容器名称');
    if (!/^[a-z\d][a-z\d_.-]*$/i.test(name)) throw new Error('容器名称只能包含字母、数字、下划线、点和连字符。');
    args.push('--name',shellQuote(name));
  }
  for (const port of lines(options.ports)) {
    if (!/^(?:\d{1,5}:)?\d{1,5}(?:\/(?:tcp|udp))?$/.test(port)) throw new Error('端口映射应为 8080:80 或 80/tcp，每行一项。');
    if (port.match(/\d+/g).some(value => Number(value) < 1 || Number(value) > 65535)) throw new Error('端口必须在 1–65535 范围。');
    args.push('--publish',shellQuote(port));
  }
  for (const volume of lines(options.volumes)) {
    if (!/^.+:.+(?::(?:ro|rw))?$/.test(volume)) throw new Error('卷映射应为 /宿主目录:/容器目录，每行一项。');
    args.push('--volume',shellQuote(volume));
  }
  for (const env of lines(options.env)) {
    if (!/^[a-z_][a-z\d_]*=/i.test(env)) throw new Error('环境变量应为 NAME=value，每行一项。');
    args.push('--env',shellQuote(env));
  }
  args.push(shellQuote(image));
  return `${args.join(' ')}\n\n# 仅生成 POSIX shell 命令，不会启动容器。`;
}

function cronResult(input, options) {
  const preset = options.preset || 'daily';
  const minute = integer(options.minute,0,0,59,'分钟');
  const hour = integer(options.hour,8,0,23,'小时');
  const weekday = integer(options.weekday,1,0,6,'星期');
  let expression, description;
  if (preset === 'daily') { expression = `${minute} ${hour} * * *`; description = `每天 ${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`; }
  else if (preset === 'weekly') { expression = `${minute} ${hour} * * ${weekday}`; description = `每周${['日','一','二','三','四','五','六'][weekday]} ${hour}:${String(minute).padStart(2,'0')}`; }
  else if (preset === 'monthly') {
    const day = integer(options.day,1,1,28,'日期');
    expression = `${minute} ${hour} ${day} * *`; description = `每月 ${day} 日 ${hour}:${String(minute).padStart(2,'0')}`;
  } else if (preset === 'interval') {
    const interval = integer(options.interval,15,1,59,'分钟步长');
    expression = `*/${interval} * * * *`; description = `每小时从第 0 分钟起，按 ${interval} 分钟步长执行（跨整点不保证等间隔）`;
  } else throw new Error('Cron 周期无效。');
  return `${expression}\n\n${description}\n格式：分 时 日 月 星期（5 段 Linux Cron）。\n时区由任务运行环境决定，本工具不创建定时任务。`;
}

export function parseColor(input) {
  const text = inputText(input,128).trim();
  let rgb;
  const hex = /^#?([\da-f]{3}|[\da-f]{6})$/i.exec(text);
  const rgbMatch = /^rgb\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)$/i.exec(text);
  const hslMatch = /^hsl\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)%\s*,\s*(\d+(?:\.\d+)?)%\s*\)$/i.exec(text);
  if (hex) {
    const value = hex[1].length === 3 ? [...hex[1]].map(char => char + char).join('') : hex[1];
    rgb = [0,2,4].map(offset => parseInt(value.slice(offset,offset + 2),16));
  } else if (rgbMatch) {
    rgb = rgbMatch.slice(1).map(Number);
    if (rgb.some(value => value < 0 || value > 255)) throw new Error('颜色 RGB 通道范围应为 0–255。');
    rgb = rgb.map(Math.round);
  } else if (hslMatch) {
    let [h,s,l] = hslMatch.slice(1).map(Number);
    if (s > 100 || l > 100) throw new Error('颜色饱和度与亮度应为 0–100%。');
    h = ((h % 360) + 360) % 360 / 60; s /= 100; l /= 100;
    const chroma = (1 - Math.abs(2*l - 1))*s;
    const x = chroma*(1 - Math.abs(h % 2 - 1));
    const m = l - chroma/2;
    const channels = h < 1 ? [chroma,x,0] : h < 2 ? [x,chroma,0] : h < 3 ? [0,chroma,x] : h < 4 ? [0,x,chroma] : h < 5 ? [x,0,chroma] : [chroma,0,x];
    rgb = channels.map(value => Math.round((value + m)*255));
  } else throw new Error('颜色格式无效，支持 #HEX、rgb(r,g,b) 和 hsl(h,s%,l%)。');
  const [r,g,b] = rgb.map(value => value / 255);
  const max = Math.max(r,g,b), min = Math.min(r,g,b), delta = max - min;
  const lightness = (max + min)/2;
  let hue = 0;
  if (delta) hue = max === r ? ((g-b)/delta) % 6 : max === g ? (b-r)/delta+2 : (r-g)/delta+4;
  hue = (hue*60 + 360) % 360;
  const saturation = delta === 0 ? 0 : delta/(1 - Math.abs(2*lightness - 1));
  return {hex:'#' + rgb.map(value => value.toString(16).padStart(2,'0')).join('').toUpperCase(),rgb,hsl:[Math.round(hue),Number((saturation*100).toFixed(1)),Number((lightness*100).toFixed(1))]};
}

const HTTP_CODES = {
  100:['Continue','继续发送请求'],101:['Switching Protocols','协议切换'],
  200:['OK','请求成功'],201:['Created','资源已创建'],202:['Accepted','请求已接收，尚未完成'],204:['No Content','成功，无响应正文'],206:['Partial Content','部分内容'],
  301:['Moved Permanently','永久重定向'],302:['Found','临时重定向'],303:['See Other','通过 GET 查看其它资源'],304:['Not Modified','缓存资源未修改'],307:['Temporary Redirect','临时重定向，保留方法'],308:['Permanent Redirect','永久重定向，保留方法'],
  400:['Bad Request','请求格式错误'],401:['Unauthorized','需要身份认证'],403:['Forbidden','禁止访问'],404:['Not Found','资源不存在'],405:['Method Not Allowed','请求方法不受支持'],408:['Request Timeout','请求超时'],409:['Conflict','资源状态冲突'],410:['Gone','资源已永久移除'],413:['Content Too Large','请求内容过大'],415:['Unsupported Media Type','媒体类型不支持'],418:["I'm a teapot",'彩蛋状态码'],422:['Unprocessable Content','内容无法处理'],425:['Too Early','请求过早'],429:['Too Many Requests','请求过于频繁'],
  500:['Internal Server Error','服务器内部错误'],501:['Not Implemented','功能未实现'],502:['Bad Gateway','网关响应异常'],503:['Service Unavailable','服务暂不可用'],504:['Gateway Timeout','网关超时'],505:['HTTP Version Not Supported','HTTP 版本不受支持'],
};

function httpStatusResult(input) {
  const query = inputText(input,128).trim().toLowerCase();
  const results = Object.entries(HTTP_CODES).filter(([code,values]) => `${code} ${values.join(' ')}`.toLowerCase().includes(query));
  return results.length ? results.map(([code,[name,meaning]]) => `${code} ${name}\n${meaning}`).join('\n\n') : '未找到匹配状态码；此表收录常用状态码，并非完整 IANA 注册表。';
}

function portCheckResult(input, options) {
  const host = withoutControls(inputText(input,253),'主机').trim();
  if (!/^(?:[a-z\d](?:[a-z\d.-]*[a-z\d])?|[a-f\d:]+)$/i.test(host) || host.includes('..')) throw new Error('主机需为域名、IPv4 或不带方括号的 IPv6 地址。');
  const port = integer(options.port,443,1,65535,'端口');
  if (options.platform === 'powershell') return `Test-NetConnection -ComputerName '${host}' -Port ${port}\n\n# 仅生成 PowerShell 命令，不会连接目标。`;
  return `nc -vz -w 5 ${shellQuote(host)} ${port}\n\n# 仅生成 POSIX shell 命令；运行环境需安装 netcat，不会在网页中连接目标。`;
}

function asciiResult(input) {
  const text = inputText(input,3).trim();
  if (text && !/^\d+$/.test(text) && text.length !== 1) throw new Error('请输入 0–127 的 ASCII 编号或单个 ASCII 字符。');
  const values = text === '' ? Array.from({length:128},(_,index) => index) : [/^\d+$/.test(input.trim()) ? Number(input.trim()) : input.codePointAt(0)];
  if (values.some(value => !Number.isInteger(value) || value < 0 || value > 127)) throw new Error('请输入 0–127 的 ASCII 编号或单个 ASCII 字符。');
  const controlNames = ['NUL','SOH','STX','ETX','EOT','ENQ','ACK','BEL','BS','TAB','LF','VT','FF','CR','SO','SI','DLE','DC1','DC2','DC3','DC4','NAK','SYN','ETB','CAN','EM','SUB','ESC','FS','GS','RS','US'];
  return ['DEC  HEX  字符',...values.map(value => `${String(value).padStart(3,' ')}  ${value.toString(16).padStart(2,'0').toUpperCase()}   ${value < 32 ? controlNames[value] : value === 32 ? 'SPACE' : value === 127 ? 'DEL' : String.fromCharCode(value)}`)].join('\n');
}

function htmlEntities(input, options) {
  const entities = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
  if (options.action !== 'decode') return input.replace(/[&<>"']/g,char => entities[char]);
  const reverse = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:'\u00a0'};
  return input.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(whole,key) => {
    if (!key.startsWith('#')) return reverse[key.toLowerCase()];
    const number = key.slice(0,2).toLowerCase() === '#x' ? parseInt(key.slice(2),16) : Number(key.slice(1));
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : whole;
  });
}

const action = (id,label) => ({id,label});
const select = (name,label,value,options) => ({name,label,type:'select',value,options:options.map(option => typeof option === 'string' ? {value:option,label:option} : option)});
const number = (name,label,value,min,max) => ({name,label,type:'number',value,min,max});
const text = (name,label,value = '',multiline = false) => ({name,label,type:'text',value,multiline});

function defineTool(definition) {
  const execute = definition.run;
  return {...definition,fields:definition.fields || [],keywords:definition.keywords || [],run(input, options = {}) {
    const values = Object.fromEntries((definition.fields || []).map(field => [field.name,field.value]));
    Object.assign(values,options);
    values.action ||= definition.actions[0].id;
    if (!definition.actions.some(item => item.id === values.action)) throw new Error('工具操作无效，请重新选择。');
    return execute(inputText(input),values);
  }};
}

export const TEXT_TOOLS = [
  {
    id:'json',title:'JSON 格式化',category:'develop',icon:'{ }',description:'格式化、压缩 JSON，直接检查语法错误。',keywords:['json','格式','压缩'],inputLabel:'输入 JSON',placeholder:'{"hello":"Songuu","count":3}',actions:[action('format','格式化'),action('minify','压缩')],
    run(input,options) { try { return JSON.stringify(JSON.parse(input),null,options.action === 'minify' ? 0 : 2); } catch (error) { throw new Error(`JSON 解析失败：${error.message}`); } },
  },
  {
    id:'encode',title:'URL 编码 / 解码',category:'convert',icon:'↔',description:'对中文、符号和网址参数进行百分号编解码。',keywords:['url','URI','转义'],inputLabel:'输入文本或编码内容',placeholder:'你好 Songuu & hello',actions:[action('encode','URL 编码'),action('decode','URL 解码')],
    run(input,options) { try { return options.action === 'decode' ? decodeURIComponent(input) : encodeURIComponent(input); } catch { throw new Error('URL 编解码失败，请检查百分号编码及 Unicode 字符。'); } },
  },
  {
    id:'time',title:'Unix 时间戳转换',category:'convert',icon:'◷',description:'秒、毫秒与日期时间互转，并查看当前时间戳。',keywords:['unix','timestamp','日期'],inputLabel:'输入时间戳或日期时间',placeholder:'2026-10-25T08:00:00+08:00',actions:[action('convert','转换时间'),action('now','当前时间')],fields:[select('unit','数字单位','auto',[{value:'auto',label:'自动判断'},{value:'seconds',label:'秒'},{value:'milliseconds',label:'毫秒'}])],run:timestampResult,
  },
  {
    id:'count',title:'字数与文本统计',category:'file',icon:'¶',description:'统计字符、汉字、英文单词、行数和 UTF-8 字节。',keywords:['字数','字符','文本'],inputLabel:'输入或粘贴文本',placeholder:'写点什么，看看有多少字。',actions:[action('count','统计文本')],
    run(input) { return `字符数：${[...input].length}\n不含空白：${[...input.replace(/\s/g,'')].length}\n中文字符：${(input.match(/\p{Script=Han}/gu) || []).length}\n英文单词：${(input.match(/[a-z]+(?:['’-][a-z]+)*/gi) || []).length}\n行数：${input ? input.split(/\r?\n/).length : 0}\nUTF-8 字节：${encoder.encode(input).length}`; },
  },
  {
    id:'uuid',title:'UUID 生成',category:'develop',icon:'⌘',description:'使用浏览器安全随机源批量生成 UUID v4。',keywords:['uuid','guid','随机'],inputLabel:'输入数量（1–100）',placeholder:'1',actions:[action('generate','生成 UUID')],
    run(input) { return Array.from({length:integer(input.trim(),1,1,100,'UUID 数量')},() => crypto.randomUUID()).join('\n'); },
  },
  {
    id:'base64',title:'Base64 编解码',category:'convert',icon:'64',description:'支持中文与 Emoji 的 UTF-8 文本编解码。',keywords:['base64','编码'],inputLabel:'输入文本或 Base64',placeholder:'你好，世界 🌏',actions:[action('encode','Base64 编码'),action('decode','Base64 解码')],run:(input,options) => options.action === 'decode' ? decodeBase64(input) : encodeBase64(input),
  },
  {
    id:'unicode',title:'Unicode 编解码',category:'convert',icon:'U+',description:'转换 Unicode 转义序列，支持非 BMP 字符。',keywords:['unicode','转义','编码'],inputLabel:'输入文本或 Unicode 转义',placeholder:'你好 😀 或 \\u4f60\\u597d',actions:[action('encode','Unicode 编码'),action('decode','Unicode 解码')],
    run(input,options) {
      if (options.action !== 'decode') return input.split('').map(char => '\\u' + char.charCodeAt(0).toString(16).padStart(4,'0')).join('');
      if (/\\u(?!\{[\da-f]{1,6}\}|[\da-f]{4})/i.test(input)) throw new Error('Unicode 转义格式无效，支持 \\uXXXX 或 \\u{XXXXX}。');
      return input.replace(/\\u(?:\{([\da-f]{1,6})\}|([\da-f]{4}))/gi,(_,point,unit) => {
        const value = parseInt(point || unit,16);
        if (value > 0x10ffff) throw new Error('Unicode 码点超出有效范围。');
        return point ? String.fromCodePoint(value) : String.fromCharCode(value);
      });
    },
  },
  {
    id:'base',title:'进制转换',category:'convert',icon:'01',description:'精确转换 2–36 进制的大整数，支持负数。',keywords:['二进制','十六进制','BigInt'],inputLabel:'输入整数（不含 0x 等前缀）',placeholder:'9007199254740993',actions:[action('convert','转换进制')],fields:[number('from','输入进制',10,2,36),number('to','输出进制',16,2,36)],run:(input,options) => convertBase(input,options.from,options.to),
  },
  {
    id:'jwt',title:'JWT 解码器',category:'develop',icon:'JWT',description:'查看 Header、Payload 与时间字段；不验证签名。',keywords:['token','jwt','鉴权'],inputLabel:'粘贴 JWT Token',placeholder:'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature',actions:[action('decode','解析 JWT')],run:jwtResult,
  },
  {
    id:'hash',title:'SHA 哈希计算',category:'develop',icon:'#',description:'本地计算 SHA-256、SHA-384 或 SHA-512 文本摘要。',keywords:['hash','sha256','摘要'],inputLabel:'输入待计算文本',placeholder:'hello',actions:[action('hash','计算摘要')],fields:[select('algorithm','哈希算法','SHA-256',['SHA-256','SHA-384','SHA-512'])],
    async run(input,options) {
      if (!['SHA-256','SHA-384','SHA-512'].includes(options.algorithm)) throw new Error('仅支持 SHA-256、SHA-384、SHA-512。');
      if (!crypto.subtle) throw new Error('当前浏览器不支持 WebCrypto，请使用 HTTPS 页面。');
      const bytes = new Uint8Array(await crypto.subtle.digest(options.algorithm,encoder.encode(input)));
      return [...bytes].map(value => value.toString(16).padStart(2,'0')).join('');
    },
  },
  {
    id:'random',title:'随机数与密码',category:'develop',icon:'⚄',description:'安全随机数和指定长度密码，不使用 Math.random。',keywords:['random','密码','随机数'],inputLabel:'无需填写文本，使用下方参数',placeholder:'设置范围或密码长度后生成',actions:[action('numbers','生成随机数'),action('password','生成密码')],fields:[number('min','最小值',1,-2147483648,2147483647),number('max','最大值',100,-2147483648,2147483647),number('quantity','随机数数量',5,1,1000),number('length','密码长度',20,1,1000),select('alphabet','密码字符集','alphanumeric',[{value:'alphanumeric',label:'字母与数字（去除易混字符）'},{value:'symbols',label:'字母、数字和符号'},{value:'digits',label:'纯数字'}])],run:randomResult,
  },
  {
    id:'data-size',title:'字节数换算',category:'convert',icon:'KB',description:'区分十进制与二进制，换算 B 到 TB / TiB。',keywords:['bytes','MB','MiB','容量'],inputLabel:'输入非负数值',placeholder:'1024',actions:[action('convert','换算容量')],fields:[select('from','输入单位','B',Object.keys(BYTE_UNITS))],run:dataSizeResult,
  },
  {
    id:'date',title:'日期计算',category:'life',icon:'▦',description:'计算两个日期相差天数，或给日期增加、减少天数。',keywords:['日期','日历','天数'],inputLabel:'起始日期（YYYY-MM-DD）',placeholder:'2026-10-25',actions:[action('difference','计算日期差'),action('add','增减天数')],fields:[text('endDate','结束日期','2026-11-01'),number('days','增减天数（可为负）',7,-3650000,3650000)],run:dateResult,
  },
  {
    id:'text-diff',title:'文本对比',category:'file',icon:'±',description:'逐行比较两份文本，用 + / − 标出新增与删除。',keywords:['diff','文本','对比'],inputLabel:'原始文本（最多 500 行）',placeholder:'第一行\n原始第二行',actions:[action('diff','对比文本')],fields:[text('after','修改后的文本（可粘贴多行）','',true)],run:(input,options) => diffLines(input,options.after),
  },
  {
    id:'curl-builder',title:'cURL 命令构建器',category:'develop',icon:'c>',description:'配置请求方法、请求头和正文，生成 POSIX shell 命令。',keywords:['curl','http','请求'],inputLabel:'请求网址',placeholder:'https://example.com/api/items',actions:[action('generate','生成 cURL 命令')],fields:[select('method','HTTP 方法','GET',['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS']),text('headers','请求头（每行一条）','Accept: application/json',true),text('body','请求正文','',true)],run:generateCurl,
  },
  {
    id:'docker-generator',title:'Docker 命令生成器',category:'develop',icon:'▣',description:'配置镜像、端口、卷与环境变量，生成 docker run 命令。',keywords:['docker','容器','命令'],inputLabel:'镜像名称',placeholder:'nginx:alpine',actions:[action('generate','生成 Docker 命令')],fields:[text('name','容器名称',''),text('ports','端口映射（每行一条）','8080:80',true),text('volumes','卷映射（每行一条）','',true),text('env','环境变量（每行 NAME=value）','',true),{name:'detached',label:'后台运行',type:'checkbox',value:true}],run:generateDocker,
  },
  {
    id:'cron',title:'Cron 表达式生成器',category:'develop',icon:'◴',description:'生成每隔若干分钟、每天、每周或每月的 5 段表达式。',keywords:['cron','定时任务','schedule'],inputLabel:'无需输入文本，使用下方参数',placeholder:'只生成表达式，不创建任务',actions:[action('generate','生成 Cron 表达式')],fields:[select('preset','执行周期','daily',[{value:'daily',label:'每天'},{value:'weekly',label:'每周'},{value:'monthly',label:'每月'},{value:'interval',label:'分钟步长'}]),number('hour','小时',8,0,23),number('minute','分钟',0,0,59),number('weekday','星期（0 为周日）',1,0,6),number('day','每月几日（1–28）',1,1,28),number('interval','分钟步长',15,1,59)],run:cronResult,
  },
  {
    id:'color',title:'颜色格式转换',category:'image',icon:'◒',description:'HEX、RGB、HSL 颜色互转，支持三位 HEX。',keywords:['color','hex','rgb','hsl','颜色'],inputLabel:'输入 HEX、RGB 或 HSL',placeholder:'#3b82f6',actions:[action('convert','转换颜色')],
    run(input) { const result = parseColor(input); return `${result.hex}\nrgb(${result.rgb.join(', ')})\nhsl(${result.hsl[0]}, ${result.hsl[1]}%, ${result.hsl[2]}%)`; },
  },
  {
    id:'ascii',title:'ASCII 码表',category:'develop',icon:'Aa',description:'查询 0–127 ASCII 码，留空查看完整表格。',keywords:['ascii','字符','码表'],inputLabel:'ASCII 编号或单个字符（留空列出全部）',placeholder:'65',actions:[action('lookup','查询 ASCII')],run:asciiResult,
  },
  {
    id:'http-status',title:'HTTP 状态码查询',category:'develop',icon:'200',description:'按编号或关键词查询常用 HTTP 状态码含义。',keywords:['http','状态码','404','响应'],inputLabel:'编号或关键词（留空列出常用状态码）',placeholder:'404 或 gateway',actions:[action('lookup','查询状态码')],run:httpStatusResult,
  },
  {
    id:'port-check-generator',title:'端口检查命令生成',category:'develop',icon:':80',description:'生成 netcat 或 PowerShell TCP 连通性检查命令。',keywords:['端口','netcat','网络','powershell'],inputLabel:'目标主机（不含协议或路径）',placeholder:'example.com',actions:[action('generate','生成检查命令')],fields:[number('port','端口',443,1,65535),select('platform','运行环境','posix',[{value:'posix',label:'Linux / macOS（netcat）'},{value:'powershell',label:'Windows PowerShell'}])],run:portCheckResult,
  },
  {
    id:'html-entities',title:'HTML 实体编解码',category:'convert',icon:'&;',description:'转义 HTML 特殊字符，解析常用及数字实体。',keywords:['html','实体','转义','entity'],inputLabel:'输入文本或 HTML 实体',placeholder:'<div>Hello & Songuu</div>',actions:[action('encode','HTML 转义'),action('decode','实体解码')],run:htmlEntities,
  },
].map(defineTool);
