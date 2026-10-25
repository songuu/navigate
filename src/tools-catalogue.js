export const TOOL_CATEGORIES = [
  {id:'convert',title:'编码转换',icon:'↔'},
  {id:'develop',title:'开发辅助',icon:'⌘'},
  {id:'image',title:'图片处理',icon:'▧'},
  {id:'file',title:'文件文档',icon:'▤'},
  {id:'life',title:'生活效率',icon:'◷'},
  {id:'audio',title:'音频处理',icon:'♫'},
  {id:'fun',title:'休闲趣味',icon:'✦'},
  {id:'education',title:'学习教育',icon:'◇'}
];

// Reference entries are outbound destinations, never implicit local features.
// A mapping is replaced only when that implementation is actually registered.
const referenceRows = [
  ['ip-query','IP归属地查询','develop','查看 IP 对应的地区与网络信息。','IP 网络 地址 查询'],
  ['file-transfer','局域网文件快传','file','在同一网络的设备之间传递文件。','局域网 文件 传输 分享'],
  ['color-picker','屏幕取色器','image','从屏幕画面中挑选所需颜色。','颜色 色值 屏幕 HEX','color-picker'],
  ['img-converter','图片格式转换工具','image','在常见图片格式之间转换。','图片 格式 JPG PNG WebP','image-converter'],
  ['video-to-frames','视频转图片','image','从视频内容中提取画面帧。','视频 帧 截图 图片'],
  ['archive-extractor','在线解压工具','file','查看压缩包内容并提取文件。','压缩 解压 ZIP 文件','archive-extractor'],
  ['grid-splitter','九宫格切图工具','image','将一张图片拆成九张网格图。','图片 九宫格 切片 朋友圈','grid-splitter'],
  ['markdown-to-doc','Markdown转Word或PDF','file','将 Markdown 内容排版为文档。','Markdown 文档 Word PDF 导出','markdown'],
  ['screenshot-stitcher','长截图拼接工具','image','按顺序拼接多张图片。','截图 拼接 长图 合并','screenshot-stitcher'],
  ['what-to-eat','今天吃什么','life','从候选菜单中挑选一餐。','吃饭 菜单 随机 选择','what-to-eat'],
  ['temp-clipboard','临时剪贴板','life','临时记录文字，随时整理与复制。','文字 剪贴板 便签 记录','temp-clipboard'],
  ['icon-scraper','网站图标抓取工具','develop','查找网站使用的图标资源。','网站 图标 favicon 下载'],
  ['icon-cropper','图标放大器','image','裁切并调整图标的显示尺寸。','图标 放大 裁切 透明','icon-cropper'],
  ['audio-editor','音频剪辑工具','audio','选择音频片段并导出剪辑结果。','音频 剪辑 裁剪 WAV','audio-editor'],
  ['image-compressor','图片压缩工具','image','调整图片尺寸与质量以缩小文件。','图片 压缩 质量 尺寸','image-compressor'],
  ['online-photoshop','在线Photoshop','image','进入网页图像编辑工作台。','图片 编辑 图层 Photoshop'],
  ['docker-generator','Docker命令生成器','develop','整理容器启动参数并生成命令。','Docker 容器 命令 部署','docker-generator'],
  ['win-cmd-generator','Windows命令生成器','develop','按操作需求查找 Windows 命令。','Windows CMD PowerShell 命令'],
  ['remote-clipboard','远程剪切板','life','在不同设备之间分享剪贴板内容。','远程 剪切板 同步 设备'],
  ['linux-cmd-generator','Linux命令生成器','develop','将常见 Linux 操作整理为命令。','Linux Shell 系统 命令'],
  ['port-scanner','服务器端口开放检测','develop','检查目标服务器的端口连通情况。','服务器 端口 网络 连通'],
  ['text-to-speech','文字转语音','audio','将输入文字朗读出来。','文字 语音 朗读 TTS','text-to-speech'],
  ['doc-reader','摸鱼阅读','file','在网页中打开文字阅读界面。','阅读 文档 小说 文字'],
  ['work-log','工作留痕','life','整理工作过程与日常进展记录。','工作 记录 日志 进展'],
  ['fun-avatar','随机头像生成器','fun','生成不同风格的趣味头像。','头像 随机 生成 个性'],
  ['json-viewer','JSON格式化工具','convert','格式化或压缩 JSON，便于查看结构。','JSON 格式化 压缩 数据','json'],
  ['sprite-tool','Sprite Tool','image','将多张图像整理为精灵图。','Sprite 精灵图 雪碧图 合成'],
  ['base-converter','进制转换','convert','在二、八、十与十六进制间换算。','进制 二进制 十六进制 数字','base'],
  ['timestamp','Unix时间戳转换','convert','在时间戳与可读日期之间换算。','Unix 时间戳 日期 毫秒','time'],
  ['url-encoder','URL编码解码','convert','转换网址参数中的转义字符。','URL 编码 解码 百分号','encode'],
  ['qr-code','二维码生成器','image','将文字或网址生成二维码。','二维码 QR 网址 分享','qr-code'],
  ['random-generator','随机数据生成器','develop','按条件生成随机数字或文字。','随机 数据 数字 密码','random'],
  ['bg-remover','图片去背景','image','将图片中的主体与背景分离。','图片 背景 抠图 透明'],
  ['word-counter','字数统计','life','统计文本的字符、单词与行数。','字数 字符 单词 文本 统计','count'],
  ['copybook-generator','字帖生成器','education','将练习文字排版成书写字帖。','字帖 书写 汉字 练字'],
  ['anniversary','重要日子助手','life','记录值得记住的日期与纪念日。','纪念日 日期 倒计时 提醒'],
  ['piano','在线钢琴','fun','通过网页键盘弹奏旋律。','钢琴 音乐 键盘 弹奏'],
  ['base64','Base64编解码','convert','在文本与 Base64 表示之间转换。','Base64 编码 解码 UTF-8','base64'],
  ['signature','电子签名生成器','image','手写签名并导出为图片。','电子 签名 手写 图片'],
  ['html-markdown','HTML与Markdown互转','convert','转换网页标记与 Markdown 文本。','HTML Markdown 转换 排版'],
  ['growth-tracker','成长记录','life','按时间整理个人成长与生活片段。','成长 记录 时间线 生活'],
  ['ascii-table','ASCII码表','develop','对照字符与对应的 ASCII 编码。','ASCII 字符 编码 码表','ascii'],
  ['stopwatch','秒表计时器','life','开始计时、暂停并记录分段。','秒表 计时 分段 时间','stopwatch'],
  ['holiday-calendar','法定节假日查询','life','查询节假日安排与调休日历。','节假日 日历 调休 假期'],
  ['bmi','BMI计算器','life','根据身高与体重计算 BMI 数值。','BMI 身高 体重 计算'],
  ['cron','Cron表达式生成器','develop','组合周期参数，生成 Cron 表达式。','Cron 定时 计划 表达式','cron'],
  ['reaction-test','反应速度测试','fun','通过简单交互测试反应时间。','反应 速度 时间 测试'],
  ['typing-adventure','打字冒险岛','fun','在互动关卡中练习键盘输入。','打字 键盘 练习 游戏'],
  ['image-to-pdf','图片转PDF','file','将多张图片整理为 PDF 文档。','图片 PDF 文档 合并'],
  ['kinship','亲戚称呼计算器','life','按亲属关系查找合适的称呼。','亲戚 亲属 称呼 家庭'],
  ['stamp','印章生成器','image','为文字设计印章样式。','印章 文字 图形 设计'],
  ['word-to-html','Word转HTML','file','将 Word 文档内容转换为网页。','Word HTML 文档 转换'],
  ['html-to-word','HTML转Word','file','将网页内容转换为 Word 文档。','HTML Word 文档 转换'],
  ['pdf-to-image','PDF转图片','file','将 PDF 页面导出为图片。','PDF 图片 页面 导出'],
  ['procrastination-test','拖延指数测试','fun','通过趣味问答了解拖延习惯。','拖延 问答 趣味 测试'],
  ['mental-age-test','心理年龄测试','fun','完成趣味题目，看看心理年龄结果。','心理 年龄 问答 趣味'],
  ['stress-test','压力指数测试','fun','用趣味问答回顾近期压力感受。','压力 问答 情绪 趣味'],
  ['death-clock','死亡时间计算器','fun','通过趣味设定生成生命倒计时。','倒计时 趣味 时间 测试'],
  ['brain-test','左右脑测试','fun','用互动题目体验左右脑趣味测试。','左右脑 互动 趣味 测试'],
  ['memory-training','记忆力训练营','fun','通过互动练习挑战记忆能力。','记忆 练习 训练 游戏'],
  ['http-status-codes','HTTP状态码查询','develop','查询 HTTP 响应状态码及含义。','HTTP 状态码 响应 请求','http-status'],
  ['public-dns','公共DNS大全','develop','浏览常见公共 DNS 服务地址。','DNS 域名 网络 公共'],
  ['emoji-dictionary','Emoji大全','life','查找并复制常用 Emoji 符号。','Emoji 表情 符号 复制'],
  ['screen-recorder','在线录屏','image','在浏览器中录制屏幕画面。','屏幕 录制 视频 录屏'],
  ['online-survey','在线问卷制作','life','编辑问题并制作在线问卷。','问卷 调查 表单 问题'],
  ['websocket-tester','WebSocket在线测试','develop','连接 WebSocket 并收发测试消息。','WebSocket ws wss 连接 消息'],
  ['html-share','HTML网页转链接','develop','将 HTML 页面整理为可分享入口。','HTML 网页 分享 链接'],
  ['calculator','在线科学计算器','education','完成日常算术与科学函数计算。','科学 计算器 数学 算术'],
  ['text-diff','文本对比工具','develop','对照两段文字中的新增与删除。','文本 对比 差异 diff','text-diff'],
  ['ocr','文字识别','image','提取图片中可以辨识的文字。','OCR 文字 识别 图片'],
  ['audio-converter','音频格式转换','audio','在常见音频格式之间转换。','音频 格式 MP3 WAV 转换'],
  ['data-size-converter','字节数换算','convert','换算字节与不同容量单位。','字节 容量 KB MB GB KiB','data-size'],
  ['date-calculator','日期计算','life','计算日期间隔与指定天数后的日期。','日期 间隔 天数 计算','date'],
  ['periodic-table','元素周期表','education','查阅化学元素及其基本信息。','元素 周期表 化学 学习'],
  ['unicode-encoder','Unicode编解码','convert','转换文字与 Unicode 转义表示。','Unicode 编码 解码 转义','unicode'],
  ['dynasty','朝代查询','education','按时间查阅中国历史朝代。','朝代 历史 中国 时间'],
  ['sql-to-doc','SQL转Doc','develop','将建表 SQL 整理为数据表文档。','SQL 数据库 表结构 文档'],
  ['port-check-generator','端口检查脚本生成器','develop','为网络连通检查生成命令或脚本。','端口 网络 检查 脚本'],
  ['whois','WHOIS查询','develop','查询域名的注册相关信息。','WHOIS 域名 注册 查询'],
  ['baijiaxing','中华百家姓','education','查阅姓氏与相关文化知识。','百家姓 姓氏 文化 学习'],
  ['pixel-art','图片转像素画','image','将图片转换成像素风格画面。','像素 图片 风格 马赛克','pixel-art'],
  ['chinese-converter','简繁转换','convert','在简体中文与繁体中文之间转换。','简体 繁体 中文 转换'],
  ['environment-diagnoser','浏览器环境检测器','develop','查看当前浏览器支持的功能与环境。','浏览器 环境 功能 诊断','environment-diagnoser'],
  ['world-clock','世界时钟','life','对照不同时区的当地时间。','世界 时钟 时区 时间','world-clock'],
  ['webpage-screenshot','网页截图','image','将网页画面保存为截图。','网页 截图 图片 保存'],
  ['jwt-decoder','JWT解码器','develop','查看 JWT 令牌中的头部与载荷。','JWT token 令牌 解码','jwt'],
  ['curl-builder','cURL命令构建器','develop','组合网址、请求头与正文生成 cURL。','cURL HTTP 请求 命令','curl-builder']
];

const categoryIcons=new Map(TOOL_CATEGORIES.map(category=>[category.id,category.icon]));
export const REFERENCE_TOOLS=referenceRows.map(([id,title,category,description,keywords,localId])=>({
  id,title,category,description,icon:categoryIcons.get(category),keywords:keywords.split(' '),
  url:'https://kaka770.cn/'+(id==='fun-avatar'?'':'tools/')+id,
  ...(localId?{localId}:{})
}));

export function buildToolCatalogue(localTools=[]){
  const localById=new Map();
  for(const tool of localTools){
    if(!localById.has(tool.id))localById.set(tool.id,{...tool,source:'local',url:'/tools/?tool='+encodeURIComponent(tool.id)});
  }
  const external=REFERENCE_TOOLS.filter(tool=>!localById.has(tool.localId||tool.id)).map(tool=>({...tool,source:'external'}));
  return [...localById.values(),...external];
}

export function filterTools(items,{query='',category='all',source='all',favorites=[]}={}){
  const words=query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const favoriteIds=new Set(favorites);
  return items.filter(tool=>{
    if(category!=='all'&&tool.category!==category)return false;
    if(source==='favorites'&&!favoriteIds.has(tool.id))return false;
    if(source!=='all'&&source!=='favorites'&&tool.source!==source)return false;
    const searchable=[tool.title,tool.description,...(Array.isArray(tool.keywords)?tool.keywords:[tool.keywords||''])].join(' ').toLocaleLowerCase();
    return words.every(word=>searchable.includes(word));
  });
}
