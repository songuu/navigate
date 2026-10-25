export const MAX_CANVAS_PIXELS=24_000_000;
export const MAX_CANVAS_SIDE=8192;
export const ARCHIVE_LIMITS={compressed:20*1024*1024,expanded:64*1024*1024,entries:200};
const MAX_SOURCE_PIXELS=32_000_000;
const MAX_SOURCE_SIDE=16384;
const bytesText=(bytes,start,length)=>new TextDecoder().decode(bytes.subarray(start,start+length));
const crcTable=Uint32Array.from({length:256},(_,value)=>{for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0);return value>>>0;});
export function crc32(bytes){let value=0xffffffff;for(const byte of bytes)value=(value>>>8)^crcTable[(value^byte)&255];return (value^0xffffffff)>>>0;}
function sourceDimensions(width,height){if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>MAX_SOURCE_SIDE||height>MAX_SOURCE_SIDE||width*height>MAX_SOURCE_PIXELS)throw new Error('原图尺寸过大或无效：最多 3200 万像素，每边最多 16384 像素。');return {width,height};}

/** Read each format's actual container/header structure before invoking a codec. */
export function inspectImage(bytes){
  if(!(bytes instanceof Uint8Array)||bytes.length<10||bytes.length>20*1024*1024)throw new Error('图片文件无效或超过 20 MB。');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),signature=bytesText(bytes,0,12);
  if(bytes[0]===137&&bytesText(bytes,1,3)==='PNG'&&bytes[4]===13&&bytes[5]===10&&bytes[6]===26&&bytes[7]===10){
    if(bytes.length<33||view.getUint32(8)!==13||bytesText(bytes,12,4)!=='IHDR')throw new Error('PNG 图片头损坏。');
    const dimensions=sourceDimensions(view.getUint32(16),view.getUint32(20));let cursor=8,ended=false;
    while(cursor+12<=bytes.length){const size=view.getUint32(cursor),type=bytesText(bytes,cursor+4,4);if(size>bytes.length-cursor-12)throw new Error('PNG 数据块越界。');if(type==='IHDR'&&cursor!==8)throw new Error('PNG 包含重复尺寸头。');if(type==='acTL')throw new Error('暂不支持动画 PNG，请先转换为静态 PNG。');if(type==='IEND'){if(size!==0)throw new Error('PNG 结束数据块无效。');ended=true;break;}cursor+=size+12;}
    if(!ended)throw new Error('PNG 文件不完整。');return {type:'image/png',...dimensions};
  }
  if(signature.startsWith('GIF87a')||signature.startsWith('GIF89a')){
    if(bytes.length<14)throw new Error('GIF 图片头损坏。');const width=view.getUint16(6,true),height=view.getUint16(8,true),dimensions=sourceDimensions(width,height);let cursor=13+(bytes[10]&128?3*(1<<((bytes[10]&7)+1)):0),totalPixels=0,ended=false;
    const skipBlocks=()=>{while(cursor<bytes.length){const size=bytes[cursor++];if(size===0)return;cursor+=size;if(cursor>bytes.length)throw new Error('GIF 数据块损坏。');}throw new Error('GIF 文件不完整。');};
    while(cursor<bytes.length){const marker=bytes[cursor++];if(marker===0x3b){ended=true;break;}if(marker===0x21){if(cursor>=bytes.length)throw new Error('GIF 扩展数据不完整。');cursor++;skipBlocks();continue;}if(marker!==0x2c||cursor+9>bytes.length)throw new Error('GIF 图像记录损坏。');
      const x=view.getUint16(cursor,true),y=view.getUint16(cursor+2,true),frameWidth=view.getUint16(cursor+4,true),frameHeight=view.getUint16(cursor+6,true);sourceDimensions(frameWidth,frameHeight);if(x+frameWidth>width||y+frameHeight>height)throw new Error('GIF 帧超出画布尺寸。');totalPixels+=frameWidth*frameHeight;if(totalPixels>MAX_SOURCE_PIXELS)throw new Error('GIF 动画总像素超过 3200 万，请改用静态图片。');const flags=bytes[cursor+8];cursor+=9+(flags&128?3*(1<<((flags&7)+1)):0);if(cursor>=bytes.length||bytes[cursor]<2||bytes[cursor]>8)throw new Error('GIF 编码数据无效。');cursor++;skipBlocks();
    }
    if(!ended)throw new Error('GIF 文件不完整。');return {type:'image/gif',...dimensions};
  }
  if(bytes[0]===255&&bytes[1]===216){
    let cursor=2,dimensions;
    while(cursor<bytes.length){if(bytes[cursor++]!==255)throw new Error('JPEG 数据段无效。');while(bytes[cursor]===255)cursor++;const marker=bytes[cursor++];if(marker===0xda){if(!dimensions)throw new Error('JPEG 缺少图像尺寸。');return {type:'image/jpeg',...dimensions};}if(marker===0xd9)break;if(marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;if(cursor+2>bytes.length)throw new Error('JPEG 数据段不完整。');const size=view.getUint16(cursor);if(size<2||cursor+size>bytes.length)throw new Error('JPEG 数据段越界。');
      if(marker>=0xc0&&marker<=0xcf&&![0xc4,0xc8,0xcc].includes(marker)){if(![0xc0,0xc1,0xc2].includes(marker)||size<8||bytes[cursor+2]!==8||![1,3,4].includes(bytes[cursor+7])||size!==8+3*bytes[cursor+7])throw new Error('暂不支持此 JPEG 编码。');const parsed=sourceDimensions(view.getUint16(cursor+5),view.getUint16(cursor+3));if(dimensions&&(parsed.width!==dimensions.width||parsed.height!==dimensions.height))throw new Error('JPEG 多帧尺寸不一致。');dimensions=parsed;}cursor+=size;
    }
    throw new Error('JPEG 图片头不完整。');
  }
  if(signature.startsWith('RIFF')&&bytesText(bytes,8,4)==='WEBP'){
    if(bytes.length<20||view.getUint32(4,true)+8!==bytes.length)throw new Error('WebP 容器长度无效。');let cursor=12,dimensions,canvasDimensions;
    const uint24=offset=>bytes[offset]|bytes[offset+1]<<8|bytes[offset+2]<<16;
    while(cursor+8<=bytes.length){const type=bytesText(bytes,cursor,4),size=view.getUint32(cursor+4,true),start=cursor+8;if(size>bytes.length-start)throw new Error('WebP 数据块越界。');
      if(type==='VP8X'){if(size<10||bytes[start]&2)throw new Error('暂不支持动画 WebP，请先转换为静态图片。');canvasDimensions=sourceDimensions(uint24(start+4)+1,uint24(start+7)+1);}
      if(type==='ANIM'||type==='ANMF')throw new Error('暂不支持动画 WebP。');
      if(type==='VP8L'){if(size<5||bytes[start]!==0x2f||dimensions)throw new Error('WebP 像素数据头无效。');dimensions=sourceDimensions(((bytes[start+1]|bytes[start+2]<<8)&0x3fff)+1,((bytes[start+2]>>6|bytes[start+3]<<2|bytes[start+4]<<10)&0x3fff)+1);}
      if(type==='VP8 '){if(size<10||(bytes[start]&1)||bytes[start+3]!==0x9d||bytes[start+4]!==1||bytes[start+5]!==0x2a||dimensions)throw new Error('WebP 像素数据头无效。');dimensions=sourceDimensions(view.getUint16(start+6,true)&0x3fff,view.getUint16(start+8,true)&0x3fff);}
      cursor=start+size+(size&1);
    }
    if(cursor!==bytes.length||!dimensions||(canvasDimensions&&(dimensions.width!==canvasDimensions.width||dimensions.height!==canvasDimensions.height)))throw new Error('WebP 图像尺寸或结构不一致。');return {type:'image/webp',...dimensions};
  }
  if(bytes[0]===66&&bytes[1]===77){
    if(bytes.length<26)throw new Error('BMP 图片头损坏。');const size=view.getUint32(14,true);let width,height,planes,bits;
    if(size===12){width=view.getUint16(18,true);height=view.getUint16(20,true);planes=view.getUint16(22,true);bits=view.getUint16(24,true);}
    else if(size>=40&&size<=124&&14+size<=bytes.length){width=view.getInt32(18,true);height=Math.abs(view.getInt32(22,true));planes=view.getUint16(26,true);bits=view.getUint16(28,true);if(![0,3,6].includes(view.getUint32(30,true)))throw new Error('仅支持未压缩或 Bitfields 的 BMP。');}
    else throw new Error('暂不支持此 BMP 图片头。');
    if(planes!==1||![1,4,8,16,24,32].includes(bits)||view.getUint32(10,true)<14+size||view.getUint32(10,true)>bytes.length)throw new Error('BMP 像素记录无效。');return {type:'image/bmp',...sourceDimensions(width,height)};
  }
  throw new Error('无法安全读取图片尺寸。仅支持静态 PNG、JPEG、WebP、BMP 和 GIF；AVIF、HEIC、SVG 暂不支持。');
}

function audioAllocation(duration,channels,sampleRate,sampleCount){
  if(!Number.isFinite(duration)||duration<=0||duration>600||!Number.isInteger(channels)||channels<1||channels>8||!Number.isInteger(sampleRate)||sampleRate<1||sampleRate>192000||!Number.isFinite(sampleCount)||sampleCount>32_000_000)throw new Error('音频时长、声道或采样量超出限制：最多 10 分钟、8 声道、3200 万采样。');
}
/** Only formats whose sample allocation can be bounded from structure are decoded. */
export function inspectAudio(bytes){
  if(!(bytes instanceof Uint8Array)||bytes.length<12||bytes.length>30*1024*1024)throw new Error('音频文件无效或超过 30 MB。');const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(bytesText(bytes,0,4)==='RIFF'&&bytesText(bytes,8,4)==='WAVE'){
    if(view.getUint32(4,true)+8!==bytes.length)throw new Error('WAV 容器长度不一致。');let cursor=12,format,channels,sampleRate,blockAlign,bits,dataSize=0;
    while(cursor+8<=bytes.length){const type=bytesText(bytes,cursor,4),size=view.getUint32(cursor+4,true),start=cursor+8;if(size>bytes.length-start)throw new Error('WAV 数据块越界。');if(type==='fmt '){if(size<16||format!==undefined)throw new Error('WAV 格式数据损坏。');format=view.getUint16(start,true);channels=view.getUint16(start+2,true);sampleRate=view.getUint32(start+4,true);blockAlign=view.getUint16(start+12,true);bits=view.getUint16(start+14,true);if(![1,3].includes(format)||![8,16,24,32,64].includes(bits)||(format===3&&![32,64].includes(bits))||blockAlign!==channels*bits/8)throw new Error('WAV 仅支持标准 PCM 或浮点采样格式。');}if(type==='data')dataSize+=size;cursor=start+size+(size&1);}
    if(cursor!==bytes.length||!format||!dataSize||dataSize%blockAlign!==0)throw new Error('WAV 采样数据不完整。');const frames=dataSize/blockAlign,duration=frames/sampleRate,sampleCount=frames*channels;audioAllocation(duration,channels,sampleRate,sampleCount);return {type:'audio/wav',duration,channels,sampleRate,sampleCount};
  }
  let cursor=0;
  if(bytesText(bytes,0,3)==='ID3'){if(bytes.length<10||[bytes[6],bytes[7],bytes[8],bytes[9]].some(value=>value&128))throw new Error('MP3 ID3 标签无效。');const tagSize=bytes[6]*2097152+bytes[7]*16384+bytes[8]*128+bytes[9];cursor=10+tagSize+(bytes[5]&16?10:0);if(cursor>=bytes.length)throw new Error('MP3 缺少音频帧。');}
  let sampleRate,channels,frames=0,samples=0;
  while(cursor+4<=bytes.length){
    if(bytes.length-cursor===128&&bytesText(bytes,cursor,3)==='TAG'){cursor=bytes.length;break;}
    const header=view.getUint32(cursor),version=(header>>>19)&3,layer=(header>>>17)&3,bitrateIndex=(header>>>12)&15,rateIndex=(header>>>10)&3;
    if((header>>>21)!==0x7ff||version===1||layer!==1||bitrateIndex===0||bitrateIndex===15||rateIndex===3)throw new Error('MP3 帧结构无效，或音频格式暂不支持。');
    const rate=[44100,48000,32000][rateIndex]/(version===3?1:version===2?2:4),count=((header>>>6)&3)===3?1:2,bitrate=(version===3?[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320]:[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160])[bitrateIndex],frameSize=Math.floor((version===3?144000:72000)*bitrate/rate)+((header>>>9)&1);
    if(cursor+frameSize>bytes.length||frameSize<4||(sampleRate&&(sampleRate!==rate||channels!==count)))throw new Error('MP3 帧长度、采样率或声道不一致。');sampleRate=rate;channels=count;samples+=version===3?1152:576;frames++;audioAllocation(samples/rate,channels,rate,samples*channels);cursor+=frameSize;
  }
  if(!frames||cursor!==bytes.length)throw new Error('音频格式暂不支持。请选择结构完整的 PCM WAV 或 MP3。');return {type:'audio/mpeg',duration:samples/sampleRate,channels,sampleRate,sampleCount:samples*channels};
}

export function validateDimensions(width,height){
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>MAX_CANVAS_SIDE||height>MAX_CANVAS_SIDE||width*height>MAX_CANVAS_PIXELS)throw new Error('图片尺寸过大或无效：每边最多 8192 像素，总像素最多 2400 万。');
  return {width,height};
}
export function fitDimensions(width,height,maxWidth=1920){
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<1||height<1||!Number.isFinite(maxWidth)||maxWidth<1)throw new Error('请输入有效的图片尺寸。');
  const scale=Math.min(1,maxWidth/width);
  return validateDimensions(Math.max(1,Math.round(width*scale)),Math.max(1,Math.round(height*scale)));
}
export function gridRects(width,height){
  validateDimensions(width,height);
  if(width<3||height<3)throw new Error('九宫格图片宽高至少为 3 像素。');
  return Array.from({length:9},(_,i)=>{const col=i%3,row=Math.floor(i/3),x=Math.floor(col*width/3),y=Math.floor(row*height/3);return {x,y,width:Math.floor((col+1)*width/3)-x,height:Math.floor((row+1)*height/3)-y};});
}
export function stitchPlan(images,direction='vertical',size=1200){
  if(!images.length||images.length>12)throw new Error('请选择 1–12 张图片。');
  if(!['vertical','horizontal'].includes(direction)||!Number.isInteger(size)||size<1||size>MAX_CANVAS_SIDE)throw new Error('请输入有效的拼接方向和尺寸。');
  let position=0;
  const result=images.map(image=>{
    if(!Number.isFinite(image.width)||!Number.isFinite(image.height)||image.width<1||image.height<1)throw new Error('图片尺寸无效。');
    const scale=size/(direction==='vertical'?image.width:image.height);
    const width=Math.max(1,Math.round(image.width*scale)),height=Math.max(1,Math.round(image.height*scale));
    const row={width,height,x:direction==='vertical'?0:position,y:direction==='vertical'?position:0};position+=direction==='vertical'?height:width;return row;
  });
  return {...validateDimensions(direction==='vertical'?size:position,direction==='vertical'?position:size),images:result};
}
export function alphaBounds(pixels,width,height){
  validateDimensions(width,height);
  if(pixels.length!==width*height*4)throw new Error('图片像素数据不完整。');
  let left=width,top=height,right=-1,bottom=-1;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(pixels[(y*width+x)*4+3]>0){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}
  return right<0?null:{x:left,y:top,width:right-left+1,height:bottom-top+1};
}
export function encodeWav(channels,sampleRate,start=0,end=channels[0]?.length/sampleRate){
  if(!channels.length||channels.length>8||!Number.isInteger(sampleRate)||sampleRate<1||!channels[0]?.length||channels.some(channel=>channel.length!==channels[0].length))throw new Error('音频声道或采样率无效。');
  const duration=channels[0].length/sampleRate;
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>duration+0.000001)throw new Error('裁剪时间无效：结束时间须大于开始时间，且不超过音频长度。');
  const first=Math.floor(start*sampleRate),last=Math.min(channels[0].length,Math.floor(end*sampleRate)),frames=last-first;
  if(frames<1)throw new Error('裁剪时间过短，未包含完整采样。');
  const dataSize=frames*channels.length*2;
  if(dataSize>128*1024*1024)throw new Error('裁剪音频过大，请缩短时间或减少声道。');
  const buffer=new ArrayBuffer(44+dataSize),view=new DataView(buffer);
  const text=(offset,value)=>{for(let i=0;i<value.length;i++)view.setUint8(offset+i,value.charCodeAt(i));};
  text(0,'RIFF');view.setUint32(4,36+dataSize,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,channels.length,true);view.setUint32(24,sampleRate,true);view.setUint32(28,sampleRate*channels.length*2,true);view.setUint16(32,channels.length*2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,dataSize,true);
  let offset=44;for(let i=first;i<last;i++)for(const channel of channels){const sample=Math.max(-1,Math.min(1,Number.isFinite(channel[i])?channel[i]:0));view.setInt16(offset,Math.round(sample*(sample<0?32768:32767)),true);offset+=2;}
  return buffer;
}
export function validateArchivePath(path){
  if(typeof path!=='string'||!path||path.length>512||/[\\\u0000-\u001f\u007f:]/.test(path)||path.startsWith('/')||path.split('/').some((part,i,parts)=>part==='..'||part==='.'||(!part&&i!==parts.length-1)))throw new Error('ZIP 包含不安全的文件路径。');
  return path;
}
/** Preflight the central directory before a streaming decoder can allocate output. */
export function inspectZip(bytes){
  if(!(bytes instanceof Uint8Array)||bytes.length<22||bytes.length>ARCHIVE_LIMITS.compressed)throw new Error('ZIP 文件无效或超过 20 MB。');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let eocd=-1;
  for(let pos=bytes.length-22;pos>=Math.max(0,bytes.length-65557);pos--)if(view.getUint32(pos,true)===0x06054b50&&pos+22+view.getUint16(pos+20,true)===bytes.length){eocd=pos;break;}
  if(eocd<0)throw new Error('ZIP 目录缺失，文件可能损坏。');
  const count=view.getUint16(eocd+10,true),offset=view.getUint32(eocd+16,true),directorySize=view.getUint32(eocd+12,true);
  if(count===65535||offset===0xffffffff||directorySize===0xffffffff)throw new Error('暂不支持 ZIP64 格式。');
  if(view.getUint16(eocd+4,true)||view.getUint16(eocd+6,true)||view.getUint16(eocd+8,true)!==count)throw new Error('暂不支持分卷 ZIP。');
  if(count>ARCHIVE_LIMITS.entries)throw new Error('ZIP 文件数量不能超过 200。');
  if(offset+directorySize!==eocd||offset>eocd)throw new Error('ZIP 目录边界不正确。');
  let cursor=offset,totalSize=0;const entries=[],names=new Set();
  for(let i=0;i<count;i++){
    if(cursor+46>eocd||view.getUint32(cursor,true)!==0x02014b50)throw new Error('ZIP 目录记录损坏。');
    const flags=view.getUint16(cursor+8,true),method=view.getUint16(cursor+10,true),compressedSize=view.getUint32(cursor+20,true),size=view.getUint32(cursor+24,true),nameLength=view.getUint16(cursor+28,true),extraLength=view.getUint16(cursor+30,true),commentLength=view.getUint16(cursor+32,true),localOffset=view.getUint32(cursor+42,true);
    if(flags&1)throw new Error('暂不支持加密 ZIP，请先解密。');
    if(![0,8].includes(method))throw new Error('ZIP 仅支持 Store / Deflate 压缩方式。');
    if(size===0xffffffff||compressedSize===0xffffffff||localOffset===0xffffffff)throw new Error('暂不支持 ZIP64 格式。');
    if(cursor+46+nameLength+extraLength+commentLength>eocd||localOffset+30>offset||view.getUint32(localOffset,true)!==0x04034b50)throw new Error('ZIP 文件记录边界不正确。');
    const localData=localOffset+30+view.getUint16(localOffset+26,true)+view.getUint16(localOffset+28,true);
    if(localData+compressedSize>offset)throw new Error('ZIP 压缩数据越界。');
    const name=validateArchivePath(new TextDecoder().decode(bytes.subarray(cursor+46,cursor+46+nameLength)));
    if(names.has(name))throw new Error('ZIP 中存在重复文件名。');names.add(name);
    totalSize+=size;if(totalSize>ARCHIVE_LIMITS.expanded)throw new Error('ZIP 解压后总量不能超过 64 MB。');
    entries.push({name,size,compressedSize,method,crc:view.getUint32(cursor+16,true)});cursor+=46+nameLength+extraLength+commentLength;
  }
  if(cursor!==eocd)throw new Error('ZIP 目录长度不一致。');
  return {entries,totalSize};
}

/** Chunked inflate enforces actual output limits even when ZIP size fields lie. */
export async function extractZip(bytes,{shouldContinue=()=>true}={}){
  const metadata=inspectZip(bytes),expected=new Map(metadata.entries.map(entry=>[entry.name,entry]));
  const {Unzip,UnzipInflate}=await import('fflate');
  if(!shouldContinue())throw new Error('解压已取消。');
  const files=[],seen=new Set(),streams=[];let failure=null,expanded=0;
  const stop=error=>{failure=error;streams.forEach(stream=>stream.terminate());};
  const decoder=new Unzip(stream=>{
    streams.push(stream);let name;
    try{name=validateArchivePath(stream.name);}catch(error){stop(error);return;}
    const info=expected.get(name);
    if(!info||seen.has(name)){stop(new Error('ZIP 本地记录与文件目录不一致。'));return;}
    seen.add(name);
    if(stream.originalSize!==undefined&&stream.originalSize!==info.size){stop(new Error('ZIP 声明的文件大小不一致。'));return;}
    const chunks=[];let length=0;
    stream.ondata=(error,chunk,final)=>{
      if(failure)return;
      if(error){stop(new Error(`ZIP 解压失败：${name}`));return;}
      length+=chunk.length;expanded+=chunk.length;
      if(length>info.size||expanded>ARCHIVE_LIMITS.expanded){stop(new Error('ZIP 实际解压量超过安全限制或声明大小。'));return;}
      chunks.push(chunk);
      if(final){
        if(length!==info.size){stop(new Error('ZIP 文件长度与目录不一致。'));return;}
        if(!name.endsWith('/')){
          const output=new Uint8Array(length);let offset=0;
          for(const part of chunks){output.set(part,offset);offset+=part.length;}
          if(crc32(output)!==info.crc){stop(new Error(`ZIP 文件 CRC32 校验失败：${name}`));return;}
          files.push({name,bytes:output});
        }
      }
    };
    stream.start();
  });
  decoder.register(UnzipInflate);
  try{
    // Small input chunks bound the decoder's per-callback expansion before the
    // output counter gets a chance to stop a forged-size compression bomb.
    for(let offset=0;offset<bytes.length&&!failure;offset+=1024){
      if(!shouldContinue()){stop(new Error('解压已取消。'));break;}
      decoder.push(bytes.subarray(offset,Math.min(bytes.length,offset+1024)),offset+1024>=bytes.length);
    }
  }catch(error){stop(new Error(`ZIP 文件损坏：${error instanceof Error?error.message:'无法读取'}`));}
  if(failure)throw failure;
  if(seen.size!==expected.size)throw new Error('ZIP 文件记录不完整。');
  return files;
}
