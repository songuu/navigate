import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {isPublicAddress,validateArticleUrl,safeArticleFetch,pinnedArticleTransport,ArticleRequestError} from '../src/article-http.ts';
const publicDns=async()=>[{address:'93.184.216.34',family:4}];

test('article URLs exclude local, private, credentialed and non-web destinations',()=>{
  for(const url of ['file:///etc/passwd','ftp://example.com/a','https://a:b@example.com/a','http://127.0.0.1/a','http://2130706433/a','http://10.2.3.4','http://169.254.169.254/latest','http://[::1]/a','http://[::ffff:127.0.0.1]/a','http://printer.local/a','http://localhost/a'])assert.throws(()=>validateArticleUrl(url),ArticleRequestError);
  assert.equal(validateArticleUrl('https://example.com/a#part').href,'https://example.com/a');
});

test('public address checking excludes reserved IPv4 and IPv6 ranges',()=>{
  for(const address of ['0.0.0.0','100.64.1.1','192.168.0.1','192.0.2.1','192.88.99.2','198.18.0.1','224.0.0.1','::','::ffff:8.8.8.8','fc00::1','fe80::1','2001:2::1','2001:db8::1','2002:7f00:1::','3fff::1'])assert.equal(isPublicAddress(address),false,address);
  for(const address of ['8.8.8.8','93.184.216.34','2606:4700:4700::1111'])assert.equal(isPublicAddress(address),true,address);
});

test('IANA benchmark, documentation and relay DNS results never reach the transport',async()=>{
  for(const address of ['192.88.99.2','2001:2::1','3fff::1']){
    let calls=0;await assert.rejects(safeArticleFetch('https://example.com/a',{resolveImpl:async()=>[{address,family:address.includes(':')?6:4}],transport:async()=>{calls++;return new Response('');}}),/公网/);assert.equal(calls,0);
  }
});

test('every DNS answer must be public before the transport is called',async()=>{
  let calls=0;
  await assert.rejects(safeArticleFetch('https://example.com/a',{resolveImpl:async()=>[{address:'93.184.216.34',family:4},{address:'127.0.0.1',family:4}],transport:async()=>{calls++;return new Response('text');}}),/DNS|公网/);
  assert.equal(calls,0);
});

test('validated DNS address is passed to the pinned production transport seam',async()=>{
  let chosen;
  const response=await safeArticleFetch('https://example.com/a',{resolveImpl:publicDns,transport:async(url,init,address)=>{chosen=address;assert.equal(url.hostname,'example.com');assert.equal(init.redirect,'manual');return new Response('hello');}});
  assert.equal(await response.text(),'hello');assert.deepEqual(chosen,{address:'93.184.216.34',family:4});
});

test('manual redirects revalidate destination and never contact a private hop',async()=>{
  const seen:string[]=[];
  await assert.rejects(safeArticleFetch('https://example.com/a',{resolveImpl:publicDns,fetchImpl:async(input)=>{seen.push(String(input));return new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}});}}),/公网|地址/);
  assert.deepEqual(seen,['https://example.com/a']);
});

test('relative public redirects work and redirect loops stop after five hops',async()=>{
  const seen:string[]=[];
  const response=await safeArticleFetch('https://example.com/a',{resolveImpl:publicDns,fetchImpl:async(input)=>{seen.push(String(input));return seen.length===1?new Response(null,{status:301,headers:{location:'/b'}}):new Response('done');}});
  assert.equal(await response.text(),'done');assert.deepEqual(seen,['https://example.com/a','https://example.com/b']);
  let loops=0;await assert.rejects(safeArticleFetch('https://example.com/a',{resolveImpl:publicDns,fetchImpl:async()=>{loops++;return new Response(null,{status:302,headers:{location:'/loop'}});}}),/重定向/);assert.equal(loops,6);
});

test('response byte limit covers both Content-Length and actual streamed bytes',async()=>{
  await assert.rejects(safeArticleFetch('https://example.com/a',{resolveImpl:publicDns,maxBytes:4,fetchImpl:async()=>new Response('small',{headers:{'Content-Length':'500'}})}),/大小/);
  await assert.rejects(safeArticleFetch('https://example.com/a',{resolveImpl:publicDns,maxBytes:4,fetchImpl:async()=>new Response('hello')}),/大小/);
});

test('deadline includes DNS and stops a stalled resolver without contacting transport',async()=>{
  let called=false;await assert.rejects(safeArticleFetch('https://example.com/a',{timeoutMs:10,resolveImpl:()=>new Promise(()=>{}),transport:async()=>{called=true;return new Response('');}}),/超时/);assert.equal(called,false);
});

test('real socket HTTP 600 is rejected inside the transport promise instead of crashing the collector',async()=>{
  const server=createServer((_req,res)=>{res.writeHead(600,{'Content-Type':'text/plain'});res.end('invalid upstream status');});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const address=server.address();assert.ok(address&&typeof address!=='string');
    // Exercise only the transport against a controlled local fixture. The
    // safeArticleFetch public-address gate remains unchanged for production.
    await assert.rejects(pinnedArticleTransport(new URL('http://example.com:'+address.port),{signal:AbortSignal.timeout(2000)},{address:'127.0.0.1',family:4}),/状态/);
  }finally{server.close();await once(server,'close');}
});
