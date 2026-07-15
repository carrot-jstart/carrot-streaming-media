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

服务器与浏览器之间使用二进制帧通信：

```
[4 bytes: message_type]  [4 bytes: timestamp]  [4 bytes: payload_length]  [payload]

消息类型:
  0 = 视频编解码配置 (SPS/PPS)
  1 = 视频帧
  2 = 音频编解码配置
  3 = 音频帧
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
│       ├── player.js                 # WebCodecs 解码播放器
│       └── pusher.js                 # 浏览器推流客户端
├── Dockerfile                        # Docker 构建
├── go.mod / go.sum                   # Go 依赖
└── README.md
```

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
