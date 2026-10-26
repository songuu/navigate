import {lookup} from 'node:dns/promises';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {BlockList,isIP} from 'node:net';

export class ArticleRequestError extends Error{
  constructor(readonly code:string,message:string){super(message);this.name='ArticleRequestError';}
}
export type ArticleAddress={readonly address:string;readonly family:number};
export type ResolveArticleHost=(hostname:string)=>Promise<readonly ArticleAddress[]>;
export type ArticleTransport=(url:URL,init:RequestInit,address:ArticleAddress)=>Promise<Response>;
export interface SafeArticleOptions{
  readonly timeoutMs?:number;
  readonly maxBytes?:number;
  readonly headers?:Readonly<Record<string,string>>;
  readonly resolveImpl?:ResolveArticleHost;
  readonly transport?:ArticleTransport;
  /** Trusted dependency injection for tests; production uses the pinned socket transport. */
  readonly fetchImpl?:typeof fetch;
}
const blocked4=new BlockList();
for(const [base,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.2',32],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const)blocked4.addSubnet(base,prefix,'ipv4');
const global6=new BlockList();global6.addSubnet('2000::',3,'ipv6');
const blocked6=new BlockList();for(const [base,prefix] of [['2001::',32],['2001:2::',48],['2001:db8::',32],['2001:10::',28],['2001:20::',28],['2002::',16],['3fff::',20]] as const)blocked6.addSubnet(base,prefix,'ipv6');

export function isPublicAddress(address:string):boolean{
  const family=isIP(address);return family===4?!blocked4.check(address,'ipv4'):family===6&&global6.check(address,'ipv6')&&!blocked6.check(address,'ipv6');
}
export function validateArticleUrl(value:string):URL{
  let url:URL;try{url=new URL(value);}catch{throw new ArticleRequestError('ARTICLE_URL_BLOCKED','正文地址无效。');}
  const host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||!host||host==='localhost'||/\.(?:localhost|local|internal)$/i.test(host)||(isIP(host)&&!isPublicAddress(host))){throw new ArticleRequestError('ARTICLE_URL_BLOCKED','正文地址必须是不含凭据的公网 HTTP(S) 地址。');}
  url.hash='';return url;
}
export function isArticleSafetyError(error:unknown):boolean{return error instanceof ArticleRequestError&&error.code!=='ARTICLE_TIMEOUT'&&error.code!=='ARTICLE_NETWORK';}
const timeoutError=()=>new ArticleRequestError('ARTICLE_TIMEOUT','正文请求超时。');
function withSignal<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{
  return new Promise((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(timeoutError());};if(signal.aborted){abort();return;}
    signal.addEventListener('abort',abort,{once:true});promise.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
  });
}

/** DNS is validated once and its selected address is pinned into the connection.
 * The original hostname remains the HTTP Host / TLS SNI verification identity.
 */
export const pinnedArticleTransport:ArticleTransport=(url,init,address)=>new Promise((resolve,reject)=>{
  const host=url.hostname.replace(/^\[|\]$/g,''),headers=Object.fromEntries(new Headers(init.headers));
  const request=url.protocol==='https:'?httpsRequest:httpRequest;
  const finishResponse=(body:ArrayBuffer|null,status:number,headers:Headers)=>{
    try{resolve(new Response(body,{status,headers}));}
    catch{reject(new ArticleRequestError('ARTICLE_RESPONSE_INVALID','正文 HTTP 响应格式无效。'));}
  };
  const req=request({protocol:url.protocol,hostname:host,port:url.port||undefined,path:url.pathname+url.search,method:'GET',headers,agent:false,family:address.family,
    lookup:(_hostname,_options,callback)=>callback(null,address.address,address.family),
    ...(url.protocol==='https:'&&isIP(host)===0?{servername:host}:{}),
  },incoming=>{
    const status=incoming.statusCode??502;
    if(!Number.isInteger(status)||status<200||status>599){incoming.destroy();reject(new ArticleRequestError('ARTICLE_STATUS_INVALID','正文 HTTP 状态无效。'));return;}
    const responseHeaders=new Headers();
    try{for(const [key,value] of Object.entries(incoming.headers)){if(value!==undefined)responseHeaders.set(key,Array.isArray(value)?value.join(', '):value);}}
    catch{incoming.destroy();reject(new ArticleRequestError('ARTICLE_RESPONSE_INVALID','正文 HTTP 响应头无效。'));return;}
    if([301,302,303,307,308].includes(status)){incoming.destroy();finishResponse(null,status,responseHeaders);return;}
    const parts:Uint8Array[]=[];let size=0;const maxBytes=2*1024*1024;
    const declared=Number(incoming.headers['content-length']);if(Number.isFinite(declared)&&declared>maxBytes){incoming.destroy();reject(new ArticleRequestError('ARTICLE_RESPONSE_TOO_LARGE','正文响应超过大小限制。'));return;}
    incoming.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>maxBytes){incoming.destroy();reject(new ArticleRequestError('ARTICLE_RESPONSE_TOO_LARGE','正文响应超过大小限制。'));return;}parts.push(chunk);});
    incoming.on('end',()=>{try{const bytes=new Uint8Array(size);let position=0;for(const part of parts){bytes.set(part,position);position+=part.length;}finishResponse([204,205,304].includes(status)?null:bytes.buffer,status,responseHeaders);}catch{reject(new ArticleRequestError('ARTICLE_RESPONSE_INVALID','正文 HTTP 响应体无效。'));}});
    incoming.on('error',()=>reject(new ArticleRequestError('ARTICLE_NETWORK','正文响应读取失败。')));
    incoming.on('aborted',()=>reject(new ArticleRequestError('ARTICLE_NETWORK','正文响应提前中断。')));
  });
  const abort=()=>req.destroy(timeoutError());const signal=init.signal;if(signal?.aborted){abort();}else signal?.addEventListener('abort',abort,{once:true});
  req.on('close',()=>signal?.removeEventListener('abort',abort));req.on('error',error=>reject(error instanceof ArticleRequestError?error:new ArticleRequestError('ARTICLE_NETWORK','正文连接失败。')));req.end();
});

async function limitedResponse(response:Response,maxBytes:number,signal:AbortSignal):Promise<Response>{
  const declared=Number(response.headers.get('content-length'));
  if(Number.isFinite(declared)&&declared>maxBytes){void response.body?.cancel().catch(()=>{});throw new ArticleRequestError('ARTICLE_RESPONSE_TOO_LARGE','正文响应超过大小限制。');}
  if(!response.body)return response;
  const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;
  try{for(;;){const {done,value}=await withSignal(reader.read(),signal);if(done)break;size+=value.length;if(size>maxBytes)throw new ArticleRequestError('ARTICLE_RESPONSE_TOO_LARGE','正文响应超过大小限制。');parts.push(value);}}
  catch(error){void reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let position=0;for(const part of parts){bytes.set(part,position);position+=part.length;}
  return new Response([204,205,304].includes(response.status)?null:bytes.buffer,{status:response.status,headers:response.headers});
}

/** Fetch one public article using an overall deadline and at most five redirects. */
export async function safeArticleFetch(value:string,options:SafeArticleOptions={}):Promise<Response>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),options.timeoutMs??12000),signal=controller.signal;
  const resolveHost=options.resolveImpl??(async hostname=>lookup(hostname,{all:true,verbatim:true}));
  const maxBytes=Math.min(options.maxBytes??2*1024*1024,2*1024*1024);
  try{
    let url=validateArticleUrl(value);
    for(let hop=0;hop<=5;hop++){
      const host=url.hostname.replace(/^\[|\]$/g,''),family=isIP(host);
      let addresses:readonly ArticleAddress[];
      try{addresses=family?[{address:host,family}]:await withSignal(resolveHost(host),signal);}
      catch{if(signal.aborted)throw timeoutError();throw new ArticleRequestError('ARTICLE_DNS_BLOCKED','无法验证正文的公网 DNS 地址。');}
      if(!addresses.length||addresses.some(address=>!isPublicAddress(address.address)||isIP(address.address)!==address.family))throw new ArticleRequestError('ARTICLE_DNS_BLOCKED','正文 DNS 必须全部解析为公网地址。');
      const address=[...addresses].sort((a,b)=>a.family-b.family)[0]!;
      const init:RequestInit={redirect:'manual',signal,headers:{...options.headers,'Accept-Encoding':'identity'}};
      const response=await withSignal(options.fetchImpl?options.fetchImpl(url.href,init):(options.transport??pinnedArticleTransport)(url,init,address),signal);
      if(response.redirected){void response.body?.cancel().catch(()=>{});throw new ArticleRequestError('ARTICLE_REDIRECT_BLOCKED','正文传输不得自动跟随重定向。');}
      if([301,302,303,307,308].includes(response.status)){
        const location=response.headers.get('location');void response.body?.cancel().catch(()=>{});if(!location||hop===5)throw new ArticleRequestError('ARTICLE_REDIRECT_BLOCKED','正文重定向无效或超过五跳。');url=validateArticleUrl(new URL(location,url).href);continue;
      }
      if((response.headers.get('content-encoding')??'identity').trim().toLowerCase()!=='identity'){void response.body?.cancel().catch(()=>{});throw new ArticleRequestError('ARTICLE_ENCODING_BLOCKED','正文使用了不支持的压缩编码。');}
      return await limitedResponse(response,maxBytes,signal);
    }
    throw new ArticleRequestError('ARTICLE_REDIRECT_BLOCKED','正文重定向次数超限。');
  }catch(error){if(signal.aborted)throw timeoutError();throw error;}finally{clearTimeout(timer);}
}
