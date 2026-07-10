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

## 下载与部署

从 [GitHub Releases](https://github.com/你的用户名/carrot-streaming-media/releases) 下载对应平台的包。

每个 Release 包含以下资产：

| 文件 | 适用平台 |
|------|---------|
| `carrot-streaming-media-windows-amd64.zip` | Windows 10/11 (amd64) |
| `carrot-streaming-media-linux-amd64.tar.gz` | Linux (amd64) |
| `carrot-streaming-media-darwin-amd64.tar.gz` | macOS Intel |
| `carrot-streaming-media-darwin-arm64.tar.gz` | macOS Apple Silicon (M1/M2/M3) |
| `carrot-streaming-media-docker.tar.gz` | Docker 镜像 (任意平台) |

---

### Windows 部署

**1. 解压**

```powershell
# 解压到目标目录（如 C:\carrot）
Expand-Archive -Path carrot-streaming-media-windows-amd64.zip -DestinationPath C:\carrot
cd C:\carrot
```

解压后目录结构：
```
C:\carrot\
├── carrot-server.exe    # 服务器程序
├── carrot.conf          # 配置文件
├── web\                 # 静态文件目录
│   ├── index.html
│   └── js\player.js
└── README.md
```

**2. 配置 SSL 证书**

使用 mkcert 生成浏览器信任的本地证书：

```powershell
# 安装 mkcert（需要管理员 PowerShell）
winget install FiloSottile.mkcert  # 或 choco install mkcert

# 安装 CA 到系统信任
mkcert -install

# 在 C:\carrot 下创建 cert 目录并生成证书
mkdir cert
cd cert
mkcert localhost 127.0.0.1 ::1
cd ..
```

修改 `carrot.conf` 中的证书路径：

```ini
ssl_certificate=./cert/localhost+3.pem
ssl_certificate_key=./cert/localhost+3-key.pem
```

**3. 启动服务器**

```powershell
# 前台运行
.\carrot-server.exe

# 或指定配置文件
.\carrot-server.exe -config=carrot.conf
```

**4. 注册为 Windows 服务（可选）**

使用 [NSSM](https://nssm.cc/) 将服务器注册为 Windows 服务：

```powershell
nssm install CarrotStreaming "C:\carrot\carrot-server.exe"
nssm start CarrotStreaming
```

---

### Linux 部署

**1. 解压**

```bash
tar xzf carrot-streaming-media-linux-amd64.tar.gz -C /opt/carrot
cd /opt/carrot
```

**2. 配置 SSL 证书**

使用 mkcert 或 Let's Encrypt 生成证书。

**方式一：mkcert（本地测试）**

```bash
# 安装 mkcert
sudo apt install libnss3-tools  # Debian/Ubuntu
wget -O mkcert https://github.com/FiloSottile/mkcert/releases/latest/download/mkcert-v*-linux-amd64
chmod +x mkcert && sudo mv mkcert /usr/local/bin/

mkcert -install
mkdir -p /opt/carrot/cert && cd /opt/carrot/cert
mkcert localhost 127.0.0.1 ::1
```

**方式二：Let's Encrypt（生产环境）**

```bash
# 安装 certbot
sudo apt install certbot  # Debian/Ubuntu
# sudo yum install certbot  # CentOS/RHEL

# 申请证书（需要公网 IP 和域名）
sudo certbot certonly --standalone -d your-domain.com

# 证书路径：/etc/letsencrypt/live/your-domain.com/fullchain.pem
# 私钥路径：/etc/letsencrypt/live/your-domain.com/privkey.pem
```

修改 `carrot.conf`：

```ini
ssl_certificate=/etc/letsencrypt/live/your-domain.com/fullchain.pem
ssl_certificate_key=/etc/letsencrypt/live/your-domain.com/privkey.pem
http_port=7777
rtmp_port=1935
web_dir=./web
log_level=info
```

**3. 启动服务器**

```bash
cd /opt/carrot
chmod +x carrot-server

# 前台运行
./carrot-server

# 后台运行（nohup）
nohup ./carrot-server > carrot.log 2>&1 &
```

**4. 注册为 systemd 服务（推荐生产环境）**

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

# 查看状态
sudo systemctl status carrot-streaming
# 查看日志
sudo journalctl -u carrot-streaming -f
```

---

### macOS 部署

**Intel 芯片** 下载 `carrot-streaming-media-darwin-amd64.tar.gz`  
**Apple Silicon (M系列)** 下载 `carrot-streaming-media-darwin-arm64.tar.gz`

**1. 解压**

```bash
# Apple Silicon
tar xzf carrot-streaming-media-darwin-arm64.tar.gz -C /opt/carrot
# Intel
tar xzf carrot-streaming-media-darwin-amd64.tar.gz -C /opt/carrot

cd /opt/carrot
```

**2. 配置 SSL 证书**

```bash
# 安装 mkcert
brew install mkcert

# 安装 CA 到系统信任
mkcert -install

# 生成证书
mkdir -p /opt/carrot/cert && cd /opt/carrot/cert
mkcert localhost 127.0.0.1 ::1
cd /opt/carrot
```

修改 `carrot.conf`：

```ini
ssl_certificate=./cert/localhost+3.pem
ssl_certificate_key=./cert/localhost+3-key.pem
```

**3. 启动服务器**

```bash
cd /opt/carrot
chmod +x carrot-server

# 前台运行
./carrot-server

# 后台运行
nohup ./carrot-server > carrot.log 2>&1 &
```

**4. 注册为 LaunchDaemon（可选，开机自启）**

```bash
sudo tee /Library/LaunchDaemons/com.carrot.streaming.plist > /dev/null <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.carrot.streaming</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/carrot/carrot-server</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/opt/carrot</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/opt/carrot/carrot.log</string>
    <key>StandardErrorPath</key>
    <string>/opt/carrot/carrot.log</string>
</dict>
</plist>
EOF

sudo launchctl load /Library/LaunchDaemons/com.carrot.streaming.plist
```

---

### Docker 部署

**1. 加载镜像**

```bash
# 从 Release 下载 carrot-streaming-media-docker.tar.gz
gunzip -c carrot-streaming-media-docker.tar.gz | docker load
```

或直接从源码构建：

```bash
docker build -t carrot-streaming-media .
```

**2. 创建数据目录**

```bash
mkdir -p /opt/carrot/cert /opt/carrot/config
```

**3. 配置证书**

```bash
# 使用 mkcert 生成证书
mkcert -install
cd /opt/carrot/cert
mkcert localhost 127.0.0.1 ::1
```

**4. 创建配置文件目录** `/opt/carrot/config/carrot.conf`：

```bash
mkdir -p /opt/carrot/config
```

创建 `/opt/carrot/config/carrot.conf`：

```ini
ssl_certificate=/app/cert/localhost+3.pem
ssl_certificate_key=/app/cert/localhost+3-key.pem
http_port=7777
rtmp_port=1935
web_dir=/app/web
log_level=info
```

**5. 运行容器**

```bash
docker run -d \
  --name carrot-streaming \
  --restart always \
  -p 7777:7777 \
  -p 1935:1935 \
  -v /opt/carrot/config:/app/config \
  -v /etc/letsencrypt/live:/app/cert \
  carrot-streaming-media:latest
```

**参数说明：**
- `-p 7777:7777` — 映射 HTTPS/WSS 播放端口
- `-p 1935:1935` — 映射 RTMP 推流端口
- `-v /opt/carrot/config:/app/config` — 挂载配置**目录**（容器内自动读取 `config/carrot.conf`）
- `-v /etc/letsencrypt/live:/app/cert` — 挂载证书目录
- `--restart always` — 容器退出后自动重启

**查看日志：**

```bash
docker logs -f carrot-streaming
```

**使用 docker-compose（推荐）：**

创建 `docker-compose.yml`：

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
    volumes:
      - ./config:/app/config
      - /etc/letsencrypt/live:/app/cert
```

```bash
docker-compose up -d
```

> **提示：**
> - 镜像内置了默认的 `carrot.conf`（位于 `/app/config/`），挂载配置目录会替换为你的配置
> - `carrot.conf` 中的证书路径使用容器内路径 `/app/cert/`，而不是宿主机路径
> - 挂载配置**目录**而非单个文件，避免 overlay2 文件系统冲突

---

### 源码编译

如果希望从源码编译而非使用预编译包：

```bash
# 1. 克隆项目
git clone https://github.com/你的用户名/carrot-streaming-media.git
cd carrot-streaming-media

# 2. 编译
go build -ldflags="-s -w" -o carrot-server ./cmd/server

# 3. 运行
./carrot-server
```

> 需要安装 [Go](https://go.dev/dl/) 1.25 或更高版本。

## 配置文件

服务器自动读取 `carrot.conf`，也可以通过 `-config` 指定：

```bash
./carrot-server -config=carrot.conf
```

完整配置项：

```ini
ssl_certificate=./cert/localhost+3.pem        # SSL 证书路径（PEM 格式）
ssl_certificate_key=./cert/localhost+3-key.pem # SSL 私钥路径
http_port=7777                                 # 播放页面端口 (HTTPS/WSS)
rtmp_port=1935                                 # 推流端口 (RTMP)
web_dir=./web                                  # 静态文件目录
log_level=info                                 # 日志级别: debug, info, warn, error
```

> 所有路径均为**相对于工作目录**的相对路径，或绝对路径。Docker 容器内注意路径映射。

## 证书配置

项目使用标准的 PEM 证书文件，通过 `ssl_certificate` / `ssl_certificate_key` 指定路径。

### 使用 mkcert（推荐，浏览器信任）

```bash
# 1. 安装 mkcert
# Windows: winget install FiloSottile.mkcert 或 choco install mkcert
# macOS: brew install mkcert
# Linux: 从 https://github.com/FiloSottile/mkcert/releases 下载

# 2. 安装 CA 到系统信任
mkcert -install

# 3. 在项目 cert 目录生成证书
cd cert
mkcert localhost 127.0.0.1 ::1
# 生成 localhost+3.pem 和 localhost+3-key.pem

# 4. 更新 carrot.conf 中的路径指向新生成的文件
```

mkcert 安装 CA 后，浏览器访问 `https://localhost:7777` 直接显示安全锁，无警告。

### 使用 Let's Encrypt（生产环境）

```bash
# 安装 certbot
sudo apt install certbot

# 申请证书（需要公网 IP 和域名）
sudo certbot certonly --standalone -d your-domain.com

# 配置 carrot.conf
ssl_certificate=/etc/letsencrypt/live/your-domain.com/fullchain.pem
ssl_certificate_key=/etc/letsencrypt/live/your-domain.com/privkey.pem
```

> Let's Encrypt 证书有效期为 90 天，建议配置自动续期：`sudo certbot renew --quiet`

### 使用自签名证书

生成自签名证书并配置到 `carrot.conf` 即可。需要手动在浏览器接受安全警告。

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
