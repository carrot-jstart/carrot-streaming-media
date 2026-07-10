/**
 * Stream Player - Auto-connects via WebSocket using ?url= query parameter.
 * Decodes H264 with WebCodecs and renders to fullscreen canvas.
 */
class StreamPlayer {
    constructor() {
        this.canvas = document.getElementById('videoCanvas');
        this.ctx = this.canvas.getContext('2d');
        this.statusEl = document.getElementById('status');
        this.placeholderEl = document.getElementById('placeholder');
        this.streamPathEl = document.getElementById('streamPath');

        this.ws = null;
        this.decoder = null;
        this.frameCount = 0;
        this.decodedCount = 0;
        this.droppedCount = 0;
        this.lastFrameTime = 0;
        this.fps = 0;
        this.fpsCounter = 0;
        this.fpsLastCheck = performance.now();
        this.reconnectTimer = null;
        this.connected = false;

        this.getStreamUrl();
    }

    getStreamUrl() {
        const params = new URLSearchParams(window.location.search);
        const urlParam = params.get('url');
        if (!urlParam) {
            this.setStatus('缺少 ?url= 参数', 'error');
            if (this.streamPathEl) this.streamPathEl.textContent = '示例: ?url=live/stream';
            return;
        }
        if (this.streamPathEl) this.streamPathEl.textContent = '流: ' + urlParam;

        // Determine WebSocket protocol from page protocol
        const host = window.location.host;
        const wsProto ="wss";
        this.wsUrl = `${wsProto}://${host}/ws?url=${encodeURIComponent(urlParam)}`;
        this.connect();
    }

    setStatus(msg, type) {
        if (this.statusEl) {
            this.statusEl.textContent = msg;
            this.statusEl.className = type || '';
        }
        console.log(`[Player] ${msg}`);
    }

    connect() {
        this.setStatus('正在连接...');
        if (this.placeholderEl) this.placeholderEl.style.display = 'block';

        this.ws = new WebSocket(this.wsUrl);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
            this.connected = true;
            this.setStatus('已连接，等待视频流...', 'connected');
        };

        this.ws.onerror = () => {
            this.setStatus('连接失败', 'error');
        };

        this.ws.onclose = () => {
            this.connected = false;
            this.setStatus('连接已断开', 'error');
            this.scheduleReconnect();
        };

        this.ws.onmessage = (event) => {
            const data = new Uint8Array(event.data);
            this.handleMessage(data);
        };
    }

    scheduleReconnect() {
        if (this.reconnectTimer) return;
        this.setStatus('5 秒后重连...', 'error');
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, 5000);
    }

    // ---- Message handling ----

    handleMessage(data) {
        if (data.length < 12) return;

        const msgType = this.readUint32(data, 0);
        const timestamp = this.readUint32(data, 4);
        const payloadLen = this.readUint32(data, 8);
        const payload = data.slice(12, 12 + payloadLen);

        if (msgType === 0) {
            this.handleCodecConfig(payload);
        } else if (msgType === 1 && this.decoder) {
            const frameType = payload[0];
            const frameData = payload.slice(1);
            this.decodeFrame(frameType, timestamp, frameData);
        }
    }

    handleCodecConfig(payload) {
        let offset = 0;
        const codec = payload[offset++];
        if (codec !== 0) {
            this.setStatus('不支持的编码: ' + codec, 'error');
            return;
        }

        const spsLen = this.readUint32(payload, offset);
        offset += 4;
        const sps = payload.slice(offset, offset + spsLen);
        offset += spsLen;

        const ppsLen = this.readUint32(payload, offset);
        offset += 4;
        const pps = payload.slice(offset, offset + ppsLen);

        const codecStr = this.getCodecString(sps);
        this.setStatus('解码器: ' + codecStr, 'connected');
        this.initDecoder(codecStr, sps, pps);

        if (this.placeholderEl) this.placeholderEl.style.display = 'none';
    }

    getCodecString(sps) {
        if (!sps || sps.length < 4) return 'avc1.42001e';
        const profile = sps[1];
        const compat = sps[2];
        const level = sps[3];
        return `avc1.${profile.toString(16).padStart(2, '0')}${compat.toString(16).padStart(2, '0')}${level.toString(16).padStart(2, '0')}`;
    }

    initDecoder(codecStr, sps, pps) {
        if (typeof VideoDecoder === 'undefined') {
            this.setStatus('浏览器不支持 WebCodecs API，请使用 Chrome/Edge', 'error');
            return;
        }
        if (this.decoder) {
            this.decoder.close();
        }

        this.decoder = new VideoDecoder({
            output: (frame) => this.onFrame(frame),
            error: (e) => {
                this.setStatus('解码错误: ' + e.message, 'error');
                console.error('[Player] Decoder error:', e);
            }
        });

        // Build AVCC extradata from SPS/PPS
        const spsLen = sps.length;
        const ppsLen = pps.length;
        const extradata = new Uint8Array(6 + 2 + spsLen + 1 + 2 + ppsLen);
        let offset = 0;
        extradata[offset++] = 0x01;
        extradata[offset++] = sps[1];
        extradata[offset++] = sps[2];
        extradata[offset++] = sps[3];
        extradata[offset++] = 0xFF;
        extradata[offset++] = 0xE1;
        extradata[offset++] = (spsLen >> 8) & 0xFF;
        extradata[offset++] = spsLen & 0xFF;
        extradata.set(sps, offset);
        offset += spsLen;
        extradata[offset++] = 0x01;
        extradata[offset++] = (ppsLen >> 8) & 0xFF;
        extradata[offset++] = ppsLen & 0xFF;
        extradata.set(pps, offset);

        try {
            this.decoder.configure({
                codec: codecStr,
                description: extradata,
                optimizeForLatency: true
            });
        } catch (e) {
            this.setStatus('解码器配置失败: ' + e.message, 'error');
        }
    }

    decodeFrame(frameType, timestamp, data) {
        if (!this.decoder || this.decoder.state !== 'configured') return;

        const type = frameType === 0 ? 'key' : 'delta';

        // Data is in AVCC format (4-byte NALU length prefix), matching description config
        const chunk = new EncodedVideoChunk({
            type: type,
            timestamp: timestamp * 1000,
            duration: 33000,
            data: data
        });

        try {
            this.decoder.decode(chunk);
            this.frameCount++;
        } catch (e) {
            console.error('[Player] Decode error:', e);
            this.droppedCount++;
        }
    }

    onFrame(frame) {
        this.decodedCount++;

        if (this.canvas.width !== frame.displayWidth ||
            this.canvas.height !== frame.displayHeight) {
            this.canvas.width = frame.displayWidth;
            this.canvas.height = frame.displayHeight;
        }

        this.ctx.drawImage(frame, 0, 0);
        frame.close();

        this.lastFrameTime = performance.now();
        this.updateStats();
    }

    updateStats() {
        const now = performance.now();
        this.fpsCounter++;
        if (now - this.fpsLastCheck >= 1000) {
            this.fps = this.fpsCounter;
            this.fpsCounter = 0;
            this.fpsLastCheck = now;
        }

        const latency = this.lastFrameTime > 0
            ? ` ${(now - this.lastFrameTime).toFixed(0)}ms`
            : '';

        this.setStatus(
            `${this.fps} FPS | 帧:${this.frameCount} 解码:${this.decodedCount} 丢弃:${this.droppedCount}${latency}`,
            this.connected ? 'connected' : ''
        );

        // Update document title
        if (this.fps > 0) {
            document.title = `${this.fps}FPS - Carrot Streaming`;
        }
    }

    readUint32(buffer, offset) {
        return (buffer[offset] << 24) |
            (buffer[offset + 1] << 16) |
            (buffer[offset + 2] << 8) |
            buffer[offset + 3];
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.player = new StreamPlayer();
});
