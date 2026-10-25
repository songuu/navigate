import test from 'node:test';
import assert from 'node:assert/strict';
import {fitDimensions,gridRects,stitchPlan,alphaBounds,encodeWav,validateArchivePath,inspectZip,extractZip,inspectImage,inspectAudio} from '../src/tools-media-core.js';
import {zipSync,strToU8} from 'fflate';
import {audioMetadata} from '../src/tools-media.js';

test('image sizing preserves ratio and rejects excessive output',()=>{
  assert.deepEqual(fitDimensions(4000,2000,1000),{width:1000,height:500});
  assert.deepEqual(fitDimensions(300,200,1000),{width:300,height:200});
  assert.throws(()=>fitDimensions(0,100,100),/尺寸/);
  assert.throws(()=>fitDimensions(20000,20000,20000),/像素|尺寸/);
});
test('grid covers odd dimensions without dropping edge pixels',()=>{
  const cells=gridRects(10,11);assert.equal(cells.length,9);
  assert.equal(cells.reduce((sum,r)=>sum+r.width*r.height,0),110);
  assert.equal(cells[8].x+cells[8].width,10);
  assert.equal(cells[8].y+cells[8].height,11);
});
test('stitching aligns widths or heights, preserves order, enforces allocation limits',()=>{
  const plan=stitchPlan([{width:200,height:100},{width:100,height:100}],'vertical',200);
  assert.equal(plan.width,200);assert.equal(plan.height,300);assert.equal(plan.images[1].y,100);
  const horizontal=stitchPlan([{width:200,height:100},{width:100,height:100}],'horizontal',100);
  assert.equal(horizontal.width,300);assert.equal(horizontal.height,100);
  assert.throws(()=>stitchPlan([{width:8000,height:8000},{width:8000,height:8000}],'vertical',8000),/像素|尺寸/);
});
test('alpha crop finds nontransparent pixel bounds including a single edge pixel',()=>{
  const pixels=new Uint8ClampedArray(4*3*4);pixels[(1*4+2)*4+3]=255;
  assert.deepEqual(alphaBounds(pixels,4,3),{x:2,y:1,width:1,height:1});
  assert.equal(alphaBounds(new Uint8ClampedArray(16),2,2),null);
});
test('PCM WAV preserves channel ordering, samples and explicit range validation',()=>{
  const buffer=encodeWav([new Float32Array([-1,0,1,0.5]),new Float32Array([1,0,-1,0.25])],4,0,0.5);
  const view=new DataView(buffer);assert.equal(new TextDecoder().decode(new Uint8Array(buffer,0,4)),'RIFF');
  assert.equal(view.getUint16(22,true),2);assert.equal(view.getUint32(24,true),4);assert.equal(view.getUint32(40,true),8);
  assert.equal(view.getInt16(44,true),-32768);assert.equal(view.getInt16(46,true),32767);
  assert.throws(()=>encodeWav([new Float32Array(4)],4,1,0),/时间/);
  assert.throws(()=>encodeWav([new Float32Array(4)],4,0,2),/时间/);
});
test('archive paths cannot escape or contain invisible/control characters',()=>{
  assert.equal(validateArchivePath('docs/readme.txt'),'docs/readme.txt');
  for(const path of ['../x','a/../x','/etc/passwd','C:/x','a\\..\\x','x\u0000y','a//x'])assert.throws(()=>validateArchivePath(path),/路径/);
});
function emptyZip(){return new Uint8Array([80,75,5,6,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]);}
test('ZIP preflight accepts empty archive but rejects truncation and ZIP64',()=>{
  assert.deepEqual(inspectZip(emptyZip()),{entries:[],totalSize:0});
  assert.throws(()=>inspectZip(new Uint8Array([80,75])),/ZIP/);
  const bytes=emptyZip();new DataView(bytes.buffer).setUint16(10,65535,true);
  assert.throws(()=>inspectZip(bytes),/ZIP64|数量/);
});
test('bounded ZIP decoder extracts actual UTF-8 file bytes and omits directory entries',async()=>{
  assert.deepEqual(await extractZip(emptyZip()),[]);
  const archive=zipSync({'文档/':new Uint8Array(),'文档/说明.txt':strToU8('你好，Songuu!'),'other.txt':strToU8('hello')});
  const files=await extractZip(archive);
  assert.equal(files.length,2);assert.equal(new TextDecoder().decode(files.find(file=>file.name==='文档/说明.txt').bytes),'你好，Songuu!');
});
test('ZIP rejects traversal, excess entries and forged expansion sizes before download',async()=>{
  await assert.rejects(extractZip(zipSync({'../secret':strToU8('x')})),/路径/);
  const many=Object.fromEntries(Array.from({length:201},(_,i)=>[`${i}.txt`,new Uint8Array()]));
  await assert.rejects(extractZip(zipSync(many)),/200/);
  const forged=zipSync({'large.txt':new Uint8Array(20000)}),view=new DataView(forged.buffer,forged.byteOffset,forged.byteLength);
  view.setUint32(22,1,true);
  for(let offset=0;offset<forged.length-24;offset++)if(view.getUint32(offset,true)===0x02014b50){view.setUint32(offset+24,1,true);break;}
  await assert.rejects(extractZip(forged),/大小|安全限制|长度/);
});
test('ZIP extraction cancels cleanly before decompressing when its tool was closed',async()=>{
  await assert.rejects(extractZip(zipSync({'x':strToU8('hello')}),{shouldContinue:()=>false}),/取消/);
});
for(const level of [0,6])test(`ZIP validates actual file CRC for compression level ${level}`,async()=>{
  const bytes=zipSync({'test.txt':strToU8('hello')},{level});
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const data=30+view.getUint16(26,true)+view.getUint16(28,true);bytes[data+(level===0?0:1)]^=1;
  await assert.rejects(extractZip(bytes),/CRC|校验/);
});
test('image preflight reads real PNG/GIF dimensions and rejects forged huge or truncated data',()=>{
  const png=new Uint8Array(45);png.set([137,80,78,71,13,10,26,10]);const pv=new DataView(png.buffer);pv.setUint32(8,13);png.set(strToU8('IHDR'),12);pv.setUint32(16,96);pv.setUint32(20,48);png[24]=8;png[25]=6;png.set(strToU8('IEND'),37);
  assert.deepEqual(inspectImage(png),{type:'image/png',width:96,height:48});
  pv.setUint32(16,20000);assert.throws(()=>inspectImage(png),/尺寸|像素/);pv.setUint32(16,96);assert.throws(()=>inspectImage(png.subarray(0,20)),/PNG/);
  const gif=new Uint8Array(14);gif.set(strToU8('GIF89a'));gif[6]=10;gif[8]=20;gif[13]=0x3b;
  assert.deepEqual(inspectImage(gif),{type:'image/gif',width:10,height:20});
  const fake=new Uint8Array(40);fake.set(strToU8('untrusted tag IHDR'));assert.throws(()=>inspectImage(fake),/格式|支持/);
});
test('image preflight checks WebP pixel header, JPEG SOF and BMP DIB structurally',()=>{
  const webp=new Uint8Array(26);webp.set(strToU8('RIFF'));new DataView(webp.buffer).setUint32(4,18,true);webp.set(strToU8('WEBPVP8L'),8);new DataView(webp.buffer).setUint32(16,5,true);webp.set([0x2f,9,0xc0,4,0],20);
  assert.deepEqual(inspectImage(webp),{type:'image/webp',width:10,height:20});
  const jpeg=Uint8Array.from([255,216,255,192,0,11,8,0,20,0,10,1,1,0x11,0,255,218,0,2]);
  assert.deepEqual(inspectImage(jpeg),{type:'image/jpeg',width:10,height:20});
  const bmp=new Uint8Array(54);bmp.set([66,77]);const bv=new DataView(bmp.buffer);bv.setUint32(10,54,true);bv.setUint32(14,40,true);bv.setInt32(18,10,true);bv.setInt32(22,-20,true);bv.setUint16(26,1,true);bv.setUint16(28,24,true);
  assert.deepEqual(inspectImage(bmp),{type:'image/bmp',width:10,height:20});
  bv.setUint32(30,5,true);assert.throws(()=>inspectImage(bmp),/BMP/);
});
test('audio preflight validates PCM WAV channels and sample allocation before decode',()=>{
  const bytes=new Uint8Array(encodeWav([new Float32Array(16000)],16000,0,1));
  assert.deepEqual(inspectAudio(bytes),{type:'audio/wav',duration:1,channels:1,sampleRate:16000,sampleCount:16000});
  const bad=bytes.slice();new DataView(bad.buffer).setUint16(22,64,true);assert.throws(()=>inspectAudio(bad),/声道|音频|WAV/);
  const truncated=bytes.subarray(0,50);assert.throws(()=>inspectAudio(truncated),/WAV/);
});
test('MP3 preflight follows frame boundaries instead of trusting a later sync byte',()=>{
  const bytes=new Uint8Array(417*2);bytes.set([255,251,144,0],0);bytes.set([255,251,144,0],417);
  const info=inspectAudio(bytes);assert.equal(info.type,'audio/mpeg');assert.equal(info.channels,2);assert.equal(info.sampleRate,44100);assert.equal(info.sampleCount,1152*2*2);
  const fake=new Uint8Array(bytes.length+1);fake.set(bytes,1);assert.throws(()=>inspectAudio(fake),/格式|MP3/);
});
test('audio metadata gate rejects missing duration, cancels promptly and times out without decoding',async t=>{
  const previous=globalThis.document;let mode='valid',lastAudio;
  class MetadataAudio extends EventTarget{
    duration=1;src='';pause(){}removeAttribute(){this.src='';}
    load(){if(this.src&&mode!=='silent'){this.duration=mode==='invalid'?Infinity:1;queueMicrotask(()=>this.dispatchEvent(new Event('loadedmetadata')));}}
  }
  globalThis.document={createElement:()=>lastAudio=new MetadataAudio()};
  try{
    assert.deepEqual(await audioMetadata('blob:fixture',new AbortController().signal),{duration:1});assert.equal(lastAudio.src,'');
    mode='invalid';await assert.rejects(audioMetadata('blob:fixture',new AbortController().signal),/时长/);assert.equal(lastAudio.src,'');
    mode='silent';const controller=new AbortController(),cancelled=audioMetadata('blob:fixture',controller.signal);controller.abort();await assert.rejects(cancelled,/取消/);assert.equal(lastAudio.src,'');
    t.mock.timers.enable({apis:['setTimeout']});const timeout=audioMetadata('blob:fixture',new AbortController().signal);t.mock.timers.tick(10000);await assert.rejects(timeout,/超时/);assert.equal(lastAudio.src,'');
  }finally{t.mock.timers.reset();if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});
