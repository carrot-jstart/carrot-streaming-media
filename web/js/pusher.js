/**
 * Media Pusher - Independent audio & video push via WebSocket.
 * Each media type runs its own pipeline and WebSocket connection.
 */
class PushChannel {
    constructor(type, config) {
        this.type = type;               // 'audio' or 'video'
        this.enabled = false;           // checkbox state
        this.pushing = false;
        this.streamUrl = '';
        this.ws = null;
        this.mediaStream = null;        // from getUserMedia
        this.encoder = null;
        this.frameCount = 0;
        this.bytesSent = 0;

        // Audio-specific
        this.audioCtx = null;
        this.processor = null;

        // Video-specific
        this.configSent = false;
        this.timestamp = 0;

        // DOM refs (set by MediaPusher)
        this.el = {};

        // Config (device constraints / codec params)
        this.config = config;
    }

    setStatus(msg) {
        if (this.el.status) {
            this.el.status.textContent = msg;
        }
        console.log(`[${this.type}] ${msg}`);
    }

    updateStats() {
        if (!this.pushing || !this.el.stats) return;
        const elapsed = (this.el.stats._startTime
            ? (Date.now() - this.el.stats._startTime) / 1000
            : 1);
        const kbps = (this.bytesSent * 8) / (1000 * elapsed);
        this.el.stats.textContent =
            `${this.frameCount} 帧 | ${(this.bytesSent / 1024).toFixed(1)} KB | ${kbps.toFixed(0)} kbps`;
    }

    async start() {
        if (this.pushing) return;

        this.streamUrl = this.el.streamUrl.value.trim();
        if (!this.streamUrl) {
            this.setStatus('请输入流路径');
            return;
        }

        this.setStatus('请求设备权限...');

        try {
            this.mediaStream = await navigator.mediaDevices.getUserMedia(this.config.constraints);
        } catch (e) {
            this.setStatus('设备权限被拒绝: ' + e.message);
            return;
        }

        // Show preview for video
        if (this.type === 'video' && this.el.preview) {
            this.el.preview.srcObject = this.mediaStream;
            this.el.preview.style.display = 'block';
        }

        // Connect WebSocket
        const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
        const host = window.location.hostname;
        const paramName = this.type === 'video' ? 'videoUrl' : 'audioUrl';
        const wsUrl = `${wsProto}://${host}:7778/ws?${paramName}=${encodeURIComponent(this.streamUrl)}`;

        this.setStatus('正在连接...');
        console.log(`[${this.type}] Connecting to:`, wsUrl);

        try {
            this.ws = await new Promise((resolve, reject) => {
                const ws = new WebSocket(wsUrl);
                ws.binaryType = 'arraybuffer';
                ws.onopen = () => resolve(ws);
                ws.onerror = () => reject(new Error('连接推送服务器失败'));
                ws.onclose = (evt) => {
                    console.log(`[${this.type}] WS closed:`, evt.code, evt.reason);
                    if (this.pushing) {
                        this.setStatus('连接断开 (code=' + evt.code + ')');
                        this.stop();
                    }
                };
            });
        } catch (e) {
            this.setStatus(e.message);
            this.cleanupMedia();
            return;
        }

        this.pushing = true;
        this.frameCount = 0;
        this.bytesSent = 0;
        this.configSent = false;
        this.timestamp = 0;

        this.el.btnStart.disabled = true;
        this.el.btnStop.disabled = false;
        this.el.streamUrl.disabled = true;

        if (this.el.stats) {
            this.el.stats._startTime = Date.now();
        }
        this.el.statsTimer = setInterval(() => this.updateStats(), 1000);

        if (this.type === 'audio') {
            this.startAudioEncoding();
        } else {
            this.startVideoEncoding();
        }
    }

    stop() {
        this.pushing = false;
        this.stopEncoding();

        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.cleanupMedia();

        if (this.el.statsTimer) {
            clearInterval(this.el.statsTimer);
            this.el.statsTimer = null;
        }

        this.el.btnStart.disabled = false;
        this.el.btnStop.disabled = true;
        this.el.streamUrl.disabled = false;

        this.setStatus('已停止');
        if (this.el.stats) this.el.stats.textContent = '';
    }

    cleanupMedia() {
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(t => t.stop());
            this.mediaStream = null;
        }
        if (this.type === 'video' && this.el.preview) {
            this.el.preview.srcObject = null;
            this.el.preview.style.display = 'none';
        }
    }

    stopEncoding() {
        if (this.processor) { this.processor.disconnect(); this.processor = null; }
        if (this.encoder) { this.encoder.close(); this.encoder = null; }
        if (this.audioCtx) { this.audioCtx.close(); this.audioCtx = null; }
    }

    // ===== Audio Encoding (AAC) =====

    startAudioEncoding() {
        if (typeof AudioEncoder === 'undefined') {
            this.setStatus('浏览器不支持 AudioEncoder');
            this.stop();
            return;
        }

        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
        const source = this.audioCtx.createMediaStreamSource(this.mediaStream);

        this.encoder = new AudioEncoder({
            output: (chunk) => this.onAudioEncoded(chunk),
            error: (e) => {
                console.error('[Audio] Encoder error:', e);
                this.setStatus('编码器错误: ' + e.message);
            }
        });
        this.encoder.configure({
            codec: 'mp4a.40.2',
            sampleRate: 44100,
            numberOfChannels: 1,
            bitrate: 128000
        });

        const frameSize = 1024;
        this.processor = this.audioCtx.createScriptProcessor(frameSize, 1, 1);
        source.connect(this.processor);
        this.processor.connect(this.audioCtx.destination);

        this.timestamp = 0;
        this.processor.onaudioprocess = (event) => {
            if (!this.pushing || !this.encoder || this.encoder.state !== 'configured') return;
            const input = event.inputBuffer;
            const pcmData = input.getChannelData(0);
            const audioData = new AudioData({
                format: 'f32-planar',
                sampleRate: input.sampleRate,
                numberOfFrames: input.length,
                numberOfChannels: 1,
                timestamp: this.timestamp,
                data: pcmData
            });
            this.timestamp += input.length * 1000000 / input.sampleRate;
            try { this.encoder.encode(audioData); } catch (e) {
                console.error('[Audio] encode error:', e);
            }
            audioData.close();
        };

        this.setStatus('正在推送音频...');
    }

    onAudioEncoded(chunk) {
        if (!this.pushing || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const buffer = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buffer);
        this.ws.send(buffer);
        this.frameCount++;
        this.bytesSent += buffer.length;
    }

    // ===== Video Encoding (H.264) =====

    startVideoEncoding() {
        if (typeof VideoEncoder === 'undefined') {
            this.setStatus('浏览器不支持 VideoEncoder');
            this.stop();
            return;
        }
        if (typeof MediaStreamTrackProcessor === 'undefined') {
            this.setStatus('浏览器不支持 MediaStreamTrackProcessor');
            this.stop();
            return;
        }

        const track = this.mediaStream.getVideoTracks()[0];
        if (!track) {
            this.setStatus('未检测到摄像头');
            this.stop();
            return;
        }
        const settings = track.getSettings();
        const width = settings.width || 640;
        const height = settings.height || 480;
        console.log(`[Video] Track: ${width}x${height}`);

        this.encoder = new VideoEncoder({
            output: (chunk, metadata) => this.onVideoEncoded(chunk, metadata, width, height),
            error: (e) => {
                console.error('[Video] Encoder error:', e);
                this.setStatus('编码器错误: ' + e.message);
            }
        });
        this.encoder.configure({
            codec: 'avc1.42001e',
            width,
            height,
            bitrate: 1000000,
            framerate: 24,
            avc: { format: 'avc' }
        });

        const trackProcessor = new MediaStreamTrackProcessor({ track });
        const reader = trackProcessor.readable.getReader();

        const readFrame = () => {
            reader.read().then(({ done, value }) => {
                if (done || !this.pushing) return;
                if (value) {
                    if (this.encoder.state === 'configured') {
                        try {
                            this.encoder.encode(value);
                        } catch (e) {
                            console.error('[Video] encode error:', e);
                        }
                    }
                    value.close();
                    this.timestamp += 1000000 / 24;
                }
                readFrame();
            }).catch((err) => {
                console.error('[Video] reader error:', err);
                if (this.pushing) readFrame();
            });
        };
        readFrame();

        this.setStatus('正在推送视频...');
    }

    onVideoEncoded(chunk, metadata, width, height) {
        if (!this.pushing || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const isKeyFrame = chunk.type === 'key';

        // Send codec config on first keyframe
        if (!this.configSent && isKeyFrame) {
            let config = null;

            const decoderConfig = metadata && (metadata.decoderConfig || metadata);
            if (decoderConfig && decoderConfig.description) {
                config = this.buildConfigFromDescription(decoderConfig.description, width, height);
            }
            if (!config) {
                config = this.extractAVCConfig(chunk, width, height);
            }

            if (config) {
                this.ws.send(config);
                this.configSent = true;
                console.log(`[Video] Config sent: ${width}x${height}`);
            } else {
                console.warn('[Video] Failed to extract config, waiting for next keyframe');
            }
        }

        if (!this.configSent) return;

        // Frame message: [4-byte ts_ms][1-byte keyframe][AVCC data]
        const rawData = new Uint8Array(chunk.byteLength);
        chunk.copyTo(rawData);

        const msgLen = 5 + rawData.length;
        const msg = new Uint8Array(msgLen);
        const view = new DataView(msg.buffer);
        view.setUint32(0, this.timestamp / 1000, false);
        msg[4] = isKeyFrame ? 1 : 0;
        msg.set(rawData, 5);

        this.ws.send(msg);
        this.frameCount++;
        this.bytesSent += msgLen;
    }

    // Parse AVCC extradata from decoderConfig.description
    buildConfigFromDescription(description, width, height) {
        let desc;
        if (description instanceof Uint8Array) {
            desc = description;
        } else if (description instanceof ArrayBuffer) {
            desc = new Uint8Array(description);
        } else if (description && description.buffer) {
            desc = new Uint8Array(description.buffer, description.byteOffset, description.byteLength);
        } else {
            return null;
        }
        if (desc.length < 7 || desc[0] !== 0x01) return null;

        let offset = 5;
        const numSPS = desc[offset] & 0x1F;
        offset += 1;
        if (numSPS === 0) return null;

        const spsLen = (desc[offset] << 8) | desc[offset + 1];
        offset += 2;
        if (offset + spsLen > desc.length) return null;
        const sps = desc.slice(offset, offset + spsLen);
        offset += spsLen;

        const numPPS = desc[offset];
        offset += 1;
        if (numPPS === 0 || offset + 2 > desc.length) return null;
        const ppsLen = (desc[offset] << 8) | desc[offset + 1];
        offset += 2;
        if (offset + ppsLen > desc.length) return null;
        const pps = desc.slice(offset, offset + ppsLen);

        return this.buildConfigMsg(sps, pps, width, height);
    }

    // Extract SPS/PPS from chunk AVCC data (fallback)
    extractAVCConfig(chunk, width, height) {
        const rawData = new Uint8Array(chunk.byteLength);
        chunk.copyTo(rawData);

        let offset = 0;
        let sps = null;
        let pps = null;

        while (offset + 4 <= rawData.length) {
            const naluLen = (rawData[offset] << 24) | (rawData[offset + 1] << 16) |
                (rawData[offset + 2] << 8) | rawData[offset + 3];
            offset += 4;
            if (offset + naluLen > rawData.length) break;

            const naluType = rawData[offset] & 0x1F;
            if (naluType === 7) sps = rawData.slice(offset, offset + naluLen);
            else if (naluType === 8) pps = rawData.slice(offset, offset + naluLen);
            offset += naluLen;
        }

        if (!sps || !pps) return null;
        return this.buildConfigMsg(sps, pps, width, height);
    }

    buildConfigMsg(sps, pps, width, height) {
        const configLen = 4 + sps.length + 4 + pps.length + 4 + 4;
        const config = new Uint8Array(configLen);
        const view = new DataView(config.buffer);
        let pos = 0;
        view.setUint32(pos, sps.length, false); pos += 4;
        config.set(sps, pos); pos += sps.length;
        view.setUint32(pos, pps.length, false); pos += 4;
        config.set(pps, pos); pos += pps.length;
        view.setUint32(pos, width, false); pos += 4;
        view.setUint32(pos, height, false); pos += 4;
        return config;
    }
}

// ===== Main Controller =====

class MediaPusher {
    constructor() {
        this.audio = new PushChannel('audio', {
            constraints: {
                audio: { sampleRate: 44100, channelCount: 1, echoCancellation: true, noiseSuppression: true },
                video: false
            }
        });
        this.video = new PushChannel('video', {
            constraints: {
                audio: false,
                video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } }
            }
        });

        // Wire DOM elements
        this.audio.el = {
            enabled: document.getElementById('enableAudio'),
            streamUrl: document.getElementById('audioStreamUrl'),
            btnStart: document.getElementById('btnAudioStart'),
            btnStop: document.getElementById('btnAudioStop'),
            status: document.getElementById('audioStatus'),
            stats: document.getElementById('audioStats'),
        };
        this.video.el = {
            enabled: document.getElementById('enableVideo'),
            streamUrl: document.getElementById('videoStreamUrl'),
            btnStart: document.getElementById('btnVideoStart'),
            btnStop: document.getElementById('btnVideoStop'),
            status: document.getElementById('videoStatus'),
            stats: document.getElementById('videoStats'),
            preview: document.getElementById('preview'),
        };

        // Bind events
        this.audio.el.btnStart.addEventListener('click', () => this.audio.start());
        this.audio.el.btnStop.addEventListener('click', () => this.audio.stop());
        this.video.el.btnStart.addEventListener('click', () => this.video.start());
        this.video.el.btnStop.addEventListener('click', () => this.video.stop());

        console.log('[Pusher] Ready');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.pusher = new MediaPusher();
});
