import {fitDimensions,gridRects,stitchPlan,alphaBounds,encodeWav,validateDimensions,extractZip,inspectImage,inspectAudio,ARCHIVE_LIMITS} from './tools-media-core.js';

export const MEDIA_TOOLS=[
  {id:'image-converter',title:'图片格式转换',category:'image',description:'本地读取 PNG、JPEG、静态 WebP、BMP、GIF 首帧，转换 PNG、JPEG、WebP。',icon:'↔',keywords:['图片','转换','jpg','png','webp','bmp']},
  {id:'image-compressor',title:'图片压缩',category:'image',description:'调整图片质量与宽度，预览输出并比较处理前后大小。',icon:'▧',keywords:['图片','压缩','缩放','质量']},
  {id:'grid-splitter',title:'九宫格切图',category:'image',description:'将图片均匀切成九份，可逐张保存或打包下载 ZIP。',icon:'▦',keywords:['九宫格','图片','切图','zip']},
  {id:'screenshot-stitcher',title:'长截图拼接',category:'image',description:'调整图片顺序，按统一宽高横向或纵向拼接成长图。',icon:'▤',keywords:['图片','长图','拼接','截图']},
  {id:'pixel-art',title:'图片转像素画',category:'image',description:'设置像素块大小，生成复古风格像素画 PNG。',icon:'▩',keywords:['图片','像素','pixel','8bit']},
  {id:'icon-cropper',title:'透明图标裁剪',category:'image',description:'自动裁掉透明边缘，放大图标主体，保存为透明 PNG。',icon:'⌗',keywords:['图标','透明','裁剪','放大']},
  {id:'archive-extractor',title:'ZIP 在线解压',category:'file',description:'本地解析 ZIP、筛选文件并逐项下载；支持 Store 和 Deflate。',icon:'▣',keywords:['解压','zip','文件','压缩包']},
  {id:'audio-editor',title:'音频裁剪',category:'audio',description:'本地读取标准 PCM WAV 或 MP3，预览波形并裁剪导出 WAV。',icon:'♫',keywords:['音频','剪辑','裁剪','wav','mp3']},
];

const IMAGE_ACCEPT='image/png,image/jpeg,image/webp,image/gif,image/bmp';
const el=(tag,className,text)=>{const element=document.createElement(tag);if(className)element.className=className;if(text!==undefined)element.textContent=text;return element;};
const formatBytes=bytes=>bytes<1024?`${bytes} B`:bytes<1024*1024?`${(bytes/1024).toFixed(1)} KB`:`${(bytes/1024/1024).toFixed(2)} MB`;
function canvas(width,height){validateDimensions(width,height);const result=document.createElement('canvas');result.width=width;result.height=height;return result;}
function context(target){const result=target.getContext('2d');if(!result)throw new Error('当前浏览器无法创建图片画布。');return result;}
function canvasBlob(target,type='image/png',quality=0.85){return new Promise((resolve,reject)=>target.toBlob(blob=>{if(!blob)reject(new Error('图片导出失败，可能超出浏览器可用内存。'));else if(blob.type!==type)reject(new Error('当前浏览器不支持此输出格式，请选择 PNG 或 JPEG。'));else resolve(blob);},type,quality));}
function integer(input,min,max,label){const value=Number(input.value);if(!Number.isInteger(value)||value<min||value>max)throw new Error(`${label}需为 ${min}–${max} 的整数。`);return value;}
function number(input,min,max,label){const value=Number(input.value);if(!Number.isFinite(value)||value<min||value>max)throw new Error(`${label}需在 ${min}–${max} 之间。`);return value;}

export function audioMetadata(url,signal){
  return new Promise((resolve,reject)=>{
    const audio=document.createElement('audio');let timer;
    const cleanup=()=>{clearTimeout(timer);audio.removeEventListener('loadedmetadata',loaded);audio.removeEventListener('error',failed);signal.removeEventListener('abort',aborted);audio.pause();audio.removeAttribute('src');audio.load();};
    const finish=(error,value)=>{cleanup();if(error)reject(error);else resolve(value);};
    const loaded=()=>{const duration=audio.duration;if(!Number.isFinite(duration)||duration<=0||duration>600)finish(new Error('音频元数据时长无效或超过 10 分钟，已停止解码。'));else finish(null,{duration});};
    const failed=()=>finish(new Error('无法读取音频元数据，请选择结构完整的 WAV 或 MP3。'));
    const aborted=()=>finish(new Error('音频加载已取消。'));
    if(signal.aborted){aborted();return;}
    audio.preload='metadata';audio.addEventListener('loadedmetadata',loaded);audio.addEventListener('error',failed);signal.addEventListener('abort',aborted,{once:true});timer=setTimeout(()=>finish(new Error('读取音频元数据超时（10 秒），已停止解码。')),10000);audio.src=url;audio.load();
  });
}

/** Every tool owns its object URLs and invalidates pending work when unmounted. */
export function mountMediaTool(container,id,{notify=()=>{}}={}){
  const descriptor=MEDIA_TOOLS.find(tool=>tool.id===id);if(!descriptor)throw new Error('未找到媒体工具。');
  let alive=true,generation=0,fieldIndex=0,audioContext=null,audioSourceFile=null,audioSourceUrl=null;
  const lifetime=new AbortController();
  const urls=new Set();
  const urlFor=blob=>{const url=URL.createObjectURL(blob);urls.add(url);return url;};
  const releaseUrls=()=>{for(const url of urls)URL.revokeObjectURL(url);urls.clear();};
  const sourceUrl=file=>{if(audioSourceFile!==file){if(audioSourceUrl)URL.revokeObjectURL(audioSourceUrl);audioSourceFile=file;audioSourceUrl=URL.createObjectURL(file);}return audioSourceUrl;};
  const fields=el('div','tool-fields'),actions=el('div','tool-actions'),message=el('p','tool-message'),result=el('div','tool-result');message.setAttribute('role','status');message.setAttribute('aria-live','polite');
  container.replaceChildren(el('p','tool-local-note','文件仅在当前浏览器处理，不上传。'),fields,actions,message,result);
  function field(label,type='text',options={}){
    const wrap=el('label','field'),caption=el('span','',label),input=el(type==='select'?'select':'input');
    input.id=`media-${id}-${++fieldIndex}`;caption.htmlFor=input.id;
    if(type!=='select')input.type=type;
    for(const [key,value] of Object.entries(options))if(key==='choices')for(const [choiceValue,text] of value){const option=el('option','',text);option.value=choiceValue;input.append(option);}else input[key]=value;
    wrap.append(caption,input);fields.append(wrap);return input;
  }
  const active=stamp=>alive&&generation===stamp;
  function button(label,handler,secondary=false){const button=el('button',secondary?'secondary-button':'primary-button',label);button.type='button';button.onclick=handler;actions.append(button);return button;}
  function showDownload(blob,name,label=name,parent=result){const link=el('a','secondary-button',label);link.href=urlFor(blob);link.download=name;parent.append(link);return link;}
  async function execute(action){
    const stamp=++generation,controls=Array.from(container.querySelectorAll('input,select,button'),control=>({control,disabled:control.disabled}));
    message.textContent='正在本地处理…';for(const {control} of controls)control.disabled=true;
    try{await action(stamp);if(active(stamp))message.textContent='处理完成。';}
    catch(error){if(active(stamp)){message.textContent=`处理失败：${error instanceof Error?error.message:String(error)}`;notify('处理失败，请检查输入。');}}
    finally{if(active(stamp))for(const {control,disabled} of controls)control.disabled=disabled;}
  }
  const stopPreviewAudio=()=>{for(const audio of result.querySelectorAll('audio')){audio.pause();audio.removeAttribute('src');audio.load();}};
  const resetResult=()=>{stopPreviewAudio();releaseUrls();result.replaceChildren();};
  async function readImage(file){
    if(!file)throw new Error('请先选择一张图片。');
    if(file.size>20*1024*1024)throw new Error('单张图片不能超过 20 MB。');
    if(typeof createImageBitmap!=='function')throw new Error('当前浏览器不支持本地图片解码，请使用新版 Chrome、Edge 或 Firefox。');
    const bytes=new Uint8Array(await file.arrayBuffer()),metadata=inspectImage(bytes);
    if(!alive)throw new Error('图片处理已取消。');
    let bitmap;try{bitmap=await createImageBitmap(new Blob([bytes],{type:metadata.type}));}catch{throw new Error('浏览器无法解码此图片，请转换成 PNG、JPEG 或 WebP 后重试。');}
    if(bitmap.width*bitmap.height>32_000_000||bitmap.width>16384||bitmap.height>16384){bitmap.close();throw new Error('原图过大：最多 3200 万像素且每边不超过 16384 像素。');}
    return bitmap;
  }
  async function showImage(target,name,type,stamp,sourceSize){
    const blob=await canvasBlob(target,type);
    if(!active(stamp))return;
    resetResult();const preview=el('img','media-preview');preview.alt='处理后的图片预览';preview.src=urlFor(blob);preview.style.maxWidth='100%';preview.style.maxHeight='420px';preview.style.objectFit='contain';
    result.append(el('p','',`${target.width} × ${target.height} · ${formatBytes(blob.size)}${sourceSize?` · 原文件 ${formatBytes(sourceSize)}`:''}`),preview);
    showDownload(blob,name,'下载处理结果');
  }

  if(['image-converter','image-compressor','grid-splitter','pixel-art','icon-cropper'].includes(id)){
    const file=field('选择图片','file',{accept:IMAGE_ACCEPT});
    const format=['image-converter','image-compressor'].includes(id)?field('输出格式','select',{choices:[['image/webp','WebP'],['image/jpeg','JPEG（白色背景）'],['image/png','PNG（保留透明）']]}):null;
    const width=['image-converter','image-compressor'].includes(id)?field('最大宽度（不放大）','number',{value:1920,min:1,max:8192}):null;
    const quality=format?field('质量（JPEG / WebP）','number',{value:85,min:1,max:100}):null;
    const block=id==='pixel-art'?field('像素块边长','number',{value:12,min:2,max:128}):null;
    const cropSize=id==='icon-cropper'?field('裁剪后最大边长','number',{value:512,min:1,max:4096}):null;
    container.insertBefore(el('p','tool-help',id==='icon-cropper'?'仅自动裁剪完全透明边缘；纯色背景不会自动移除。':id==='grid-splitter'?'按从左到右、从上到下排列。GIF 只处理首帧；不支持动画 WebP / PNG、AVIF、HEIC、SVG。':'GIF 只处理首帧；不支持动画 WebP / PNG、AVIF、HEIC、SVG。输出大小由格式与内容决定，PNG 不保证比原图更小。'),fields);
    button(id==='grid-splitter'?'切成九宫格':id==='pixel-art'?'生成像素画':id==='icon-cropper'?'裁剪并放大':'处理图片',()=>void execute(async stamp=>{
      const selected=file.files[0],image=await readImage(selected);
      try{
        if(!active(stamp))return;
        if(id==='grid-splitter'){
          const rects=gridRects(image.width,image.height),files={};const blobs=[];
          for(let i=0;i<rects.length;i++){const rect=rects[i],target=canvas(rect.width,rect.height);context(target).drawImage(image,rect.x,rect.y,rect.width,rect.height,0,0,rect.width,rect.height);const blob=await canvasBlob(target);if(!active(stamp))return;blobs.push(blob);files[`grid-${i+1}.png`]=new Uint8Array(await blob.arrayBuffer());}
          const {zipSync}=await import('fflate');if(!active(stamp))return;const zip=new Blob([zipSync(files,{level:0})],{type:'application/zip'});resetResult();const grid=el('div','media-grid');grid.style.cssText='display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px';
          blobs.forEach((blob,i)=>{const cell=el('div'),preview=el('img','media-preview');preview.src=urlFor(blob);preview.alt=`第 ${i+1} 格`;preview.style.width='100%';cell.append(preview);showDownload(blob,`grid-${i+1}.png`,`下载第 ${i+1} 格`,cell);grid.append(cell);});result.append(grid);showDownload(zip,'nine-grid.zip','下载全部九张 ZIP');return;
        }
        if(id==='icon-cropper'){
          const original=canvas(image.width,image.height),ctx=context(original);ctx.drawImage(image,0,0);const bounds=alphaBounds(ctx.getImageData(0,0,image.width,image.height).data,image.width,image.height);if(!bounds)throw new Error('图片完全透明，没有可裁剪内容。');
          const max=integer(cropSize,1,4096,'边长'),scale=max/Math.max(bounds.width,bounds.height),target=canvas(Math.max(1,Math.round(bounds.width*scale)),Math.max(1,Math.round(bounds.height*scale)));context(target).drawImage(image,bounds.x,bounds.y,bounds.width,bounds.height,0,0,target.width,target.height);await showImage(target,'cropped-icon.png','image/png',stamp,selected.size);return;
        }
        const dimensions=width?fitDimensions(image.width,image.height,integer(width,1,8192,'最大宽度')):validateDimensions(image.width,image.height),target=canvas(dimensions.width,dimensions.height),ctx=context(target);
        if(id==='pixel-art'){
          const size=integer(block,2,128,'像素块边长'),small=canvas(Math.max(1,Math.ceil(image.width/size)),Math.max(1,Math.ceil(image.height/size)));context(small).drawImage(image,0,0,small.width,small.height);ctx.imageSmoothingEnabled=false;ctx.drawImage(small,0,0,target.width,target.height);await showImage(target,'pixel-art.png','image/png',stamp,selected.size);return;
        }
        const mime=format.value;if(mime==='image/jpeg'){ctx.fillStyle='#ffffff';ctx.fillRect(0,0,target.width,target.height);}ctx.drawImage(image,0,0,target.width,target.height);const blob=await canvasBlob(target,mime,integer(quality,1,100,'质量')/100);if(!active(stamp))return;resetResult();const preview=el('img','media-preview');preview.alt='处理后的图片预览';preview.src=urlFor(blob);preview.style.cssText='max-width:100%;max-height:420px;object-fit:contain';const saved=((1-blob.size/selected.size)*100).toFixed(1);result.append(el('p','',`${target.width} × ${target.height} · 原文件 ${formatBytes(selected.size)} → ${formatBytes(blob.size)}（${Number(saved)>=0?'减少':'增加'} ${Math.abs(Number(saved))}%）`),preview);showDownload(blob,`converted.${mime==='image/jpeg'?'jpg':mime.split('/')[1]}`,'下载处理结果');
      }finally{image.close();}
    }));
  }

  if(id==='screenshot-stitcher'){
    const file=field('添加图片（最多 12 张）','file',{accept:IMAGE_ACCEPT,multiple:true}),direction=field('拼接方向','select',{choices:[['vertical','纵向长图'],['horizontal','横向长图']]}),size=field('统一宽度 / 高度（像素）','number',{value:1200,min:1,max:8192});
    const order=el('div','media-file-order');fields.append(order);let selected=[];
    const renderOrder=()=>{order.replaceChildren();selected.forEach((item,i)=>{const row=el('div','media-file-row'),up=el('button','secondary-button','↑'),down=el('button','secondary-button','↓');row.append(el('span','',`${i+1}. ${item.name}`));for(const [control,delta] of [[up,-1],[down,1]]){control.type='button';control.setAttribute('aria-label',`${delta<0?'上移':'下移'} ${item.name}`);control.disabled=i+delta<0||i+delta>=selected.length;control.onclick=()=>{[selected[i],selected[i+delta]]=[selected[i+delta],selected[i]];renderOrder();};row.append(control);}order.append(row);});};
    file.onchange=()=>{selected=Array.from(file.files);renderOrder();};
    container.insertBefore(el('p','tool-help','按列表顺序拼接，不自动检测截图重叠。总原图最多 3200 万像素；成图每边最多 8192 像素。'),fields);
    button('拼接图片',()=>void execute(async stamp=>{
      if(!selected.length||selected.length>12)throw new Error('请选择 1–12 张图片。');const snapshot=[...selected],images=[];let totalPixels=0;
      try{for(const item of snapshot){const bitmap=await readImage(item);images.push(bitmap);if(!active(stamp))return;totalPixels+=bitmap.width*bitmap.height;if(totalPixels>32_000_000)throw new Error('原图总量不能超过 3200 万像素，请缩小图片或减少数量。');}
        const plan=stitchPlan(images,direction.value,integer(size,1,8192,'统一尺寸')),target=canvas(plan.width,plan.height),ctx=context(target);ctx.fillStyle='#ffffff';ctx.fillRect(0,0,target.width,target.height);images.forEach((image,i)=>{const rect=plan.images[i];ctx.drawImage(image,rect.x,rect.y,rect.width,rect.height);});await showImage(target,'stitched.png','image/png',stamp);
      }finally{images.forEach(image=>image.close());}
    }));
  }

  if(id==='archive-extractor'){
    const file=field('选择 ZIP 压缩包','file',{accept:'.zip,application/zip,application/x-zip-compressed'}),search=field('筛选文件名','search',{placeholder:'输入文件名关键词'});let extracted=[];
    container.insertBefore(el('p','tool-help','仅支持未加密的普通 ZIP（Store / Deflate）。压缩包最多 20 MB、200 个文件，解压总量最多 64 MB。文件仅下载到浏览器，不写入任意磁盘路径。'),fields);
    function renderFiles(){resetResult();const matches=extracted.filter(item=>item.name.toLocaleLowerCase().includes(search.value.toLocaleLowerCase()));result.append(el('p','',`共 ${extracted.length} 个文件，当前显示 ${matches.length} 个。`));for(const item of matches){const row=el('div','media-file-row');row.append(el('span','',`${item.name} · ${formatBytes(item.bytes.length)}`));showDownload(new Blob([item.bytes],{type:'application/octet-stream'}),item.name.split('/').at(-1),'下载',row);result.append(row);}}
    search.oninput=renderFiles;
    button('本地解压',()=>void execute(async stamp=>{
      const selected=file.files[0];if(!selected)throw new Error('请先选择 ZIP 文件。');if(selected.size>ARCHIVE_LIMITS.compressed)throw new Error('ZIP 压缩包不能超过 20 MB。');const bytes=new Uint8Array(await selected.arrayBuffer());if(!active(stamp))return;
      const files=await extractZip(bytes,{shouldContinue:()=>active(stamp)});if(!active(stamp))return;extracted=files;renderFiles();
    }));
  }

  if(id==='audio-editor'){
    const file=field('选择音频（WAV / MP3）','file',{accept:'.wav,.mp3,audio/wav,audio/x-wav,audio/mpeg'}),start=field('开始时间（秒）','number',{value:0,min:0,step:0.01}),end=field('结束时间（秒）','number',{value:10,min:0,step:0.01});let decoded=null,loadedFile=null;
    container.insertBefore(el('p','tool-help','仅支持结构完整的标准 PCM / 浮点 WAV 和 MP3。解码前预检采样量及浏览器元数据；最多 30 MB、10 分钟、3200 万采样。导出 16-bit PCM WAV，不支持多轨合并。'),fields);
    const load=async stamp=>{
      const selected=file.files[0];if(!selected)throw new Error('请先选择音频文件。');if(selected.size>30*1024*1024)throw new Error('音频文件不能超过 30 MB。');
      if(loadedFile===selected&&decoded)return decoded;
      decoded=null;loadedFile=null;
      const bytes=await selected.arrayBuffer(),info=inspectAudio(new Uint8Array(bytes));if(!active(stamp))return null;
      const metadata=await audioMetadata(sourceUrl(selected),lifetime.signal);if(!active(stamp))return null;
      if(Math.abs(metadata.duration-info.duration)>Math.max(0.25,info.duration*0.01))throw new Error('音频元数据与采样头时长不一致，已停止解码。');
      const AudioContextClass=window.AudioContext||window.webkitAudioContext;if(!AudioContextClass)throw new Error('当前浏览器不支持本地音频解码。');
      if(audioContext&&audioContext.state!=='closed')await audioContext.close();audioContext=null;if(!active(stamp))return null;
      try{audioContext=new AudioContextClass({sampleRate:Math.min(48000,info.sampleRate)});}catch{throw new Error('当前浏览器不支持此采样率，请先转换为 44.1 kHz 或 48 kHz WAV。');}
      if(info.duration*audioContext.sampleRate*info.channels>32_000_000)throw new Error('预计解码后的采样量超过 3200 万，已停止解码。');let buffer;
      try{buffer=await audioContext.decodeAudioData(bytes);}catch{throw new Error('无法解码此音频，请使用结构完整的标准 WAV 或 MP3。');}
      if(buffer.duration>600||buffer.numberOfChannels>8||buffer.length*buffer.numberOfChannels>32_000_000)throw new Error('音频太长或声道过多，请选择 10 分钟以内、总采样量较小的音频。');
      if(!active(stamp))return null;decoded=buffer;loadedFile=selected;return buffer;
    };
    button('加载音频并预览',()=>void execute(async stamp=>{
      const buffer=await load(stamp);if(!buffer||!active(stamp))return;resetResult();end.value=String(buffer.duration);start.value='0';
      const audio=el('audio');audio.controls=true;audio.src=sourceUrl(file.files[0]);audio.style.width='100%';const wave=canvas(900,120),ctx=context(wave),data=buffer.getChannelData(0);ctx.fillStyle='#f3f6fb';ctx.fillRect(0,0,900,120);ctx.strokeStyle='#3273e7';ctx.beginPath();const bucket=Math.max(1,Math.floor(data.length/900));for(let x=0;x<900;x++){let min=1,max=-1;for(let i=x*bucket;i<Math.min(data.length,(x+1)*bucket);i++){min=Math.min(min,data[i]);max=Math.max(max,data[i]);}ctx.moveTo(x,60+min*52);ctx.lineTo(x,60+max*52);}ctx.stroke();wave.style.width='100%';wave.setAttribute('aria-label','音频波形预览');result.append(el('p','',`${buffer.duration.toFixed(3)} 秒 · ${buffer.sampleRate} Hz · ${buffer.numberOfChannels} 声道`),audio,wave);
    }));
    button('裁剪并下载 WAV',()=>void execute(async stamp=>{const buffer=await load(stamp);if(!buffer||!active(stamp))return;const channels=Array.from({length:buffer.numberOfChannels},(_,i)=>buffer.getChannelData(i)),wav=encodeWav(channels,buffer.sampleRate,number(start,0,buffer.duration,'开始时间'),number(end,0,buffer.duration+0.000001,'结束时间'));if(!active(stamp))return;resetResult();const blob=new Blob([wav],{type:'audio/wav'}),audio=el('audio');audio.controls=true;audio.src=urlFor(blob);audio.style.width='100%';result.append(el('p','',`已裁剪：${start.value}–${end.value} 秒 · ${formatBytes(blob.size)}`),audio);showDownload(blob,'trimmed-audio.wav','下载 WAV');},true));
  }
  return ()=>{alive=false;generation++;lifetime.abort();stopPreviewAudio();releaseUrls();if(audioSourceUrl)URL.revokeObjectURL(audioSourceUrl);if(audioContext)void audioContext.close().catch(()=>{});};
}
