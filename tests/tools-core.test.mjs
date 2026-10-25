import test from 'node:test';
import assert from 'node:assert/strict';
import {TEXT_TOOLS, convertBase, decodeJwt, diffLines, shellQuote, generateCurl, generateDocker, parseColor} from '../src/tools-core.js';

const tool = id => TEXT_TOOLS.find(item => item.id === id);
const run = (id, input = '', options = {}) => tool(id).run(input, options);

test('registry preserves original tools and describes every runnable action', () => {
  assert.equal(new Set(TEXT_TOOLS.map(item => item.id)).size, TEXT_TOOLS.length);
  for (const id of ['json','encode','time','count','uuid']) assert.ok(tool(id));
  for (const item of TEXT_TOOLS) {
    assert.ok(item.title && item.description && item.inputLabel);
    assert.equal(typeof item.run, 'function');
    assert.ok(item.actions.length > 0);
    assert.ok(['convert','develop','life','file','fun','image','audio'].includes(item.category));
  }
});

test('JSON format/minify reports malformed input', () => {
  assert.equal(run('json','{"a":1}'), '{\n  "a": 1\n}');
  assert.equal(run('json','{ "a": 1 }',{action:'minify'}), '{"a":1}');
  assert.throws(() => run('json','{'), /JSON/);
});

test('URL and UTF-8 Base64 round trip Chinese and astral characters', () => {
  const value = '你好 🌏 + &=';
  assert.equal(run('encode',run('encode',value),{action:'decode'}), value);
  assert.equal(run('base64',run('base64',value),{action:'decode'}), value);
  assert.throws(() => run('encode','%ZZ',{action:'decode'}), /URL/);
  assert.throws(() => run('base64','%%%=',{action:'decode'}), /Base64/);
  assert.throws(() => run('base64','/w==',{action:'decode'}), /UTF-8/);
});

test('Unicode escaping preserves surrogate pairs and rejects malformed escapes', () => {
  const value = '中😀\\';
  assert.equal(run('unicode',run('unicode',value),{action:'decode'}), value);
  assert.equal(run('unicode','\\u{1F600}',{action:'decode'}), '😀');
  assert.throws(() => run('unicode','\\uZZZZ',{action:'decode'}), /Unicode/);
});

test('integer base conversion stays exact beyond Number precision', () => {
  assert.equal(convertBase('9007199254740993123456789',10,16), BigInt('9007199254740993123456789').toString(16).toUpperCase());
  assert.equal(convertBase('-FF',16,10), '-255');
  assert.equal(convertBase('0',10,2), '0');
  assert.throws(() => convertBase('102',2,10), /进制/);
  assert.throws(() => convertBase('1.2',10,2), /整数/);
  assert.throws(() => convertBase('1',1,10), /2.*36/);
});

test('timestamps support seconds, milliseconds and dates without silent overflow', () => {
  assert.match(run('time','0',{unit:'seconds'}), /1970-01-01T00:00:00.000Z/);
  assert.match(run('time','1000',{unit:'milliseconds'}), /1970-01-01T00:00:01.000Z/);
  assert.match(run('time','-1',{unit:'seconds'}), /1969-12-31T23:59:59.000Z/);
  assert.throws(() => run('time','2026-02-31'), /日期/);
  assert.throws(() => run('time','invalid'), /时间/);
});

test('text statistics count code points rather than UTF-16 units', () => {
  assert.match(run('count','中😀 hi\nline'), /字符数：10/);
  assert.match(run('count',''), /行数：0/);
});

test('UUID generation validates quantity and yields random v4 UUIDs', () => {
  const values = run('uuid','3').split('\n');
  assert.equal(new Set(values).size,3);
  for (const value of values) assert.match(value,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  for (const input of ['0','101','1.5','x']) assert.throws(() => run('uuid',input), /数量/);
});

test('JWT decoder understands base64url UTF-8 and explicitly does not verify signatures', () => {
  const header = Buffer.from(JSON.stringify({alg:'none'})).toString('base64url');
  const payload = Buffer.from(JSON.stringify({name:'测试',exp:0})).toString('base64url');
  const result = decodeJwt(`${header}.${payload}.`);
  assert.equal(result.payload.name,'测试');
  assert.equal(result.verified,false);
  assert.match(run('jwt',`${header}.${payload}.`), /未验证签名/);
  assert.throws(() => decodeJwt('x.y'), /JWT/);
  assert.throws(() => decodeJwt('eA.eA.'), /JSON/);
});

test('SHA-256 computes known digest without a remote API', async () => {
  assert.equal(await run('hash','abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal((await run('hash','abc',{algorithm:'SHA-512'})).length,128);
  await assert.rejects(() => run('hash','abc',{algorithm:'MD5'}), /SHA/);
});

test('random generator limits ranges and passwords to requested alphabet', () => {
  const result = run('random','',{min:'-5',max:'-3',quantity:'30'}).split('\n').map(Number);
  assert.equal(result.length,30);
  assert.ok(result.every(value => [-5,-4,-3].includes(value)));
  const password = run('random','',{action:'password',length:'32',alphabet:'digits'});
  assert.match(password,/^\d{32}$/);
  assert.throws(() => run('random','',{min:5,max:1}), /最小值/);
  assert.throws(() => run('random','',{action:'password',length:1001}), /长度/);
  assert.throws(() => run('random','',{action:'password',alphabet:'constructor'}), /字符集/);
});

test('byte conversion distinguishes binary and decimal units', () => {
  assert.match(run('data-size','1',{from:'MiB'}), /字节：1048576/);
  assert.match(run('data-size','1',{from:'MB'}), /字节：1000000/);
  assert.throws(() => run('data-size','-1'), /非负/);
});

test('date calculation handles leap years and DST through UTC date arithmetic', () => {
  assert.match(run('date','2024-02-28',{endDate:'2024-03-01'}), /相差：2 天/);
  assert.equal(run('date','2026-03-08',{action:'add',days:1}), '2026-03-09');
  assert.equal(run('date','2026-01-01',{action:'add',days:-1}), '2025-12-31');
  assert.throws(() => run('date','2026-02-29',{endDate:'2026-03-01'}), /日期/);
});

test('line diff preserves insertion/deletion and refuses unbounded quadratic work', () => {
  assert.equal(diffLines('a\nb','a\nc'), '  a\n- b\n+ c');
  assert.equal(diffLines('','new'), '+ new');
  assert.throws(() => diffLines('a\n'.repeat(501),''), /500/);
});

test('POSIX quoting and cURL builder keep shell metacharacters inert', () => {
  assert.equal(shellQuote("it's $HOME"), "'it'\\''s $HOME'");
  const command = generateCurl('https://example.com/?x=$(id)',{method:'POST',headers:'X-Test: safe',body:"it's $HOME"});
  assert.match(command,/--url 'https:\/\/example.com\/\?x=\$\(id\)'/);
  assert.match(command,/--data-raw 'it'\\''s \$HOME'/);
  assert.throws(() => generateCurl('file:///secret',{}), /http/);
  assert.throws(() => generateCurl('https://example.com/',{headers:'NoColon'}), /请求头/);
  assert.throws(() => generateCurl('https://example.com/\nwhoami',{}), /换行/);
});

test('Docker builder validates structural fields and quotes every argument', () => {
  const result = generateDocker('nginx:alpine',{name:'site',ports:'8080:80',volumes:'/tmp/a b:/data',env:'NAME=hello $HOME'});
  assert.match(result, /--volume '\/tmp\/a b:\/data'/);
  assert.match(result, /--env 'NAME=hello \$HOME'/);
  assert.throws(() => generateDocker('nginx\nrm -rf /'), /换行/);
  assert.throws(() => generateDocker('-evil'), /镜像/);
  assert.throws(() => generateDocker('nginx',{ports:'oops'}), /端口/);
});

test('Cron presets use five fields and enforce legal hour/minute ranges', () => {
  assert.match(run('cron','',{preset:'daily',hour:8,minute:30}), /30 8 \* \* \*/);
  assert.match(run('cron','',{preset:'interval',interval:15}), /\*\/15 \* \* \* \*/);
  assert.throws(() => run('cron','',{hour:24}), /小时/);
});

test('color conversion normalizes short hex and rejects invalid channel ranges', () => {
  assert.deepEqual(parseColor('#f00').rgb,[255,0,0]);
  assert.equal(parseColor('rgb(0, 128, 255)').hex,'#0080FF');
  assert.equal(parseColor('hsl(120, 100%, 50%)').hex,'#00FF00');
  assert.throws(() => parseColor('rgb(256,0,0)'), /颜色/);
  assert.throws(() => parseColor('#xyz'), /颜色/);
});

test('reference tools return requested rows and port scripts validate targets', () => {
  assert.match(run('ascii','65'), /A/);
  assert.throws(() => run('ascii','ABC'), /单个 ASCII/);
  assert.match(run('http-status','404'), /Not Found/);
  assert.match(run('port-check-generator','example.com',{port:443}), /example.com/);
  assert.throws(() => run('port-check-generator','x;whoami'), /主机/);
  assert.throws(() => run('port-check-generator','example.com',{port:65536}), /端口/);
});

test('HTML entity text encoding is inert and reverses the supported entities', () => {
  const source = '<script>alert("x")</script> & 😀';
  const encoded = run('html-entities',source);
  assert.ok(!encoded.includes('<script>'));
  assert.equal(run('html-entities',encoded,{action:'decode'}),source);
  assert.equal(run('html-entities','&#x1F600;',{action:'decode'}),'😀');
});
