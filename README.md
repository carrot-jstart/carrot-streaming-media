# Carrot Streaming Media

超低延迟流媒体服务器，支持 **RTMP 推流 + WebSocket 传输 + 浏览器 WebCodecs 硬件解码播放**。

---

## 工作流程

```
┌──────────────┐   RTMP (1935)   ┌─────────────────────────────────────┐
│   ffmpeg     │ ──────────────▶ │         Carrot Server               │
│  (推流端)     │                 │                                     │
│  摄像头/视频   │                 │  ┌──────────┐   ┌────────────────┐  │
│  文件/桌面     │                 │  │  RTMP    │──▶│ StreamManager  │  │
└──────────────┘                 │  │  Server  │   │  (流管理/分发)  │  │
                                 │  └──────────┘   └────────┬───────┘  │
┌──────────────┐   WSS (7778)   │                            │         │
│   浏览器      │ ──────────────▶ │  ┌────────────────┐       │         │
│  (推流端)     │                 │  │  WebSocket     │       │         │
│  getUserMedia │                 │  │  Push Server   │       │         │
└──────────────┘                 │  └────────────────┘       │         │
                                 │                            │ WSS    │
                                 │  ┌────────────────┐       │        │
                                 │  │  WebSocket     │◀──────┘        │
                                 │  │  Play Server   │  HTTPS (7777)  │
                                 │  │  (播放页面分发)  │               │
                                 │  └────────┬───────┘               │
                                 └──────────┼────────────────────────┘
                                            │ WSS
                                            ▼
                                 ┌──────────────────────┐
                                 │  浏览器 (Chrome/Edge)  │
                                 │  WebCodecs API       │
                                 │  VideoDecoder ↓      │
                                 │  AudioDecoder ↓      │
                                 │  Canvas + Audio      │
                                 └──────────────────────┘
```

### 数据流说明

1. **推流**：通过 ffmpeg（RTMP 协议）或浏览器（WebSocket 协议）将音视频数据推送至服务器
2. **流管理**：`StreamManager` 按路径隔离多路流（如 `live/stream1`、`live/stream2`），并维护订阅者列表
3. **播放**：浏览器通过 HTTPS 页面建立 WSS 连接，接收 H.264 视频和 AAC 音频数据
4. **解码**：浏览器使用 WebCodecs API 进行硬件解码，渲染到 Canvas 和 AudioContext

### 二进制消息协议

#### 播放协议（服务器 → 浏览器）

服务器与浏览器之间使用二进制帧通信：

```
[4 bytes: message_type]  [4 bytes: timestamp]  [4 bytes: payload_length]  [payload]

消息类型:
  0 = 视频编解码配置 (SPS/PPS)
  1 = 视频帧
  2 = 音频编解码配置
  3 = 音频帧
```

**视频配置格式（type=0）：**
```
[1 byte: codec=0(H264)]  [4 bytes: sps_length]  [sps]  [4 bytes: pps_length]  [pps]
```

**视频帧格式（type=1）：**
```
[1 byte: frame_type(0=关键帧, 1=P帧)]  [H.264 AVCC 数据(4字节NALU长度前缀)]
```

**音频配置格式（type=2）：**
```
[1 byte: codec_type(0=AAC, 1=MP3)]  [4 bytes: sample_rate]  [1 byte: channels]  [AudioSpecificConfig]
```

#### 推流协议（浏览器 → 推流服务器）

浏览器推流使用独立的 WebSocket 连接（端口 7778）：

**配置消息（第1条）：**
```
[4 bytes: sps_length]  [sps]  [4 bytes: pps_length]  [pps]  [4 bytes: width]  [4 bytes: height]
```

**视频帧消息（第2条起）：**
```
[4 bytes: timestamp_ms]  [1 byte: is_keyframe(0/1)]  [H.264 AVCC 数据]
```

---

## 快速开始

### 前置条件

- 推流需要 [ffmpeg](https://ffmpeg.org/)（可选，也可使用浏览器推流）
- 播放需要 Chrome 94+ 或 Edge 94+（Chromium 内核）
- **SSL 证书（必需）**，因为浏览器要求安全上下文才能使用 WebCodecs API

### 1. 配置 SSL 证书

**这是必需步骤。** 浏览器 WebCodecs API 仅在 HTTPS/WSS 安全上下文中可用，因此必须配置 SSL 证书。

#### 方式一：mkcert（推荐，本地开发）

```bash
# 安装 mkcert
# Windows: winget install FiloSottile.mkcert
# macOS:   brew install mkcert
# Linux:   从 https://github.com/FiloSottile/mkcert/releases 下载

# 安装 CA 到系统信任
mkcert -install

# 在项目根目录下生成证书（按实际域名/IP 生成）
cd cert
mkcert localhost 127.0.0.1 ::1
# 生成 localhost+3.pem 和 localhost+3-key.pem
```

#### 方式二：Let's Encrypt（生产环境）

```bash
# 安装 certbot
sudo apt install certbot

# 申请证书（需要公网 IP 和域名）
sudo certbot certonly --standalone -d your-domain.com

# 生成证书位于：
#   /etc/letsencrypt/live/your-domain.com/fullchain.pem
#   /etc/letsencrypt/live/your-domain.com/privkey.pem
```

> Let's Encrypt 证书有效期为 90 天，建议配置定时续期：
> ```bash
> sudo certbot renew --quiet
> ```

### 2. 修改配置

编辑 `carrot.conf`，将证书路径指向你的证书文件：

```ini
ssl_certificate=./cert/localhost+3.pem
ssl_certificate_key=./cert/localhost+3-key.pem
http_port=7777
rtmp_port=1935
push_port=7778
web_dir=./web
log_level=info
```

### 3. 启动服务器

```bash
# 方式一：使用预编译包
./carrot-server

# 方式二：使用 Go 源码运行
go run ./cmd/server

# 方式三：使用 Docker
docker build -t carrot-streaming-media .
docker run -d \
  --name carrot-streaming \
  -p 7777:7777 -p 1935:1935 -p 7778:7778 \
  -v /path/to/cert:/app/cert \
  -v /path/to/config:/app/config \
  carrot-streaming-media:latest
```

启动成功日志示例：

```
=== Carrot Streaming Media Server ===
Config: HTTP:7777 RTMP:1935 cert:./cert/localhost+3.pem web:./web log:info
[Cert] Loaded: ./cert/localhost+3.pem (2 certificates)
[RTMP] Starting RTMP server on :1935
[WebSocket] Starting server on :7777 (HTTPS/WSS)
```

---

## 使用指南

### 推流

#### 方式一：ffmpeg 推流（RTMP）

**推流视频文件：**

```bash
ffmpeg -re -i "input.mp4" \
  -c:v libx264 -preset ultrafast -tune zerolatency \
  -g 30 -c:a aac -ar 44100 -ac 2 \
  -f flv rtmp://localhost:1935/live/stream
```

**推流摄像头：**

```bash
# Windows (DirectShow)
ffmpeg -f dshow -i video="Integrated Camera" \
  -video_size 1280x720 -framerate 30 \
  -c:v libx264 -preset ultrafast -tune zerolatency \
  -pix_fmt yuv420p -rtbufsize 100M \
  -f flv rtmp://localhost:1935/live/stream

# Linux (V4L2)
ffmpeg -f v4l2 -i /dev/video0 \
  -video_size 1280x720 -framerate 30 \
  -c:v libx264 -preset ultrafast -tune zerolatency \
  -pix_fmt yuv420p \
  -f flv rtmp://localhost:1935/live/stream

# macOS (AVFoundation)
ffmpeg -f avfoundation -i "0" \
  -video_size 1280x720 -framerate 30 \
  -c:v libx264 -preset ultrafast -tune zerolatency \
  -pix_fmt yuv420p \
  -f flv rtmp://localhost:1935/live/stream
```

**推流参数说明：**

| 参数 | 说明 |
|------|------|
| `-re` | 以原始帧率推送（不加则全速推送） |
| `-preset ultrafast -tune zerolatency` | 编码速度优先，最低延迟 |
| `-g 30` | 每 30 帧一个关键帧 |
| `-pix_fmt yuv420p` | **必需**，浏览器仅支持 4:2:0 色度采样 |
| `-rtbufsize 100M` | 增大缓冲区，减少丢帧 |

#### 方式二：浏览器推流（WebSocket）

访问 `https://localhost:7778/`（或你的服务器地址），直接使用浏览器摄像头推流。支持独立控制视频/音频的开启与关闭。

> **特性：** 使用 WebCodecs VideoEncoder 硬件编码 H.264（avc1.42001e），自动**每 ~2 秒强制插入一个关键帧**，确保后连接的播放端能快速开始解码。

### 播放

打开 Chrome 或 Edge 浏览器访问：

```
https://localhost:7777/?url=live/stream
```

`url` 参数必须与推流路径一致。

### 多流支持

```bash
# 终端 1：推流 cam1
ffmpeg ... -f flv rtmp://localhost:1935/live/cam1

# 终端 2：推流 cam2
ffmpeg ... -f flv rtmp://localhost:1935/live/cam2
```

```
# 浏览器标签页 1
https://localhost:7777/?url=live/cam1

# 浏览器标签页 2
https://localhost:7777/?url=live/cam2
```

### 音频/视频分离

支持独立的音视频流路径，在 URL 中分别指定：

```
# 分离的音视频流
https://localhost:7777/?videoUrl=live/stream&audioUrl=audio/stream

# 仅视频
https://localhost:7777/?videoUrl=live/stream

# 仅音频
https://localhost:7777/?audioUrl=audio/stream
```

---

## 配置文件

服务器自动读取工作目录下的 `carrot.conf`，也可通过 `-config` 参数指定：

```bash
./carrot-server -config=/path/to/carrot.conf
```

完整配置项：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `ssl_certificate` | `./cert/localhost+3.pem` | SSL 证书路径（PEM 格式） |
| `ssl_certificate_key` | `./cert/localhost+3-key.pem` | SSL 私钥路径 |
| `http_port` | `7777` | 播放页面端口（HTTPS/WSS） |
| `rtmp_port` | `1935` | RTMP 推流端口 |
| `push_port` | `7778` | 浏览器 WebSocket 推流端口 |
| `web_dir` | `./web` | 静态文件目录 |
| `log_level` | `info` | 日志级别：`debug`、`info`、`warn`、`error` |

> 路径支持相对于工作目录的相对路径或绝对路径。Docker 部署时注意容器内路径映射。

---

## 部署指南

### 下载预编译包

从 [GitHub Releases](https://github.com/你的用户名/carrot-streaming-media/releases) 下载对应平台的包。

| 文件 | 适用平台 |
|------|---------|
| `carrot-streaming-media-windows-amd64.zip` | Windows 10/11 (amd64) |
| `carrot-streaming-media-linux-amd64.tar.gz` | Linux (amd64) |
| `carrot-streaming-media-darwin-amd64.tar.gz` | macOS Intel |
| `carrot-streaming-media-darwin-arm64.tar.gz` | macOS Apple Silicon |
| `carrot-streaming-media-docker.tar.gz` | Docker 镜像 |

### Windows 部署

```powershell
# 解压
Expand-Archive -Path carrot-streaming-media-windows-amd64.zip -DestinationPath C:\carrot
cd C:\carrot

# 生成 SSL 证书（管理员 PowerShell）
mkcert -install
mkdir cert; cd cert
mkcert localhost 127.0.0.1 ::1
cd ..

# 修改 carrot.conf 中的证书路径
# ssl_certificate=./cert/localhost+3.pem
# ssl_certificate_key=./cert/localhost+3-key.pem

# 启动
.\carrot-server.exe
```

### Linux 部署

```bash
# 解压
tar xzf carrot-streaming-media-linux-amd64.tar.gz -C /opt/carrot
cd /opt/carrot

# 生成 SSL 证书
mkcert -install
mkdir -p cert && cd cert
mkcert localhost 127.0.0.1 ::1
cd ..

# 启动
chmod +x carrot-server
./carrot-server
```

#### systemd 服务（生产环境推荐）

```bash
sudo tee /etc/systemd/system/carrot-streaming.service > /dev/null <<'EOF'
[Unit]
Description=Carrot Streaming Media Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/carrot
ExecStart=/opt/carrot/carrot-server
Restart=always
RestartSec=5
User=nobody
Group=nogroup

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now carrot-streaming
```

### macOS 部署

```bash
# 解压（Apple Silicon 使用 darwin-arm64，Intel 使用 darwin-amd64）
tar xzf carrot-streaming-media-darwin-arm64.tar.gz -C /opt/carrot
cd /opt/carrot

# 生成 SSL 证书
brew install mkcert
mkcert -install
mkdir -p cert && cd cert
mkcert localhost 127.0.0.1 ::1
cd ..

# 启动
chmod +x carrot-server
./carrot-server
```

### Docker 部署

```bash
# 方式一：从 Release 加载
gunzip -c carrot-streaming-media-docker.tar.gz | docker load

# 方式二：源码构建
docker build -t carrot-streaming-media .

# 运行容器
docker run -d \
  --name carrot-streaming \
  --restart always \
  -p 7777:7777 \
  -p 1935:1935 \
  -p 7778:7778 \
  -v /opt/carrot/config:/app/config \
  -v /opt/carrot/cert:/app/cert \
  carrot-streaming-media:latest
```

#### docker-compose

```yaml
version: "3.9"
services:
  carrot-streaming:
    image: carrot-streaming-media:latest
    container_name: carrot-streaming
    restart: always
    ports:
      - "7777:7777"
      - "1935:1935"
      - "7778:7778"
    volumes:
      - ./config:/app/config
      - ./cert:/app/cert
```

> **注意：** Docker 容器内 `carrot.conf` 中的证书路径需使用容器内路径（如 `/app/cert/localhost+3.pem`），而非宿主机路径。

---

## 项目结构

```
carrot-streaming-media/
├── carrot.conf                       # 服务器配置文件
├── cmd/server/main.go                # 程序入口
├── cert/
│   └── cert.go                       # TLS 证书加载模块
├── internal/
│   ├── config/config.go              # 配置解析
│   ├── media/stream.go               # StreamManager 流管理
│   ├── rtmp/server.go                # RTMP 推流接收服务器
│   └── websocket/
│       ├── server.go                 # HTTPS/WSS 播放服务器
│       └── push.go                   # WebSocket 浏览器推流服务器
├── web/
│   ├── index.html                    # 播放器页面
│   ├── push.html                     # 浏览器推流页面
│   └── js/
│       ├── player.js                 # WebCodecs 解码播放器（向后兼容）
│       ├── pusher.js                 # 浏览器推流客户端（向后兼容）
│       └── carrot-sdk.js             # 前端 SDK（统一封装 Player + Pusher）
├── Dockerfile                        # Docker 构建
├── go.mod / go.sum                   # Go 依赖
└── README.md
```

---

## 前端 SDK 使用说明

`carrot-sdk.js` 封装了播放器（Player）和推流器（Pusher），提供统一的 `CarrotSDK` 命名空间，便于其他项目集成。

### 引入方式

```html
<script src="js/carrot-sdk.js"></script>
```

SDK 会自动挂载到全局 `window.CarrotSDK`。

### CarrotSDK.Player — 播放器

用于播放 H.264 视频和 AAC 音频流。

#### 快速开始

```html
<canvas id="myCanvas"></canvas>
<div id="myStatus"></div>
<script src="js/carrot-sdk.js"></script>
<script>
  const player = new CarrotSDK.Player({
    canvas: 'myCanvas',
    statusEl: 'myStatus',
    videoUrl: 'live/stream',   // 视频流路径
    audioUrl: 'live/stream',    // 音频流路径（可选，单独传参时合并）
  });
  player.connect();
</script>
```

##### 连接外部服务器

如果页面不部署在流媒体服务器上，需要指定服务器地址和端口：

```javascript
// 播放器：连接到远程流媒体服务器
const player = new CarrotSDK.Player({
  host: '192.168.1.100',          // 流媒体服务器 IP 或域名
  port: 7777,                      // 流媒体服务器端口（播放端口）
  videoUrl: 'live/stream',
});
player.connect();

// 推流器：连接到远程推流服务器
const pusher = new CarrotSDK.Pusher({
  host: '192.168.1.100',          // 推流服务器 IP 或域名
  port: 7778,                      // 推流服务器端口
});
pusher.startVideo('live/cam1');
```

#### 构造函数参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `canvas` | `HTMLElement\|string` | Canvas 元素或 ID |
| `statusEl` | `HTMLElement\|string` | 状态栏元素或 ID |
| `videoUrl` | `string` | 视频流路径（如 `live/stream`） |
| `audioUrl` | `string` | 音频流路径（如 `audio/stream`） |
| `host` | `string` | 服务器地址，默认当前页面 host |
| `port` | `number` | 服务器端口，默认当前页面端口 |
| `dataTimeout` | `number` | 数据超时阈值（ms），默认 `10000`（10秒）。超过此时间未收到数据则自动重连。设为 `0` 可禁用 |
| `onStatus` | `function(msg, type)` | 状态回调 |
| `onStats` | `function(stats)` | 统计信息回调 |
| `onFrame` | `function(VideoFrame)` | 每帧回调 |

#### 方法

| 方法 | 说明 |
|------|------|
| `connect(videoUrl?, audioUrl?)` | 连接并开始播放（可覆盖构造时的 URL） |
| `disconnect()` | 断开连接并清理资源 |
| `destroy()` | 同 `disconnect()` |

#### 分离音视频流

```javascript
// 视频和音频走不同流路径
const player = new CarrotSDK.Player({
  videoUrl: 'live/camera1',
  audioUrl: 'audio/mic1',
});
player.connect();
```

#### 纯音频 / 纯视频

```javascript
// 仅视频
const player = new CarrotSDK.Player({ videoUrl: 'live/stream' });
player.connect();

// 仅音频
const player = new CarrotSDK.Player({ audioUrl: 'audio/stream' });
player.connect();
```

#### 事件回调示例

```javascript
const player = new CarrotSDK.Player({
  videoUrl: 'live/stream',
  onStatus: function(msg, type) {
    console.log('状态:', msg, '类型:', type);
    // type: 'connected' | 'error' | ''
  },
  onStats: function(stats) {
    console.log('统计:', stats);
    // { fps, frameCount, decodedCount, droppedCount, latency, audioDecodedFrames }
  },
  onFrame: function(frame) {
    // 每次解码出一帧时调用
    console.log('新帧:', frame.displayWidth, 'x', frame.displayHeight);
  }
});
player.connect();
```

---

### CarrotSDK.Pusher — 推流器

用于浏览器端推送 H.264 视频和 AAC 音频到服务器。

#### 快速开始

```html
<video id="preview" autoplay muted playsinline></video>
<script src="js/carrot-sdk.js"></script>
<script>
  const pusher = new CarrotSDK.Pusher();
  
  // 推流视频
  pusher.startVideo('video/browser');
  
  // 推流音频
  pusher.startAudio('audio/browser');
  
  // 停止所有推流
  // pusher.stopAll();
</script>
```

#### 构造函数参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `host` | `string` | 推流服务器地址，默认当前页面 host |
| `port` | `number` | 推流服务器端口，默认 `7778` |
| `video.streamUrl` | `string` | 视频流路径 |
| `video.host` | `string` | 视频推流服务器地址（覆盖全局 host） |
| `video.port` | `number` | 视频推流端口（覆盖全局 port） |
| `video.constraints` | `Object` | `getUserMedia` 视频约束 |
| `video.preview` | `HTMLElement\|string` | 预览 `<video>` 元素或 ID |
| `audio.streamUrl` | `string` | 音频流路径 |
| `audio.host` | `string` | 音频推流服务器地址（覆盖全局 host） |
| `audio.port` | `number` | 音频推流端口（覆盖全局 port） |
| `audio.constraints` | `Object` | `getUserMedia` 音频约束 |
| `onStatus` | `function(type, msg)` | 状态回调 |
| `onStats` | `function(stats)` | 统计信息回调 |

```javascript
const pusher = new CarrotSDK.Pusher({
  host: '192.168.1.100',        // 推流服务器地址（可选）
  port: 7778,                    // 推流服务器端口（可选）
  // 视频配置
  video: {
    streamUrl: 'video/browser',
    // host: '10.0.0.1',        // 可覆盖全局 host
    // port: 7778,              // 可覆盖全局 port
    constraints: {
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } }
    },
    preview: 'preview',
    streamUrlEl: 'videoStreamUrl',
    btnStartEl: 'btnVideoStart',
    btnStopEl: 'btnVideoStop',
    statusEl: 'videoStatus',
    statsEl: 'videoStats',
  },
  // 音频配置
  audio: {
    streamUrl: 'audio/browser',
    constraints: {
      audio: { sampleRate: 44100, channelCount: 1, echoCancellation: true, noiseSuppression: true }
    },
    streamUrlEl: 'audioStreamUrl',
    btnStartEl: 'btnAudioStart',
    btnStopEl: 'btnAudioStop',
    statusEl: 'audioStatus',
    statsEl: 'audioStats',
  },
  // 全局回调
  onStatus: function(type, msg) {
    console.log('[' + type + ']', msg);
    // type: 'audio' | 'video'
  },
  onStats: function(stats) {
    console.log(stats.type, '统计:', stats);
    // { type, frameCount, bytesSent, pushing }
  }
});
```

#### 方法

| 方法 | 说明 |
|------|------|
| `startAudio(streamUrl?)` | 开始音频推流 |
| `stopAudio()` | 停止音频推流 |
| `startVideo(streamUrl?)` | 开始视频推流 |
| `stopVideo()` | 停止视频推流 |
| `stopAll()` | 停止所有推流 |
| `getStats()` | 获取当前统计数据 |

#### 独立控制音视频

```javascript
const pusher = new CarrotSDK.Pusher();

// 仅推视频
pusher.startVideo('live/cam1');

// 仅推音频
pusher.startAudio('audio/mic1');

// 获取实时统计
const stats = pusher.getStats();
console.log('视频帧数:', stats.video.frameCount, '音频帧数:', stats.audio.frameCount);

// 停止视频，保留音频
pusher.stopVideo();

// 全部停止
pusher.stopAll();
```

---

### 从 URL 参数自动初始化（播放器）

`CarrotSDK.Player` 兼容原有的 URL 参数方式，无需额外 JavaScript 代码即可工作：

```
https://localhost:7777/?videoUrl=live/stream&audioUrl=audio/stream

# 自定义数据超时（15秒无数据重连）
https://localhost:7777/?videoUrl=live/stream&dataTimeout=15000
```

支持 URL 参数：

| 参数 | 说明 |
|------|------|
| `videoUrl` 或 `url` | 视频流路径 |
| `audioUrl` | 音频流路径（可选，如不指定则与视频同路径） |
| `dataTimeout` | 数据超时阈值（ms），默认 `10000` |

只需在页面中引入 SDK 并保留对应 ID 的 HTML 元素即可自动初始化。

---

## 浏览器兼容性

| 浏览器 | 状态 | 说明 |
|--------|------|------|
| Chrome | 支持 | 94+，推荐 |
| Edge | 支持 | 94+（Chromium 内核） |
| Firefox | 不支持 | 不支持 WebCodecs API |
| Safari | 不支持 | 不支持 WebCodecs API |

---

## 常见问题

### WebSocket 连接失败

```
WebSocket connection to 'wss://localhost:7777/ws?url=live/stream' failed
```

- 检查服务器是否已启动
- 检查端口是否被占用：`netstat -ano | findstr :7777`
- 检查 SSL 证书是否有效：浏览器地址栏是否显示安全锁
- **确认使用 `https://` 而非 `http://`**（WebCodecs 需要安全上下文）

### 黑屏 / 无画面

1. 确认使用 Chrome 或 Edge
2. 打开浏览器控制台，检查是否有 `VideoDecoder is not defined` 错误
3. 确认推流参数包含 `-pix_fmt yuv420p`
4. 确认 `?xxxUrl=` 参数值与推流路径一致
5. **浏览器推流无画面**：
   - 打开推流页和播放页的浏览器控制台，查看是否有配置解析失败的日志
   - 检查 `[CarrotSDK Video]` 相关的日志，确认 config 是否成功提取和发送
   - 检查 `[CarrotSDK Player]` 相关的日志，确认是否收到 config 和解码帧
6. **播放端断流卡死**：播放器内置数据超时检测（默认10秒），无数据时自动重连。可通过 `dataTimeout` 参数调整阈值

### 解码错误

```
Decoder error: EncodingError: Decoder error
```

- 推流时加上 `-pix_fmt yuv420p`，浏览器不支持 4:2:2 或 4:4:4
- 使用兼容的 H.264 Profile（Baseline / Main / High 均可）

### 推流缓冲溢出

```
real-time buffer [video input] too full (xx% of size) ... frame dropped!
```

- 添加 `-rtbufsize 100M` 增大缓冲区
- 降低分辨率或帧率：`-video_size 640x480 -framerate 15`

### 推流速度过快

```
speed=11.7x
```

- 缺少 `-re` 参数，ffmpeg 默认以最大速度推送
- 加上 `-re` 以原始帧率推送

---

## 技术栈

- [Go](https://go.dev/) — 服务器端开发语言
- [joy4](https://github.com/nareix/joy4) — RTMP 协议库
- [gorilla/websocket](https://github.com/gorilla/websocket) — WebSocket 库
- [WebCodecs API](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API) — 浏览器 H.264/AAC 硬件解码
