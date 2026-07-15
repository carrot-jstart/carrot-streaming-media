/**
 * Stream Player - Opens two WebSocket connections for video and audio separately.
 *   Video: auto-connects via ?videoUrl= or ?url=
 *   Audio: auto-connects via ?audioUrl= or ?url=
 * Decodes H264 with WebCodecs VideoDecoder and AAC/MP3 with AudioDecoder,
 * renders video to fullscreen canvas and plays audio through AudioContext.
 */
class StreamPlayer {
    constructor() {
        this.canvas = document.getElementById('videoCanvas');
        this.ctx = this.canvas.getContext('2d');
        this.statusEl = document.getElementById('status');
        this.placeholderEl = document.getElementById('placeholder');
        this.placeholderTitle = document.getElementById('placeholderTitle');
        this.placeholderHint = document.getElementById('placeholderHint');

        this.videoWs = null;
        this.audioWs = null;
        this.videoDecoder = null;
        this.audioDecoder = null;
        this.audioCtx = null;
        this.nextAudioTime = 0;

        this.frameCount = 0;
        this.decodedCount = 0;
        this.droppedCount = 0;
        this.lastFrameTime = 0;
        this.fps = 0;
        this.fpsCounter = 0;
        this.fpsLastCheck = performance.now();
        this.videoReconnectTimer = null;
        this.audioReconnectTimer = null;
        this.connected = false;

        // Video decoder state: after configure(), first frame must be keyframe
        this.videoNeedsKeyframe = false;

        // Audio decoder state
        this.audioConfig = null;
        this.audioAOT = 2;
        this.audioDecodedFrames = 0;

        // What connections were originally requested
        this.hasVideo = false;
        this.hasAudio = false;

        this.parseParams();
    }

    parseParams() {
        const params = new URLSearchParams(window.location.search);
        const videoUrlParam = params.get('videoUrl');
        const audioUrlParam = params.get('audioUrl');

        this.hasVideo = !!videoUrlParam;
        this.hasAudio = !!audioUrlParam;

        if (!this.hasVideo && !this.hasAudio) {
            this.setStatus('缺少参数', 'error');
            if (this.placeholderTitle) this.placeholderTitle.textContent = '缺少参数';
            if (this.placeholderHint) this.placeholderHint.textContent = '请添加 ?videoUrl=xxx&audioUrl=xxx 参数';
            return;
        }

        const host = window.location.host;
        const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';

        // Build hint text
        let hintParts = [];
        if (this.hasVideo) {
            this.videoWsUrl = `${wsProto}://${host}/ws?videoUrl=${encodeURIComponent(videoUrlParam)}`;
            hintParts.push('视频: ' + videoUrlParam);
        }
        if (this.hasAudio) {
            this.audioWsUrl = `${wsProto}://${host}/ws?audioUrl=${encodeURIComponent(audioUrlParam)}`;
            hintParts.push('音频: ' + audioUrlParam);
        }

        if (this.placeholderHint) this.placeholderHint.textContent = hintParts.join(' | ');
        if (this.placeholderTitle) this.placeholderTitle.textContent = '正在连接...';

        // Hide canvas if no video
        if (!this.hasVideo && this.canvas) {
            this.canvas.style.display = 'none';
        }

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

        if (this.hasVideo) this.connectVideo();
        if (this.hasAudio) this.connectAudio();
    }

    // ---- Video WebSocket ----

    connectVideo() {
        this.videoWs = new WebSocket(this.videoWsUrl);
        this.videoWs.binaryType = 'arraybuffer';

        this.videoWs.onopen = () => {
            this.connected = true;
            this.updateConnectedStatus();
        };

        this.videoWs.onerror = () => {
            this.setStatus('视频连接失败', 'error');
        };

        this.videoWs.onclose = () => {
            this.cleanupVideo();
            this.scheduleVideoReconnect();
        };

        this.videoWs.onmessage = (event) => {
            const data = new Uint8Array(event.data);
            this.handleVideoMessage(data);
        };
    }

    // ---- Audio WebSocket ----

    connectAudio() {
        this.audioWs = new WebSocket(this.audioWsUrl);
        this.audioWs.binaryType = 'arraybuffer';

        this.audioWs.onopen = () => {
            this.connected = true;
            this.updateConnectedStatus();
        };

        this.audioWs.onerror = () => {
            console.warn('[Player] Audio connection failed (no audio stream?)');
        };

        this.audioWs.onclose = () => {
            this.cleanupAudio();
            this.scheduleAudioReconnect();
        };

        this.audioWs.onmessage = (event) => {
            const data = new Uint8Array(event.data);
            this.handleAudioMessage(data);
        };
    }

    updateConnectedStatus() {
        if (this.connected) {
            this.setStatus('已连接，等待流...', 'connected');
        }
    }

    cleanup() {
        this.cleanupVideo();
        this.cleanupAudio();
    }

    cleanupVideo() {
        if (this.videoReconnectTimer) {
            clearTimeout(this.videoReconnectTimer);
            this.videoReconnectTimer = null;
        }
        if (this.videoDecoder) {
            this.videoDecoder.close();
            this.videoDecoder = null;
        }
        if (this.videoWs) {
            this.videoWs.close();
            this.videoWs = null;
        }
        this.frameCount = 0;
        this.decodedCount = 0;
        this.droppedCount = 0;
        this.videoNeedsKeyframe = true;
    }

    cleanupAudio() {
        if (this.audioReconnectTimer) {
            clearTimeout(this.audioReconnectTimer);
            this.audioReconnectTimer = null;
        }
        if (this.audioDecoder) {
            this.audioDecoder.close();
            this.audioDecoder = null;
        }
        if (this.audioCtx) {
            this.audioCtx.close();
            this.audioCtx = null;
        }
        if (this.audioWs) {
            this.audioWs.close();
            this.audioWs = null;
        }
        this.nextAudioTime = 0;
        this.audioConfig = null;
        this.audioDecodedFrames = 0;
    }

    scheduleVideoReconnect() {
        if (this.videoReconnectTimer) return;
        this.setStatus('视频断开，5 秒后重连...', 'error');
        this.videoReconnectTimer = setTimeout(() => {
            this.videoReconnectTimer = null;
            this.cleanupVideo();
            if (this.hasVideo) this.connectVideo();
        }, 5000);
    }

    scheduleAudioReconnect() {
        if (this.audioReconnectTimer) return;
        this.setStatus('音频断开，5 秒后重连...', 'error');
        this.audioReconnectTimer = setTimeout(() => {
            this.audioReconnectTimer = null;
            this.cleanupAudio();
            if (this.hasAudio) this.connectAudio();
        }, 5000);
    }

    // ---- Video message handling ----

    handleVideoMessage(data) {
        if (data.length < 12) return;

        const msgType = this.readUint32(data, 0);
        const timestamp = this.readUint32(data, 4);
        const payloadLen = this.readUint32(data, 8);
        const payload = data.slice(12, 12 + payloadLen);

        switch (msgType) {
            case 0: // MsgTypeCodecConfig
                this.handleVideoCodecConfig(payload);
                break;
            case 1: // MsgTypeVideoFrame
                if (this.videoDecoder) {
                    this.decodeVideoFrame(payload, timestamp);
                }
                break;
        }
    }

    handleVideoCodecConfig(payload) {
        let offset = 0;
        const codec = payload[offset++];
        if (codec !== 0) {
            this.setStatus('不支持的视频编码: ' + codec, 'error');
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
        this.setStatus('视频解码器: ' + codecStr, 'connected');
        this.initVideoDecoder(codecStr, sps, pps);

        if (this.placeholderEl) this.placeholderEl.style.display = 'none';
    }

    getCodecString(sps) {
        if (!sps || sps.length < 4) return 'avc1.42001e';
        const profile = sps[1];
        const compat = sps[2];
        const level = sps[3];
        return `avc1.${profile.toString(16).padStart(2, '0')}${compat.toString(16).padStart(2, '0')}${level.toString(16).padStart(2, '0')}`;
    }

    initVideoDecoder(codecStr, sps, pps) {
        if (typeof VideoDecoder === 'undefined') {
            this.setStatus('浏览器不支持 WebCodecs VideoDecoder，请使用 Chrome/Edge', 'error');
            return;
        }
        if (this.videoDecoder) {
            this.videoDecoder.close();
        }

        this.videoDecoder = new VideoDecoder({
            output: (frame) => this.onVideoFrame(frame),
            error: (e) => {
                this.setStatus('视频解码错误: ' + e.message, 'error');
                console.error('[Player] Video decoder error:', e);
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
            this.videoDecoder.configure({
                codec: codecStr,
                description: extradata,
                optimizeForLatency: true
            });
            // After configure(), the decoder requires the first frame to be a keyframe.
            this.videoNeedsKeyframe = true;
        } catch (e) {
            this.setStatus('视频解码器配置失败: ' + e.message, 'error');
        }
    }

    decodeVideoFrame(data, timestamp) {
        if (!this.videoDecoder || this.videoDecoder.state !== 'configured') return;

        const frameType = data[0];
        const frameData = data.slice(1);
        const type = frameType === 0 ? 'key' : 'delta';

        // After configure() or flush(), the decoder needs a keyframe first.
        // Drop delta frames until we get one.
        if (this.videoNeedsKeyframe) {
            if (type !== 'key') {
                this.droppedCount++;
                return;
            }
            this.videoNeedsKeyframe = false;
        }

        const chunk = new EncodedVideoChunk({
            type: type,
            timestamp: timestamp * 1000,
            duration: 33000,
            data: frameData
        });

        try {
            this.videoDecoder.decode(chunk);
            this.frameCount++;
        } catch (e) {
            console.error('[Player] Video decode error:', e);
            this.droppedCount++;
        }
    }

    onVideoFrame(frame) {
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

    // ---- Audio message handling ----

    handleAudioMessage(data) {
        if (data.length < 12) return;

        const msgType = this.readUint32(data, 0);
        const timestamp = this.readUint32(data, 4);
        const payloadLen = this.readUint32(data, 8);
        const payload = data.slice(12, 12 + payloadLen);

        switch (msgType) {
            case 2: // MsgTypeAudioConfig
                this.handleAudioCodecConfig(payload);
                break;
            case 3: // MsgTypeAudioFrame
                if (this.audioDecoder) {
                    this.decodeAudioFrame(payload, timestamp);
                }
                break;
        }
    }

    handleAudioCodecConfig(payload) {
        let offset = 0;
        const codecType = payload[offset++]; // 0=AAC, 1=MP3
        const sampleRate = this.readUint32(payload, offset);
        offset += 4;
        const channels = payload[offset++];
        const configData = payload.slice(offset);

        // Parse Audio Object Type from AudioSpecificConfig (for AAC)
        // configData[0] top 5 bits = AOT
        const audioObjectType = configData.length > 0
            ? (configData[0] >> 3) & 0x1F
            : 2; // default to AAC-LC
        this.audioAOT = audioObjectType;

        this.audioConfig = { codecType, sampleRate, channels, configData };
        console.log('[Player] Audio config:',
            'codecType=' + codecType,
            'AOT=' + audioObjectType,
            'sampleRate=' + sampleRate,
            'channels=' + channels,
            'configData=' + Array.from(configData).map(b => b.toString(16)).join(' '));
        this.initAudio();
        this.initAudioDecoder();
    }

    initAudio() {
        if (this.audioCtx) return;
        try {
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: this.audioConfig.sampleRate,
            });
            this.nextAudioTime = this.audioCtx.currentTime;
            console.log('[Player] AudioContext initialized:', this.audioCtx.sampleRate, 'Hz');
        } catch (e) {
            console.error('[Player] Failed to create AudioContext:', e);
        }
    }

    initAudioDecoder() {
        if (typeof AudioDecoder === 'undefined') {
            console.warn('[Player] WebCodecs AudioDecoder not supported');
            return;
        }

        if (this.audioDecoder) {
            this.audioDecoder.close();
            this.audioDecoder = null;
        }

        const config = this.buildAudioDecoderConfig();
        if (!config) {
            console.warn('[Player] Unsupported audio codec:', this.audioConfig.codecType);
            return;
        }

        this.audioDecoder = new AudioDecoder({
            output: (audioData) => this.onAudioFrame(audioData),
            error: (e) => {
                console.error('[Player] Audio decoder error:', e);
            }
        });

        try {
            this.audioDecoder.configure(config);
            console.log('[Player] Audio decoder configured:', JSON.stringify(config));
        } catch (e) {
            console.error('[Player] Audio decoder config failed:', e);
        }
    }

    buildAudioDecoderConfig() {
        const cfg = this.audioConfig;
        if (!cfg) return null;

        switch (cfg.codecType) {
            case 0: { // AAC
                const aot = this.audioAOT || 2;
                return {
                    codec: 'mp4a.40.' + aot,
                    sampleRate: cfg.sampleRate,
                    numberOfChannels: cfg.channels,
                    description: cfg.configData.length > 0 ? cfg.configData : undefined
                };
            }
            case 1: // MP3
                return {
                    codec: 'mp3',
                    sampleRate: cfg.sampleRate,
                    numberOfChannels: cfg.channels
                };
            default:
                return null;
        }
    }

    decodeAudioFrame(data, timestamp) {
        if (!this.audioDecoder || this.audioDecoder.state !== 'configured') return;
        if (!this.audioCtx) return;

        if (this.audioCtx.state === 'suspended') {
            this.audioCtx.resume().catch(e => console.warn('[Player] AudioContext resume failed:', e));
        }

        const chunk = new EncodedAudioChunk({
            type: 'key',
            timestamp: timestamp * 1000,
            duration: (1024 / this.audioConfig.sampleRate) * 1000000, // AAC frame duration in µs
            data: data
        });

        try {
            this.audioDecoder.decode(chunk);
        } catch (e) {
            console.error('[Player] Audio decode error:', e);
        }
    }

    onAudioFrame(audioData) {
        this.audioDecodedFrames++;
        if (!this.audioCtx) {
            audioData.close();
            return;
        }
        this.scheduleAudioFrame(audioData);
    }

    // Audio scheduling: prefer smooth playback over minimal latency.
    // Allows up to ~1s of buffer to absorb network jitter.
    scheduleAudioFrame(audioData) {
        const ctx = this.audioCtx;
        const duration = audioData.duration;
        if (!duration || duration <= 0) {
            audioData.close();
            return;
        }

        const numberOfChannels = audioData.numberOfChannels;
        const sampleRate = audioData.sampleRate;
        const frameCount = audioData.numberOfFrames;

        const audioBuffer = ctx.createBuffer(numberOfChannels, frameCount, sampleRate);
        for (let ch = 0; ch < numberOfChannels; ch++) {
            const channelData = audioBuffer.getChannelData(ch);
            audioData.copyTo(channelData, { planeIndex: ch, format: 'f32-planar' });
        }
        audioData.close();

        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ctx.destination);

        const now = ctx.currentTime;

        // Drift control: maintain a cushion of ~500ms ahead.
        // If we fall behind, schedule immediately.
        // If we're way ahead (>1s), gently pull back to 500ms.
        const targetAhead = 0.5;   // 500ms target cushion
        const maxAhead = 1.0;      // 1s hard cap before correction

        if (this.nextAudioTime < now) {
            // Fell behind real time → jump to target cushion
            this.nextAudioTime = now + targetAhead;
        } else if (this.nextAudioTime - now > maxAhead) {
            // Too far ahead → gently pull back to target cushion
            this.nextAudioTime = now + targetAhead;
        }

        source.start(this.nextAudioTime);
        this.nextAudioTime += duration / 1000000; // duration is in microseconds
    }

    // ---- Stats ----

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

        const audioInfo = this.audioConfig
            ? ` | 音频:${this.audioDecodedFrames}帧`
            : '';

        this.setStatus(
            `${this.fps} FPS | 帧:${this.frameCount} 解码:${this.decodedCount} 丢弃:${this.droppedCount}${latency}${audioInfo}`,
            this.connected ? 'connected' : ''
        );

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
