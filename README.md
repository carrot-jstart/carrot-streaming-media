# Carrot Streaming Media

超低延迟流媒体服务器，支持 **RTMP 推流 + 浏览器 WebCodecs 解码播放**。

## 架构

```
ffmpeg (推流)
    │ RTMP
    ▼
┌─────────────────┐
│  RTMP Server    │  端口 1935
│  接收 ffmpeg 推流 │
└──────┬──────────┘
       │ H264 视频包 (AVCC 格式)
       ▼
┌─────────────────┐
│  StreamManager  │
│  多流路径隔离     │
│  /live/stream   │
│  /live/stream2   │
└──────┬──────────┘
       │ WSS (WebSocket Secure)
       ▼
┌─────────────────┐
│  HTTPS/WSS      │  端口 7777
│  播放页面 + 推流 │
└──────┬──────────┘
       │
       ▼
   浏览器 (Chrome/Edge)
   WebCodecs → Canvas
```

## 快速部署

### 编译

```bash
# 1. 克隆项目
cd carrot-streaming-media

# 2. 编译
go build -o carrot-server.exe ./cmd/server

# 3. 运行
./carrot-server.exe
```

或直接用 `go run`：

```bash
go run ./cmd/server
```

### 配置文件

服务器自动读取 `arrot.conf`，也可以指定：

```bash
./carrot-server.exe -config=arrot.conf
```

完整配置项：

```ini
ssl_certificate=./cert/localhost+3.pem        # SSL 证书
ssl_certificate_key=./cert/localhost+3-key.pem # SSL 私钥
http_port=7777                                 # 播放页面端口 (HTTPS/WSS)
rtmp_port=1935                                 # 推流端口 (RTMP)
web_dir=./web                                  # 静态文件目录
log_level=info                                 # 日志级别
```

### 证书配置

项目使用标准的 PEM 证书文件，通过 `ssl_certificate` / `ssl_certificate_key` 指定路径。

#### 使用 mkcert（推荐，浏览器信任）

```bash
# 1. 安装 mkcert
# Windows: choco install mkcert 或从 https://github.com/FiloSottile/mkcert/releases 下载
# macOS: brew install mkcert

# 2. 安装 CA 到系统信任
mkcert -install

# 3. 在项目 cert 目录生成证书
cd cert
mkcert localhost 127.0.0.1 ::1
# 生成 localhost+3.pem 和 localhost+3-key.pem

# 4. 更新 arrot.conf 中的路径指向新生成的文件
```

mkcert 安装 CA 后，浏览器访问 `https://localhost:7777` 直接显示安全锁，无警告。

#### 使用自签名证书

生成自签名证书并配置到 `arrot.conf` 即可。需要手动在浏览器接受安全警告。

## 使用

### 1. 启动服务器

```bash
cd carrot-streaming-media
go run ./cmd/server
```

控制台输出：
```
=== Carrot Streaming Media Server ===
Config: HTTP:7777 RTMP:1935 cert:./cert/localhost+3.pem web:./web log:info
[Cert] Loaded: ./cert/localhost+3.pem (2 certificates)
[RTMP] Starting RTMP server on :1935
[WebSocket] Starting server on :7777 (HTTPS/WSS)
```

### 2. 推流

#### 推流视频文件

```bash
ffmpeg -re -i "file.mp4" -c:v libx264 -preset ultrafast -tune zerolatency -g 30 -c:a aac -ar 44100 -ac 2 -f flv rtmp://localhost:1935/live/stream
```

关键参数说明：
- `-re` — 以原始帧率推送，不加会全速推
- `-preset ultrafast -tune zerolatency` — 编码速度优先，超低延迟
- `-g 30` — 每 30 帧一个关键帧

#### 推流摄像头 (Windows DirectShow)

```bash
ffmpeg -f dshow -i video="Integrated Camera" -video_size 1280x720 -framerate 30 -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p -rtbufsize 100M -f flv rtmp://loaclhost:1935/live/stream
```

关键参数说明：
- `-pix_fmt yuv420p` — **必需**，浏览器不支持 4:2:2
- `-rtbufsize 100M` — 增大缓冲区，减少丢帧

#### 推流摄像头 (Linux V4L2)

```bash
ffmpeg -f v4l2 -i /dev/video0 \
  -video_size 1280x720 -framerate 30 \
  -c:v libx264 -preset ultrafast -tune zerolatency \
  -pix_fmt yuv420p \
  -f flv rtmp://localhost:1935/live/stream
```

#### 推流摄像头 (macOS AVFoundation)

```bash
ffmpeg -f avfoundation -i "0" \
  -video_size 1280x720 -framerate 30 \
  -c:v libx264 -preset ultrafast -tune zerolatency \
  -pix_fmt yuv420p \
  -f flv rtmp://localhost:1935/live/stream
```

### 3. 播放

打开 Chrome 或 Edge 浏览器访问：

```
https://localhost:7777/?url=live/stream
```

`url` 参数必须与推流路径一致。

### 多流示例

```bash
# 终端 1：推流 camera1
ffmpeg ... -f flv rtmp://localhost:1935/live/cam1

# 终端 2：推流 camera2
ffmpeg ... -f flv rtmp://localhost:1935/live/cam2
```

```url
# 浏览器标签页 1
https://localhost:7777/?url=live/cam1

# 浏览器标签页 2
https://localhost:7777/?url=live/cam2
```

## 播放器细节

### 浏览器兼容性

| 浏览器 | 状态 | 要求 |
|--------|------|------|
| Chrome | ✓ | 94+ |
| Edge | ✓ | 94+ (Chromium 内核) |
| Firefox | ✗ | 不支持 WebCodecs |
| Safari | ✗ | 不支持 WebCodecs |

### 数据格式

| 阶段 | 格式 | 说明 |
|------|------|------|
| ffmpeg → RTMP | AVCC | 4 字节 NALU 长度前缀 |
| 服务器 → 浏览器 | AVCC | 保持原始格式 |
| WebCodecs 解码 | AVCC + extradata | 传入 AVCDecoderConfigurationRecord |

### 消息协议

二进制帧格式：

```
[4 bytes: message_type]  0=编码配置, 1=视频帧
[4 bytes: timestamp]     毫秒
[4 bytes: payload_length]
[payload]
```

- 消息类型 `0`：编码配置（SPS + PPS）
- 消息类型 `1`：视频帧（1 byte 帧类型 + H264 数据）

## 项目结构

```
carrot-streaming-media/
├── arrot.conf                        # 配置文件
├── cmd/server/main.go                # 入口，启动所有服务器
├── cert/
│   ├── cert.go                       # TLS 证书加载
├── internal/
│   ├── config/config.go              # 配置文件解析
│   ├── media/stream.go               # StreamManager 多流管理
│   ├── rtmp/server.go                # RTMP 接收服务器
│   └── websocket/server.go           # HTTPS/WSS 播放服务器
├── web/
│   ├── index.html                    # 播放器页面
│   └── js/player.js                  # WebCodecs 解码播放器
├── go.mod
└── README.md
```

## 常见问题

### WebSocket 连接失败

```
WebSocket connection to 'wss://localhost:7777/ws?url=live/stream' failed
```

- 服务器是否已启动：检查控制台日志
- 端口是否被占用：`netstat -ano | findstr :7777`
- 证书是否有效：浏览器地址栏是否显示安全锁

### 黑屏 / 无画面

1. 确认使用 Chrome 或 Edge
2. 检查控制台是否有 `VideoDecoder is not defined` — 浏览器不支持 WebCodecs
3. 确认推流参数包含 `-pix_fmt yuv420p`（4:2:0 是浏览器唯一支持的色度采样）
4. 确认 `?url=` 参数值与推流路径一致

### 解码错误

```
Decoder error: EncodingError: Decoder error
```

- 推流时加上 `-pix_fmt yuv420p`，浏览器不支持 4:2:2 或 4:4:4
- 使用兼容的 H264 Profile（Baseline/Main/High 均可）

### 推流缓冲溢出

```
real-time buffer [video input] too full (xx% of size) ... frame dropped!
```

- 添加 `-rtbufsize 100M` 增大缓冲区
- 降低分辨率帧率：`-video_size 640x480 -framerate 15`

### 推流速度过快

```
speed=11.7x
```

- 缺少 `-re` 参数，ffmpeg 默认以最大速度推送
- 加上 `-re` 以原始帧率推送

## 技术栈

- [Go](https://go.dev/) — 服务器语言
- [joy4](https://github.com/nareix/joy4) — RTMP 协议接收
- [gorilla/websocket](https://github.com/gorilla/websocket) — WebSocket
- [WebCodecs API](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API) — 浏览器 H264 硬件解码
