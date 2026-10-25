const descriptor=(id,title,category,description,icon,keywords=[])=>({id,title,category,description,icon,keywords});
export const BROWSER_TOOLS=[
  descriptor('qr-code','二维码生成器','convert','把文字或网址生成可下载的二维码。','▦',['QR','二维码']),
  descriptor('markdown','Markdown 预览与导出','file','实时排版 Markdown，导出 HTML 或打印为 PDF。','M↓',['文档','PDF','HTML']),
  descriptor('temp-clipboard','本机便笺','file','随手记下文字，在当前浏览器自动保存。','▤',['临时剪贴板','笔记']),
  descriptor('world-clock','世界时钟','life','同时查看多个城市的当地时间。','◷',['时区','timezone']),
  descriptor('stopwatch','秒表与倒计时','life','记录分段时间，或设置一个专注倒计时。','◴',['计时器','专注']),
  descriptor('color-picker','屏幕取色器','image','从屏幕取色，查看 HEX 与 RGB 色值。','◈',['设计','颜色']),
  descriptor('environment-diagnoser','浏览器环境检测','develop','查看当前浏览器报告的视口、语言和功能支持。','⌘',['DPR','浏览器']),
  descriptor('text-to-speech','文字朗读','audio','使用浏览器提供的语音朗读文字。','♫',['TTS','语音']),
  descriptor('what-to-eat','今天吃什么','fun','写下候选菜单，让随机选择帮你决定。','♧',['随机','选择'])
];
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
function field(parent,label,type='text',value=''){const wrap=el('label','field',label),input=el(type==='textarea'?'textarea':'input');if(type!=='textarea')input.type=type;input.value=value;wrap.append(input);parent.append(wrap);return input;}
function button(parent,label,fn,primary=false){const b=el('button',primary?'primary-button':'secondary-button',label);b.type='button';b.onclick=fn;parent.append(b);return b;}
export function downloadText(name,text,type='text/plain;charset=utf-8'){const url=URL.createObjectURL(new Blob([text],{type})),a=el('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
export async function mountBrowserTool(container,id,{notify=()=>{}}={}){
  let disposed=false,cleanups=[];const report=el('p','tool-feedback');report.setAttribute('role','status');
  const fail=error=>{if(!disposed){report.textContent='无法处理：'+(error.message||error);report.classList.add('is-error');}};
  const safe=fn=>async()=>{report.textContent='';report.classList.remove('is-error');try{await fn();}catch(error){fail(error);}};
  const actions=el('div','tool-actions'),result=el('div','tool-result');
  container.append(report);
  if(id==='qr-code'){
    const input=field(container,'文字或网址','textarea','https://songuu.top/');let qrUrl,qrGeneration=0;
    cleanups.push(()=>{qrGeneration++;if(qrUrl)URL.revokeObjectURL(qrUrl);});
    const QRCode=(await import('qrcode')).default;if(disposed)return;
    button(actions,'生成二维码',safe(async()=>{
      if(!input.value.trim())throw new Error('请先输入内容。');if(new TextEncoder().encode(input.value).length>2000)throw new Error('内容过长，请控制在 2000 字节内。');
      const stamp=++qrGeneration,canvas=el('canvas','qr-preview');await QRCode.toCanvas(canvas,input.value,{width:320,margin:3,errorCorrectionLevel:'M'});
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(disposed||stamp!==qrGeneration)return;if(!blob)throw new Error('二维码图片生成失败，请重试。');
      if(qrUrl)URL.revokeObjectURL(qrUrl);qrUrl=URL.createObjectURL(blob);const a=el('a','secondary-button','下载 PNG');a.href=qrUrl;a.download='songuu-qrcode.png';result.replaceChildren(canvas,a);
    }),true);
  }else if(id==='markdown'){
    const input=field(container,'Markdown 内容','textarea','# 让文字更清楚\n\n- 支持标题、列表和表格\n- 内容在当前浏览器处理\n\n**从这里开始写作。**');
    const [{marked},{default:DOMPurify}]=await Promise.all([import('marked'),import('dompurify')]);if(disposed)return;
    result.classList.add('markdown-preview');
    const render=()=>{
      if(input.value.length>200000)throw new Error('文档需小于 20 万字符。');
      // Parse raw HTML in an inert template, then allow only document markup.
      // Resource attributes such as table[background] must never trigger a
      // request merely because a private document was pasted for preview.
      const template=document.createElement('template');template.innerHTML=marked.parse(input.value);
      const fragment=DOMPurify.sanitize(template.content,{RETURN_DOM_FRAGMENT:true,ALLOWED_TAGS:['h1','h2','h3','h4','h5','h6','p','br','hr','ul','ol','li','em','strong','b','i','s','del','blockquote','pre','code','table','thead','tbody','tfoot','tr','th','td','a','span','sup','sub','dl','dt','dd'],ALLOWED_ATTR:['href','title','colspan','rowspan']});
      result.replaceChildren(fragment);for(const a of result.querySelectorAll('a')){a.rel='noopener noreferrer';a.target='_blank';}return result.innerHTML;
    };
    input.oninput=safe(render);button(actions,'更新预览',safe(render),true);
    button(actions,'下载 HTML',safe(()=>{const html=render();downloadText('songuu-document.html','<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Songuu 文档</title><style>body{max-width:850px;margin:40px auto;padding:20px;font:16px/1.8 sans-serif}pre{white-space:pre-wrap}table,td,th{border:1px solid #ccc;border-collapse:collapse;padding:8px}</style><body>'+html+'</body></html>','text/html;charset=utf-8');}));
    button(actions,'打印 / 保存 PDF',safe(()=>{render();window.print();}));render();
  }else if(id==='temp-clipboard'){
    let initial='';try{initial=localStorage.getItem('songuu-tool-notes-v1')||'';}catch{report.textContent='当前浏览器无法保存，仍可编辑和下载。';}
    const input=field(container,'本机便笺内容','textarea',initial);input.maxLength=200000;
    input.oninput=()=>{try{localStorage.setItem('songuu-tool-notes-v1',input.value);report.textContent='已保存到当前浏览器 · '+input.value.length+' 字符';}catch{fail(new Error('保存失败，请下载文本备份。'));}};
    button(actions,'下载 TXT',()=>downloadText('songuu-notes.txt',input.value),true);
    button(actions,'复制文字',safe(async()=>{await navigator.clipboard.writeText(input.value);notify('文字已复制');}));
  }else if(id==='world-clock'){
    result.classList.add('world-clock-grid');
    const cities=[['北京','Asia/Shanghai'],['东京','Asia/Tokyo'],['新加坡','Asia/Singapore'],['迪拜','Asia/Dubai'],['伦敦','Europe/London'],['巴黎','Europe/Paris'],['纽约','America/New_York'],['洛杉矶','America/Los_Angeles']];
    const clocks=cities.map(([city,timeZone])=>{const card=el('article','world-clock-card'),time=el('strong'),date=el('span');card.append(el('h3','',city),time,date,el('small','',timeZone));result.append(card);return {time,date,timeZone};});
    const tick=()=>{for(const clock of clocks){const now=new Date();clock.time.textContent=new Intl.DateTimeFormat('zh-CN',{timeZone:clock.timeZone,hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(now);clock.date.textContent=new Intl.DateTimeFormat('zh-CN',{timeZone:clock.timeZone,month:'long',day:'numeric',weekday:'short'}).format(now);}};tick();const timer=setInterval(tick,1000);cleanups.push(()=>clearInterval(timer));
  }else if(id==='stopwatch'){
    const mode=field(container,'倒计时秒数（留空为秒表）','number','');mode.min='1';mode.max='86400';const display=el('p','timer-display','00:00.0'),laps=el('pre','tool-output');result.append(display,laps);
    let started=0,elapsed=0,running=false,target=0,interval;const format=ms=>{const value=Math.max(0,ms);return String(Math.floor(value/60000)).padStart(2,'0')+':'+String(Math.floor(value/1000)%60).padStart(2,'0')+'.'+Math.floor(value/100)%10;};
    const tick=()=>{const passed=elapsed+(running?performance.now()-started:0);display.textContent=format(target?target-passed:passed);if(target&&passed>=target){elapsed=target;running=false;mode.disabled=false;report.textContent='倒计时结束。';}};
    button(actions,'开始 / 暂停',safe(()=>{if(running){elapsed+=performance.now()-started;running=false;mode.disabled=false;}else{const seconds=Number(mode.value);if(mode.value&&(!Number.isFinite(seconds)||seconds<1||seconds>86400))throw new Error('倒计时需为 1–86400 秒。');target=seconds*1000;if(target&&elapsed>=target)elapsed=0;started=performance.now();running=true;mode.disabled=true;}tick();}),true);
    button(actions,'计次',()=>{if(!target)laps.textContent+=format(elapsed+(running?performance.now()-started:0))+'\n';});
    button(actions,'重置',()=>{running=false;elapsed=0;target=0;mode.disabled=false;laps.textContent='';tick();});interval=setInterval(tick,80);cleanups.push(()=>clearInterval(interval));
  }else if(id==='color-picker'){
    const swatch=el('div','color-swatch'),input=field(container,'颜色','color','#2c74e8'),output=el('pre','tool-output');result.append(swatch,output);
    const render=hex=>{input.value=hex;swatch.style.backgroundColor=hex;output.textContent=hex.toUpperCase()+'\nrgb('+[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)).join(', ')+')';};input.oninput=()=>render(input.value);render(input.value);
    const b=button(actions,'从屏幕取色',safe(async()=>{if(!window.EyeDropper)throw new Error('此浏览器不支持屏幕取色，可使用上方颜色选择器。');try{const result=await new window.EyeDropper().open();if(!disposed)render(result.sRGBHex);}catch(error){if(error.name!=='AbortError')throw error;}}),true);if(!window.EyeDropper){b.disabled=true;report.textContent='此浏览器不支持 EyeDropper；可以使用颜色选择器。';}
    button(actions,'复制色值',safe(async()=>{await navigator.clipboard.writeText(output.textContent);notify('色值已复制');}));
  }else if(id==='environment-diagnoser'){
    const data={userAgent:navigator.userAgent,language:navigator.language,languages:navigator.languages,viewport:{width:innerWidth,height:innerHeight},screen:{width:screen.width,height:screen.height,pixelRatio:devicePixelRatio},timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,online:navigator.onLine,secureContext:window.isSecureContext,features:{webCrypto:!!crypto.subtle,webAudio:!!window.AudioContext,screenColorPicker:!!window.EyeDropper,webRTC:!!window.RTCPeerConnection,webAssembly:!!window.WebAssembly}};
    result.append(el('pre','tool-output',JSON.stringify(data,null,2)));button(actions,'导出 JSON',()=>downloadText('browser-environment.json',JSON.stringify(data,null,2),'application/json'),true);
  }else if(id==='text-to-speech'){
    const input=field(container,'朗读文字','textarea','你好，欢迎来到 Songuu 导航。'),notice=el('p','tool-note','语音由浏览器和系统提供；部分语音可能使用系统的在线语音服务。');container.append(notice);
    if(!window.speechSynthesis){report.textContent='当前浏览器不支持语音合成。';}
    else{const wrap=el('label','field','选择语音'),voices=el('select');wrap.append(voices);container.append(wrap);const fill=()=>{voices.replaceChildren(...speechSynthesis.getVoices().map((v,i)=>{const o=el('option','',v.name+' · '+v.lang);o.value=String(i);return o;}));};fill();speechSynthesis.addEventListener('voiceschanged',fill);cleanups.push(()=>{speechSynthesis.removeEventListener('voiceschanged',fill);speechSynthesis.cancel();});
      button(actions,'开始朗读',safe(()=>{if(!input.value.trim())throw new Error('请输入朗读文字。');if(input.value.length>10000)throw new Error('每次请控制在 10000 字符内。');speechSynthesis.cancel();const utterance=new SpeechSynthesisUtterance(input.value);utterance.voice=speechSynthesis.getVoices()[Number(voices.value)]||null;utterance.lang=utterance.voice?.lang||'zh-CN';utterance.onerror=event=>{if(!['interrupted','canceled'].includes(event.error))fail(new Error('朗读失败：'+event.error));};speechSynthesis.speak(utterance);}),true);button(actions,'停止',()=>speechSynthesis.cancel());}
  }else if(id==='what-to-eat'){
    const input=field(container,'候选菜单（每行一项）','textarea','米饭套餐\n面条\n饺子\n沙拉\n火锅\n自己下厨'),choice=el('p','random-choice','今天吃点什么？');result.append(choice);
    button(actions,'帮我选一个',safe(()=>{const choices=input.value.split('\n').map(x=>x.trim()).filter(Boolean);if(!choices.length)throw new Error('请至少输入一个选项。');if(choices.length>10000)throw new Error('候选项需少于 10000 个。');const range=Math.floor(0x100000000/choices.length)*choices.length;let value;do{value=crypto.getRandomValues(new Uint32Array(1))[0];}while(value>=range);choice.textContent=choices[value%choices.length];}),true);
  }
  if(!disposed)container.append(actions,result);return ()=>{disposed=true;for(const cleanup of cleanups)cleanup();};
}
