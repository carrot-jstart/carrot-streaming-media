/**
 * CarrotSDK v1.0.0
 * Unified SDK for Carrot Streaming Media
 * 
 * Provides:
 *   - CarrotSDK.Player    — WebCodecs H.264/AAC playback via WebSocket
 *   - CarrotSDK.Pusher    — Browser push (H.264 video + AAC audio) via WebSocket
 *   - CarrotSDK.version   — SDK version string
 * 
 * Usage:
 *   const player = new CarrotSDK.Player({ videoUrl: 'live/stream' });
 *   player.connect();
 * 
 *   const pusher = new CarrotSDK.Pusher();
 *   pusher.startVideo('video/browser');
 *   pusher.startAudio('audio/browser');
 */
(function () {
    'use strict';

    var VERSION = '1.0.0';

    // ========================================================================
    //  Utility helpers
    // ========================================================================

    function readUint32(buffer, offset) {
        return (buffer[offset] << 24) |
            (buffer[offset + 1] << 16) |
            (buffer[offset + 2] << 8) |
            buffer[offset + 3];
    }

    /** Resolve a DOM element from an element, id string, or null */
    function resolveEl(selector) {
        if (!selector) return null;
        if (selector instanceof HTMLElement) return selector;
        if (typeof selector === 'string') return document.getElementById(selector);
        return null;
    }

    // ========================================================================
    //  CarrotSDK.Player
    //  Wraps WebCodecs-based H.264/AAC streaming player.
    // ========================================================================

    /**
     * @param {Object} [options]
     * @param {HTMLElement|string} [options.canvas]        - <canvas> element or its id
     * @param {HTMLElement|string} [options.statusEl]      - status bar element or its id
     * @param {HTMLElement|string} [options.placeholderEl] - placeholder element or its id
     * @param {HTMLElement|string} [options.placeholderTitle]
     * @param {HTMLElement|string} [options.placeholderHint]
     * @param {string} [options.videoUrl]  - stream path for video (e.g. 'live/stream')
     * @param {string} [options.audioUrl]  - stream path for audio (e.g. 'audio/stream')
     * @param {string} [options.host]      - server host, defaults to current page host
     * @param {number} [options.port]      - server port, defaults to current page port
     * @param {function(string, string):void} [options.onStatus] - status callback(msg, type)
     * @param {function(Object):void} [options.onStats]           - stats callback
     * @param {function(VideoFrame):void} [options.onFrame]       - video frame callback
     */
    function CarrotPlayer(options) {
        options = options || {};

        this.canvas = resolveEl(options.canvas) || document.getElementById('videoCanvas');
        this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
        this.statusEl = resolveEl(options.statusEl) || document.getElementById('status');
        this.placeholderEl = resolveEl(options.placeholderEl) || document.getElementById('placeholder');
        this.placeholderTitle = resolveEl(options.placeholderTitle) || document.getElementById('placeholderTitle');
        this.placeholderHint = resolveEl(options.placeholderHint) || document.getElementById('placeholderHint');

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
        this.fpsLastCheck = 0;
        this.videoReconnectTimer = null;
        this.audioReconnectTimer = null;
        this.connected = false;

        // Decoder state
        this.videoNeedsKeyframe = false;
        this.audioConfig = null;
        this.audioAOT = 2;
        this.audioDecodedFrames = 0;

        // Data timeout detection (reconnect if no data within this period)
        this.videoDataTime = 0;
        this.audioDataTime = 0;
        this._videoDataTimer = null;
        this._audioDataTimer = null;
        this._dataTimeoutMs = options.dataTimeout || 10000; // default 10s

        // Connection config
        this.hasVideo = false;
        this.hasAudio = false;
        this._host = options.host || window.location.hostname;
        this._port = options.port || window.location.port;
        this._videoUrl = options.videoUrl || '';
        this._audioUrl = options.audioUrl || '';

        // Callbacks
        this._onStatus = options.onStatus || null;
        this._onStats = options.onStats || null;
        this._onFrame = options.onFrame || null;

        // If URLs provided via options, auto-parse
        if (this._videoUrl || this._audioUrl) {
            this.hasVideo = !!this._videoUrl;
            this.hasAudio = !!this._audioUrl;
        } else {
            // Fallback: parse from URL params
            this._parseParamsFromURL();
        }
    }

    CarrotPlayer.prototype._parseParamsFromURL = function () {
        var params = new URLSearchParams(window.location.search);
        var videoUrlParam = params.get('videoUrl') || params.get('url');
        var audioUrlParam = params.get('audioUrl') || params.get('url');
        var dataTimeoutParam = params.get('dataTimeout');
        if (dataTimeoutParam) {
            var parsed = parseInt(dataTimeoutParam, 10);
            if (!isNaN(parsed) && parsed > 0) {
                this._dataTimeoutMs = parsed;
            }
        }

        this.hasVideo = !!videoUrlParam;
        this.hasAudio = !!audioUrlParam;
        this._videoUrl = videoUrlParam || '';
        this._audioUrl = audioUrlParam || '';

        if (!this.hasVideo && !this.hasAudio) {
            this.setStatus('\u7f3a\u5c11\u53c2\u6570', 'error');
            if (this.placeholderTitle) this.placeholderTitle.textContent = '\u7f3a\u5c11\u53c2\u6570';
            if (this.placeholderHint) this.placeholderHint.textContent = '\u8bf7\u6dfb\u52a0 ?videoUrl=xxx&audioUrl=xxx \u53c2\u6570';
            return;
        }

        var host = window.location.host;
        var wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
        var hintParts = [];

        if (this.hasVideo) {
            this.videoWsUrl = wsProto + '://' + host + '/ws?videoUrl=' + encodeURIComponent(this._videoUrl);
            hintParts.push('\u89c6\u9891: ' + this._videoUrl);
        }
        if (this.hasAudio) {
            this.audioWsUrl = wsProto + '://' + host + '/ws?audioUrl=' + encodeURIComponent(this._audioUrl);
            hintParts.push('\u97f3\u9891: ' + this._audioUrl);
        }

        if (this.placeholderHint) this.placeholderHint.textContent = hintParts.join(' | ');
        if (this.placeholderTitle) this.placeholderTitle.textContent = '\u6b63\u5728\u8fde\u63a5...';

        if (!this.hasVideo && this.canvas) {
            this.canvas.style.display = 'none';
        }

        // Auto-connect after parsing URL params
        this.connect();
    };

    CarrotPlayer.prototype.setStatus = function (msg, type) {
        if (this.statusEl) {
            this.statusEl.textContent = msg;
            this.statusEl.className = type || '';
        }
        if (this._onStatus) this._onStatus(msg, type);
        console.log('[CarrotSDK Player] ' + msg);
    };

    /**
     * Connect to the media server.
     * If videoUrl/audioUrl were provided in constructor, those will be used.
     * Otherwise, pass them here.
     */
    CarrotPlayer.prototype.connect = function (videoUrl, audioUrl) {
        if (videoUrl !== undefined) {
            this._videoUrl = videoUrl;
            this.hasVideo = !!videoUrl;
        }
        if (audioUrl !== undefined) {
            this._audioUrl = audioUrl;
            this.hasAudio = !!audioUrl;
        }

        // Build WebSocket URLs
        var host = this._host;
        var port = this._port || window.location.port;
        var wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
        var wsBase = wsProto + '://' + host + (port ? ':' + port : '');

        if (this.hasVideo) {
            this.videoWsUrl = wsBase + '/ws?videoUrl=' + encodeURIComponent(this._videoUrl);
        }
        if (this.hasAudio) {
            this.audioWsUrl = wsBase + '/ws?audioUrl=' + encodeURIComponent(this._audioUrl);
        }

        this.setStatus('\u6b63\u5728\u8fde\u63a5...');
        if (this.placeholderEl) this.placeholderEl.style.display = 'block';
        if (this.placeholderTitle) this.placeholderTitle.textContent = '\u6b63\u5728\u8fde\u63a5...';

        if (this.hasVideo) this._connectVideo();
        if (this.hasAudio) this._connectAudio();
    };

    /** Disconnect and clean up */
    CarrotPlayer.prototype.disconnect = function () {
        this._cleanup();
        this.setStatus('\u5df2\u65ad\u5f00');
    };

    /** Full cleanup (alias for backward compatibility) */
    CarrotPlayer.prototype.destroy = function () {
        this.disconnect();
    };

    // ---- Video WebSocket ----

    CarrotPlayer.prototype._connectVideo = function () {
        var self = this;
        this.videoWs = new WebSocket(this.videoWsUrl);
        this.videoWs.binaryType = 'arraybuffer';

        this.videoWs.onopen = function () {
            self.connected = true;
            self._updateConnectedStatus();
            self._resetVideoDataTimer();
        };

        this.videoWs.onerror = function () {
            self.setStatus('\u89c6\u9891\u8fde\u63a5\u5931\u8d25', 'error');
        };

        this.videoWs.onclose = function () {
            self._cleanupVideo();
            self._scheduleVideoReconnect();
        };

        this.videoWs.onmessage = function (event) {
            var data = new Uint8Array(event.data);
            self._handleVideoMessage(data);
        };
    };

    // ---- Audio WebSocket ----

    CarrotPlayer.prototype._connectAudio = function () {
        var self = this;
        this.audioWs = new WebSocket(this.audioWsUrl);
        this.audioWs.binaryType = 'arraybuffer';

        this.audioWs.onopen = function () {
            self.connected = true;
            self._updateConnectedStatus();
            self._resetAudioDataTimer();
        };

        this.audioWs.onerror = function () {
            console.warn('[CarrotSDK] Audio connection failed (no audio stream?)');
        };

        this.audioWs.onclose = function () {
            self._cleanupAudio();
            self._scheduleAudioReconnect();
        };

        this.audioWs.onmessage = function (event) {
            var data = new Uint8Array(event.data);
            self._handleAudioMessage(data);
        };
    };

    CarrotPlayer.prototype._updateConnectedStatus = function () {
        if (this.connected) {
            this.setStatus('\u5df2\u8fde\u63a5\uff0c\u7b49\u5f85\u6d41...', 'connected');
        }
    };

    CarrotPlayer.prototype._cleanup = function () {
        this._cleanupVideo();
        this._cleanupAudio();
        this.connected = false;
    };

    CarrotPlayer.prototype._cleanupVideo = function () {
        if (this.videoReconnectTimer) {
            clearTimeout(this.videoReconnectTimer);
            this.videoReconnectTimer = null;
        }
        if (this._videoDataTimer) {
            clearTimeout(this._videoDataTimer);
            this._videoDataTimer = null;
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
    };

    CarrotPlayer.prototype._cleanupAudio = function () {
        if (this.audioReconnectTimer) {
            clearTimeout(this.audioReconnectTimer);
            this.audioReconnectTimer = null;
        }
        if (this._audioDataTimer) {
            clearTimeout(this._audioDataTimer);
            this._audioDataTimer = null;
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
    };

    CarrotPlayer.prototype._scheduleVideoReconnect = function () {
        var self = this;
        if (this.videoReconnectTimer) return;
        this.setStatus('\u89c6\u9891\u65ad\u5f00\uff0c5 \u79d2\u540e\u91cd\u8fde...', 'error');
        this.videoReconnectTimer = setTimeout(function () {
            self.videoReconnectTimer = null;
            self._cleanupVideo();
            if (self.hasVideo) self._connectVideo();
        }, 5000);
    };

    CarrotPlayer.prototype._scheduleAudioReconnect = function () {
        var self = this;
        if (this.audioReconnectTimer) return;
        this.setStatus('\u97f3\u9891\u65ad\u5f00\uff0c5 \u79d2\u540e\u91cd\u8fde...', 'error');
        this.audioReconnectTimer = setTimeout(function () {
            self.audioReconnectTimer = null;
            self._cleanupAudio();
            if (self.hasAudio) self._connectAudio();
        }, 5000);
    };

    // ---- Data timeout detection ----

    CarrotPlayer.prototype._startDataTimers = function () {
        this._resetVideoDataTimer();
        this._resetAudioDataTimer();
    };

    CarrotPlayer.prototype._resetVideoDataTimer = function () {
        var self = this;
        this.videoDataTime = Date.now();
        if (this._videoDataTimer) {
            clearTimeout(this._videoDataTimer);
        }
        if (!this._dataTimeoutMs || this._dataTimeoutMs <= 0) return;
        this._videoDataTimer = setTimeout(function () {
            self._videoDataTimer = null;
            if (!self.videoWs) return;
            // Check if we've received data within the timeout window
            var elapsed = Date.now() - self.videoDataTime;
            if (elapsed >= self._dataTimeoutMs) {
                self.setStatus('\u89c6\u9891\u6d41\u8d85\u65f6\uff0c\u91cd\u65b0\u8fde\u63a5...', 'error');
                console.warn('[CarrotSDK Player] Video data timeout (' + elapsed + 'ms), reconnecting');
                self._cleanupVideo();
                if (self.hasVideo) self._connectVideo();
            } else {
                // Schedule next check at the remaining time
                self._videoDataTimer = setTimeout(function () {
                    self._videoDataTimer = null;
                    var elapsed2 = Date.now() - self.videoDataTime;
                    if (elapsed2 >= self._dataTimeoutMs) {
                        self.setStatus('\u89c6\u9891\u6d41\u8d85\u65f6\uff0c\u91cd\u65b0\u8fde\u63a5...', 'error');
                        console.warn('[CarrotSDK Player] Video data timeout (' + elapsed2 + 'ms), reconnecting');
                        self._cleanupVideo();
                        if (self.hasVideo) self._connectVideo();
                    }
                }, Math.max(100, self._dataTimeoutMs - elapsed));
            }
        }, this._dataTimeoutMs);
    };

    CarrotPlayer.prototype._resetAudioDataTimer = function () {
        var self = this;
        this.audioDataTime = Date.now();
        if (this._audioDataTimer) {
            clearTimeout(this._audioDataTimer);
        }
        if (!this._dataTimeoutMs || this._dataTimeoutMs <= 0) return;
        this._audioDataTimer = setTimeout(function () {
            self._audioDataTimer = null;
            if (!self.audioWs) return;
            var elapsed = Date.now() - self.audioDataTime;
            if (elapsed >= self._dataTimeoutMs) {
                self.setStatus('\u97f3\u9891\u6d41\u8d85\u65f6\uff0c\u91cd\u65b0\u8fde\u63a5...', 'error');
                console.warn('[CarrotSDK Player] Audio data timeout (' + elapsed + 'ms), reconnecting');
                self._cleanupAudio();
                if (self.hasAudio) self._connectAudio();
            } else {
                self._audioDataTimer = setTimeout(function () {
                    self._audioDataTimer = null;
                    var elapsed2 = Date.now() - self.audioDataTime;
                    if (elapsed2 >= self._dataTimeoutMs) {
                        self.setStatus('\u97f3\u9891\u6d41\u8d85\u65f6\uff0c\u91cd\u65b0\u8fde\u63a5...', 'error');
                        console.warn('[CarrotSDK Player] Audio data timeout (' + elapsed2 + 'ms), reconnecting');
                        self._cleanupAudio();
                        if (self.hasAudio) self._connectAudio();
                    }
                }, Math.max(100, self._dataTimeoutMs - elapsed));
            }
        }, this._dataTimeoutMs);
    };

    // ---- Video message handling ----

    CarrotPlayer.prototype._handleVideoMessage = function (data) {
        if (data.length < 12) return;

        // Reset data timeout on any video data received
        this._resetVideoDataTimer();

        var msgType = readUint32(data, 0);
        var timestamp = readUint32(data, 4);
        var payloadLen = readUint32(data, 8);
        var payload = data.slice(12, 12 + payloadLen);

        if (this.frameCount === 0 && this.decodedCount === 0) {
            console.log('[CarrotSDK Player] Video msg: type=' + msgType + ' ts=' + timestamp + ' payloadLen=' + payloadLen + ' dataLen=' + data.length);
        }

        switch (msgType) {
            case 0: // MsgTypeCodecConfig
                console.log('[CarrotSDK Player] Received codec config, payloadLen=' + payloadLen + ' decoder=' + (this.videoDecoder ? 'exists' : 'null'));
                this._handleVideoCodecConfig(payload);
                break;
            case 1: // MsgTypeVideoFrame
                if (this.videoDecoder) {
                    this._decodeVideoFrame(payload, timestamp);
                } else {
                    if (this.droppedCount < 10 || this.droppedCount % 50 === 0) {
                        console.warn('[CarrotSDK Player] Frame dropped: no decoder (dropped=' + this.droppedCount + ')');
                    }
                    this.droppedCount++;
                }
                break;
        }
    };

    CarrotPlayer.prototype._handleVideoCodecConfig = function (payload) {
        var offset = 0;
        var codec = payload[offset++];
        console.log('[CarrotSDK Player] _handleVideoCodecConfig: codec=' + codec + ' payloadLen=' + payload.length);
        if (codec !== 0) {
            this.setStatus('\u4e0d\u652f\u6301\u7684\u89c6\u9891\u7f16\u7801: ' + codec, 'error');
            return;
        }

        var spsLen = readUint32(payload, offset);
        offset += 4;
        if (offset + spsLen > payload.length) {
            console.error('[CarrotSDK Player] SPS length exceeds payload: spsLen=' + spsLen + ' payloadLen=' + payload.length);
            return;
        }
        var sps = payload.slice(offset, offset + spsLen);
        offset += spsLen;

        var ppsLen = readUint32(payload, offset);
        offset += 4;
        if (offset + ppsLen > payload.length) {
            console.error('[CarrotSDK Player] PPS length exceeds payload: ppsLen=' + ppsLen + ' payloadLen=' + payload.length);
            return;
        }
        var pps = payload.slice(offset, offset + ppsLen);

        var codecStr = this._getCodecString(sps);
        console.log('[CarrotSDK Player] Video config: codec=' + codecStr + ' sps=' + spsLen + ' pps=' + ppsLen + ' sps[0]=0x' + (sps[0] || 0).toString(16) + ' sps[1]=0x' + (sps[1] || 0).toString(16));
        this.setStatus('\u89c6\u9891\u89e3\u7801\u5668: ' + codecStr, 'connected');
        this._initVideoDecoder(codecStr, sps, pps);

        if (this.placeholderEl) this.placeholderEl.style.display = 'none';
    };

    CarrotPlayer.prototype._getCodecString = function (sps) {
        if (!sps || sps.length < 4) return 'avc1.42001e';
        var profile = sps[1];
        var compat = sps[2];
        var level = sps[3];
        return 'avc1.' +
            (profile.toString(16).padStart(2, '0')) +
            (compat.toString(16).padStart(2, '0')) +
            (level.toString(16).padStart(2, '0'));
    };

    CarrotPlayer.prototype._initVideoDecoder = function (codecStr, sps, pps) {
        var self = this;
        if (typeof VideoDecoder === 'undefined') {
            this.setStatus('\u6d4f\u89c8\u5668\u4e0d\u652f\u6301 WebCodecs VideoDecoder\uff0c\u8bf7\u4f7f\u7528 Chrome/Edge', 'error');
            return;
        }
        if (this.videoDecoder) {
            this.videoDecoder.close();
        }

        this.videoDecoder = new VideoDecoder({
            output: function (frame) { self._onVideoFrame(frame); },
            error: function (e) {
                self.setStatus('\u89c6\u9891\u89e3\u7801\u9519\u8bef: ' + e.message, 'error');
                console.error('[CarrotSDK] Video decoder error:', e);
            }
        });

        var spsLen = sps.length;
        var ppsLen = pps.length;
        var extradata = new Uint8Array(6 + 2 + spsLen + 1 + 2 + ppsLen);
        var off = 0;
        extradata[off++] = 0x01;
        extradata[off++] = sps[1];
        extradata[off++] = sps[2];
        extradata[off++] = sps[3];
        extradata[off++] = 0xFF;
        extradata[off++] = 0xE1;
        extradata[off++] = (spsLen >> 8) & 0xFF;
        extradata[off++] = spsLen & 0xFF;
        extradata.set(sps, off);
        off += spsLen;
        extradata[off++] = 0x01;
        extradata[off++] = (ppsLen >> 8) & 0xFF;
        extradata[off++] = ppsLen & 0xFF;
        extradata.set(pps, off);

        try {
            this.videoDecoder.configure({
                codec: codecStr,
                description: extradata,
                optimizeForLatency: true
            });
            this.videoNeedsKeyframe = true;
        } catch (e) {
            this.setStatus('\u89c6\u9891\u89e3\u7801\u5668\u914d\u7f6e\u5931\u8d25: ' + e.message, 'error');
        }
    };

    CarrotPlayer.prototype._decodeVideoFrame = function (data, timestamp) {
        if (!this.videoDecoder || this.videoDecoder.state !== 'configured') {
            console.warn('[CarrotSDK Player] Skip decode: decoder=' + (!!this.videoDecoder) + ' state=' + (this.videoDecoder ? this.videoDecoder.state : 'N/A'));
            return;
        }

        var frameType = data[0];
        var frameData = data.slice(1);
        var type = frameType === 0 ? 'key' : 'delta';

        if (this.videoNeedsKeyframe) {
            if (type !== 'key') {
                this.droppedCount++;
                return;
            }
            console.log('[CarrotSDK Player] Got first keyframe, starting decode');
            this.videoNeedsKeyframe = false;
        }

        var chunk = new EncodedVideoChunk({
            type: type,
            timestamp: timestamp * 1000,
            duration: 33000,
            data: frameData
        });

        try {
            this.videoDecoder.decode(chunk);
            this.frameCount++;
            if (this.frameCount <= 3 || this.frameCount % 50 === 0) {
                console.log('[CarrotSDK Player] Decode frame #' + this.frameCount + ' type=' + type + ' ts=' + timestamp + ' dataSize=' + frameData.length);
            }
        } catch (e) {
            console.error('[CarrotSDK Player] Video decode error:', e, 'type=' + type + ' ts=' + timestamp + ' size=' + frameData.length + ' frameType=' + frameType);
            this.droppedCount++;
        }
    };

    CarrotPlayer.prototype._onVideoFrame = function (frame) {
        this.decodedCount++;

        if (this.canvas &&
            (this.canvas.width !== frame.displayWidth ||
                this.canvas.height !== frame.displayHeight)) {
            this.canvas.width = frame.displayWidth;
            this.canvas.height = frame.displayHeight;
            console.log('[CarrotSDK Player] Canvas resize: ' + frame.displayWidth + 'x' + frame.displayHeight);
        }

        if (this.ctx) {
            this.ctx.drawImage(frame, 0, 0);
            if (this.decodedCount <= 3 || this.decodedCount % 50 === 0) {
                console.log('[CarrotSDK Player] Rendered frame #' + this.decodedCount + ' ' + frame.displayWidth + 'x' + frame.displayHeight);
            }
        } else {
            console.warn('[CarrotSDK Player] No canvas context to render frame');
        }

        if (this._onFrame) this._onFrame(frame);

        frame.close();
        this.lastFrameTime = performance.now();
        this._updateStats();
    };

    // ---- Audio message handling ----

    CarrotPlayer.prototype._handleAudioMessage = function (data) {
        if (data.length < 12) return;

        // Reset data timeout on any audio data received
        this._resetAudioDataTimer();

        var msgType = readUint32(data, 0);
        var timestamp = readUint32(data, 4);
        var payloadLen = readUint32(data, 8);
        var payload = data.slice(12, 12 + payloadLen);

        switch (msgType) {
            case 2: // MsgTypeAudioConfig
                this._handleAudioCodecConfig(payload);
                break;
            case 3: // MsgTypeAudioFrame
                if (this.audioDecoder) {
                    this._decodeAudioFrame(payload, timestamp);
                }
                break;
        }
    };

    CarrotPlayer.prototype._handleAudioCodecConfig = function (payload) {
        var offset = 0;
        var codecType = payload[offset++]; // 0=AAC, 1=MP3
        var sampleRate = readUint32(payload, offset);
        offset += 4;
        var channels = payload[offset++];
        var configData = payload.slice(offset);

        var audioObjectType = configData.length > 0
            ? (configData[0] >> 3) & 0x1F
            : 2;
        this.audioAOT = audioObjectType;

        this.audioConfig = { codecType: codecType, sampleRate: sampleRate, channels: channels, configData: configData };
        console.log('[CarrotSDK] Audio config:',
            'codecType=' + codecType,
            'AOT=' + audioObjectType,
            'sampleRate=' + sampleRate,
            'channels=' + channels);
        this._initAudio();
        this._initAudioDecoder();
    };

    CarrotPlayer.prototype._initAudio = function () {
        if (this.audioCtx) return;
        try {
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: this.audioConfig.sampleRate,
            });
            this.nextAudioTime = this.audioCtx.currentTime;
            console.log('[CarrotSDK] AudioContext initialized:', this.audioCtx.sampleRate, 'Hz');
        } catch (e) {
            console.error('[CarrotSDK] Failed to create AudioContext:', e);
        }
    };

    CarrotPlayer.prototype._initAudioDecoder = function () {
        var self = this;
        if (typeof AudioDecoder === 'undefined') {
            console.warn('[CarrotSDK] WebCodecs AudioDecoder not supported');
            return;
        }

        if (this.audioDecoder) {
            this.audioDecoder.close();
            this.audioDecoder = null;
        }

        var config = this._buildAudioDecoderConfig();
        if (!config) {
            console.warn('[CarrotSDK] Unsupported audio codec:', this.audioConfig.codecType);
            return;
        }

        this.audioDecoder = new AudioDecoder({
            output: function (audioData) { self._onAudioFrame(audioData); },
            error: function (e) {
                console.error('[CarrotSDK] Audio decoder error:', e);
            }
        });

        try {
            this.audioDecoder.configure(config);
            console.log('[CarrotSDK] Audio decoder configured:', JSON.stringify(config));
        } catch (e) {
            console.error('[CarrotSDK] Audio decoder config failed:', e);
        }
    };

    CarrotPlayer.prototype._buildAudioDecoderConfig = function () {
        var cfg = this.audioConfig;
        if (!cfg) return null;

        switch (cfg.codecType) {
            case 0: { // AAC
                var aot = this.audioAOT || 2;
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
    };

    CarrotPlayer.prototype._decodeAudioFrame = function (data, timestamp) {
        if (!this.audioDecoder || this.audioDecoder.state !== 'configured') return;
        if (!this.audioCtx) return;

        if (this.audioCtx.state === 'suspended') {
            this.audioCtx.resume().catch(function (e) { console.warn('[CarrotSDK] AudioContext resume failed:', e); });
        }

        var chunk = new EncodedAudioChunk({
            type: 'key',
            timestamp: timestamp * 1000,
            duration: (1024 / this.audioConfig.sampleRate) * 1000000,
            data: data
        });

        try {
            this.audioDecoder.decode(chunk);
        } catch (e) {
            console.error('[CarrotSDK] Audio decode error:', e);
        }
    };

    CarrotPlayer.prototype._onAudioFrame = function (audioData) {
        this.audioDecodedFrames++;
        if (!this.audioCtx) {
            audioData.close();
            return;
        }
        this._scheduleAudioFrame(audioData);
    };

    CarrotPlayer.prototype._scheduleAudioFrame = function (audioData) {
        var ctx = this.audioCtx;
        var duration = audioData.duration;
        if (!duration || duration <= 0) {
            audioData.close();
            return;
        }

        var numberOfChannels = audioData.numberOfChannels;
        var sampleRate = audioData.sampleRate;
        var frameCount = audioData.numberOfFrames;

        var audioBuffer = ctx.createBuffer(numberOfChannels, frameCount, sampleRate);
        for (var ch = 0; ch < numberOfChannels; ch++) {
            var channelData = audioBuffer.getChannelData(ch);
            audioData.copyTo(channelData, { planeIndex: ch, format: 'f32-planar' });
        }
        audioData.close();

        var source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ctx.destination);

        var now = ctx.currentTime;
        var targetAhead = 0.5;
        var maxAhead = 1.0;

        if (this.nextAudioTime < now) {
            this.nextAudioTime = now + targetAhead;
        } else if (this.nextAudioTime - now > maxAhead) {
            this.nextAudioTime = now + targetAhead;
        }

        source.start(this.nextAudioTime);
        this.nextAudioTime += duration / 1000000;
    };

    // ---- Stats ----

    CarrotPlayer.prototype._updateStats = function () {
        var now = performance.now();
        this.fpsCounter++;
        if (now - this.fpsLastCheck >= 1000) {
            this.fps = this.fpsCounter;
            this.fpsCounter = 0;
            this.fpsLastCheck = now;
        }

        var latency = this.lastFrameTime > 0
            ? ' ' + (now - this.lastFrameTime).toFixed(0) + 'ms'
            : '';

        var audioInfo = this.audioConfig
            ? ' | \u97f3\u9891:' + this.audioDecodedFrames + '\u5e27'
            : '';

        var msg = this.fps + ' FPS | \u5e27:' + this.frameCount +
            ' \u89e3\u7801:' + this.decodedCount +
            ' \u4e22\u5f03:' + this.droppedCount +
            latency + audioInfo;

        this.setStatus(msg, this.connected ? 'connected' : '');

        if (this._onStats) {
            this._onStats({
                fps: this.fps,
                frameCount: this.frameCount,
                decodedCount: this.decodedCount,
                droppedCount: this.droppedCount,
                latency: this.lastFrameTime > 0 ? (now - this.lastFrameTime) : 0,
                audioDecodedFrames: this.audioDecodedFrames
            });
        }

        if (this.fps > 0) {
            document.title = this.fps + 'FPS - Carrot Streaming';
        }
    };


    // ========================================================================
    //  CarrotSDK.Pusher
    //  Wraps WebCodecs-based H.264 video + AAC audio push via WebSocket.
    // ========================================================================

    // ---- PushChannel (internal) ----

    function PushChannel(type, config) {
        this.type = type;
        this.enabled = false;
        this.pushing = false;
        this.streamUrl = '';
        this.ws = null;
        this.mediaStream = null;
        this.encoder = null;
        this.frameCount = 0;
        this.bytesSent = 0;

        this.audioCtx = null;
        this.processor = null;
        this.configSent = false;
        this.timestamp = 0;

        // DOM refs (optional, set via MediaPusher or directly)
        this.el = {};

        this.config = config;

        // Server connection config
        this._host = config.host || window.location.hostname;
        this._port = config.port || 7778;

        // Callbacks
        this._onStatus = null;
        this._onStats = null;
    }

    PushChannel.prototype.setStatus = function (msg) {
        if (this.el.status) {
            this.el.status.textContent = msg;
        }
        if (this._onStatus) this._onStatus(this.type, msg);
        console.log('[CarrotSDK ' + this.type + '] ' + msg);
    };

    PushChannel.prototype._emitStats = function () {
        if (!this._onStats) return;
        this._onStats({
            type: this.type,
            frameCount: this.frameCount,
            bytesSent: this.bytesSent,
            pushing: this.pushing
        });
    };

    PushChannel.prototype.start = function (streamUrl) {
        var self = this;
        if (this.pushing) return;

        this.streamUrl = streamUrl || (this.el.streamUrl ? this.el.streamUrl.value.trim() : '');
        if (!this.streamUrl) {
            this.setStatus('\u8bf7\u8f93\u5165\u6d41\u8def\u5f84');
            return;
        }

        this.setStatus('\u8bf7\u6c42\u8bbe\u5907\u6743\u9650...');

        var constr = this.config.constraints;

        // Build constraints dynamically based on what we need
        var getUserMediaConstraints = {};

        if (this.type === 'video') {
            getUserMediaConstraints.video = constr.video;
            getUserMediaConstraints.audio = false;
        } else {
            getUserMediaConstraints.audio = constr.audio;
            getUserMediaConstraints.video = false;
        }

        navigator.mediaDevices.getUserMedia(getUserMediaConstraints)
            .then(function (stream) {
                self.mediaStream = stream;

                // Show preview for video
                if (self.type === 'video' && self.el.preview) {
                    self.el.preview.srcObject = stream;
                    self.el.preview.style.display = 'block';
                }

                // Connect WebSocket
                var wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
                var paramName = self.type === 'video' ? 'videoUrl' : 'audioUrl';
                var wsUrl = wsProto + '://' + self._host + ':' + self._port + '/ws?' + paramName + '=' + encodeURIComponent(self.streamUrl);

                self.setStatus('\u6b63\u5728\u8fde\u63a5...');

                var ws = new WebSocket(wsUrl);
                ws.binaryType = 'arraybuffer';
                ws.onopen = function () {
                    self.ws = ws;
                    self.pushing = true;
                    self.frameCount = 0;
                    self.bytesSent = 0;
                    self.configSent = false;
                    self.timestamp = 0;

                    if (self.el.btnStart) { self.el.btnStart.disabled = true; }
                    if (self.el.btnStop) { self.el.btnStop.disabled = false; }
                    if (self.el.streamUrl) { self.el.streamUrl.disabled = true; }

                    if (self.type === 'audio') {
                        self._startAudioEncoding();
                    } else {
                        self._startVideoEncoding();
                    }
                };
                ws.onerror = function () {
                    self.setStatus('\u8fde\u63a5\u63a8\u9001\u670d\u52a1\u5668\u5931\u8d25');
                    self._cleanupMedia();
                };
                ws.onclose = function (evt) {
                    console.log('[CarrotSDK ' + self.type + '] WS closed:', evt.code, evt.reason);
                    if (self.pushing) {
                        self.setStatus('\u8fde\u63a5\u65ad\u5f00 (code=' + evt.code + ')');
                        self.stop();
                    }
                };
            })
            .catch(function (e) {
                self.setStatus('\u8bbe\u5907\u6743\u9650\u88ab\u62d2\u7edd: ' + e.message);
            });
    };

    PushChannel.prototype.stop = function () {
        this.pushing = false;
        this._stopEncoding();

        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this._cleanupMedia();

        if (this.el.btnStart) { this.el.btnStart.disabled = false; }
        if (this.el.btnStop) { this.el.btnStop.disabled = true; }
        if (this.el.streamUrl) { this.el.streamUrl.disabled = false; }

        this.setStatus('\u5df2\u505c\u6b62');
        if (this.el.stats) this.el.stats.textContent = '';
        this._emitStats();
    };

    PushChannel.prototype._cleanupMedia = function () {
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(function (t) { t.stop(); });
            this.mediaStream = null;
        }
        if (this.type === 'video' && this.el.preview) {
            this.el.preview.srcObject = null;
            this.el.preview.style.display = 'none';
        }
    };

    PushChannel.prototype._stopEncoding = function () {
        if (this.processor) { this.processor.disconnect(); this.processor = null; }
        if (this.encoder) { this.encoder.close(); this.encoder = null; }
        if (this.audioCtx) { this.audioCtx.close(); this.audioCtx = null; }
    };

    // ---- Audio Encoding ----

    PushChannel.prototype._startAudioEncoding = function () {
        var self = this;
        if (typeof AudioEncoder === 'undefined') {
            this.setStatus('\u6d4f\u89c8\u5668\u4e0d\u652f\u6301 AudioEncoder');
            this.stop();
            return;
        }

        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
        var source = this.audioCtx.createMediaStreamSource(this.mediaStream);

        this.encoder = new AudioEncoder({
            output: function (chunk) { self._onAudioEncoded(chunk); },
            error: function (e) {
                console.error('[CarrotSDK Audio] Encoder error:', e);
                self.setStatus('\u7f16\u7801\u5668\u9519\u8bef: ' + e.message);
            }
        });
        this.encoder.configure({
            codec: 'mp4a.40.2',
            sampleRate: 44100,
            numberOfChannels: 1,
            bitrate: 128000
        });

        var frameSize = 1024;
        this.processor = this.audioCtx.createScriptProcessor(frameSize, 1, 1);
        source.connect(this.processor);
        this.processor.connect(this.audioCtx.destination);

        this.timestamp = 0;
        this.processor.onaudioprocess = function (event) {
            if (!self.pushing || !self.encoder || self.encoder.state !== 'configured') return;
            var input = event.inputBuffer;
            var pcmData = input.getChannelData(0);
            var audioData = new AudioData({
                format: 'f32-planar',
                sampleRate: input.sampleRate,
                numberOfFrames: input.length,
                numberOfChannels: 1,
                timestamp: self.timestamp,
                data: pcmData
            });
            self.timestamp += input.length * 1000000 / input.sampleRate;
            try { self.encoder.encode(audioData); } catch (e) {
                console.error('[CarrotSDK Audio] encode error:', e);
            }
            audioData.close();
        };

        this.setStatus('\u6b63\u5728\u63a8\u9001\u97f3\u9891...');
    };

    PushChannel.prototype._onAudioEncoded = function (chunk) {
        if (!this.pushing || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        var buffer = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buffer);
        this.ws.send(buffer);
        this.frameCount++;
        this.bytesSent += buffer.length;
        this._emitStats();
    };

    // ---- Video Encoding ----

    PushChannel.prototype._startVideoEncoding = function () {
        var self = this;
        if (typeof VideoEncoder === 'undefined') {
            this.setStatus('\u6d4f\u89c8\u5668\u4e0d\u652f\u6301 VideoEncoder');
            this.stop();
            return;
        }
        if (typeof MediaStreamTrackProcessor === 'undefined') {
            this.setStatus('\u6d4f\u89c8\u5668\u4e0d\u652f\u6301 MediaStreamTrackProcessor');
            this.stop();
            return;
        }

        var track = this.mediaStream.getVideoTracks()[0];
        if (!track) {
            this.setStatus('\u672a\u68c0\u6d4b\u5230\u6444\u50cf\u5934');
            this.stop();
            return;
        }
        var settings = track.getSettings();
        var width = settings.width || 640;
        var height = settings.height || 480;
        console.log('[CarrotSDK Video] Track: ' + width + 'x' + height);

        this.encoder = new VideoEncoder({
            output: function (chunk, metadata) { self._onVideoEncoded(chunk, metadata, width, height); },
            error: function (e) {
                console.error('[CarrotSDK Video] Encoder error:', e);
                self.setStatus('\u7f16\u7801\u5668\u9519\u8bef: ' + e.message);
            }
        });
        this.encoder.configure({
            codec: 'avc1.42001e',
            width: width,
            height: height,
            bitrate: 1000000,
            framerate: 24,
            avc: { format: 'avc' }
        });

        // Force keyframes every ~2 seconds (48 frames at 24fps)
        // so that late-joining subscribers can start decoding without waiting.
        this.frameEncodeCount = 0;
        this._firstFrameEncoded = false;
        var KEYFRAME_INTERVAL = 48;

        var trackProcessor = new MediaStreamTrackProcessor({ track: track });
        var reader = trackProcessor.readable.getReader();

        var readFrame = function () {
            reader.read().then(function (result) {
                if (result.done || !self.pushing) return;
                if (result.value) {
                    if (self.encoder.state === 'configured') {
                        try {
                            self.frameEncodeCount++;
                            var encodeOpts = {};
                            // Force first frame and every KEYFRAME_INTERVAL-th frame as keyframe
                            if (!self._firstFrameEncoded || self.frameEncodeCount >= KEYFRAME_INTERVAL) {
                                encodeOpts.keyFrame = true;
                                self.frameEncodeCount = 0;
                                if (!self._firstFrameEncoded) {
                                    self._firstFrameEncoded = true;
                                    console.log('[CarrotSDK Video] First frame, forcing keyframe');
                                } else {
                                    console.log('[CarrotSDK Video] Forcing keyframe #' + (self.frameCount + 1));
                                }
                            }
                            self.encoder.encode(result.value, encodeOpts);
                        } catch (e) {
                            console.error('[CarrotSDK Video] encode error:', e);
                        }
                    }
                    result.value.close();
                    self.timestamp += 1000000 / 24;
                }
                readFrame();
            }).catch(function (err) {
                console.error('[CarrotSDK Video] reader error:', err);
                if (self.pushing) readFrame();
            });
        };
        readFrame();

        this.setStatus('\u6b63\u5728\u63a8\u9001\u89c6\u9891...');
    };

    PushChannel.prototype._onVideoEncoded = function (chunk, metadata, width, height) {
        var self = this;
        if (!this.pushing || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        var isKeyFrame = chunk.type === 'key';
        var chunkSize = chunk.byteLength;

        console.log('[CarrotSDK Video] _onVideoEncoded: key=' + isKeyFrame + ' size=' + chunkSize + ' configSent=' + this.configSent + ' pushing=' + this.pushing);

        if (!this.configSent && isKeyFrame) {
            console.log('[CarrotSDK Video] Attempting to extract config... metadata=', !!metadata);
            if (metadata) {
                console.log('[CarrotSDK Video] metadata keys:', Object.keys(metadata));
                if (metadata.decoderConfig) {
                    console.log('[CarrotSDK Video] decoderConfig exists, has description=', !!metadata.decoderConfig.description);
                    if (metadata.decoderConfig.description) {
                        var desc = metadata.decoderConfig.description;
                        console.log('[CarrotSDK Video] description type:', desc.constructor.name, 'length:', desc.byteLength || desc.length, 'firstByte:', desc[0] !== undefined ? '0x' + desc[0].toString(16) : 'N/A');
                    }
                } else {
                    console.log('[CarrotSDK Video] metadata has no decoderConfig');
                }
            }

            var config = null;
            var decoderConfig = metadata && (metadata.decoderConfig || metadata);
            if (decoderConfig && decoderConfig.description) {
                config = this._buildConfigFromDescription(decoderConfig.description, width, height);
                console.log('[CarrotSDK Video] _buildConfigFromDescription result:', config ? 'OK (' + config.length + ' bytes)' : 'NULL');
            } else {
                console.log('[CarrotSDK Video] decoderConfig.description not available, will try _extractAVCConfig');
            }
            if (!config) {
                config = this._extractAVCConfig(chunk, width, height);
                console.log('[CarrotSDK Video] _extractAVCConfig result:', config ? 'OK (' + config.length + ' bytes)' : 'NULL');
            }
            if (config) {
                this.ws.send(config);
                this.configSent = true;
                console.log('[CarrotSDK Video] Config sent: ' + width + 'x' + height + ' configBytes=' + config.length);
            } else {
                console.warn('[CarrotSDK Video] Failed to extract config, waiting for next keyframe');
            }
        }

        if (!this.configSent) {
            console.log('[CarrotSDK Video] Dropping frame: config not sent yet, key=' + isKeyFrame + ' size=' + chunkSize);
            return;
        }

        var rawData = new Uint8Array(chunk.byteLength);
        chunk.copyTo(rawData);

        var msgLen = 5 + rawData.length;
        var msg = new Uint8Array(msgLen);
        var view = new DataView(msg.buffer);
        view.setUint32(0, this.timestamp / 1000, false);
        msg[4] = isKeyFrame ? 1 : 0;
        msg.set(rawData, 5);

        this.ws.send(msg);
        this.frameCount++;
        this.bytesSent += msgLen;
        if (this.frameCount <= 3 || this.frameCount % 50 === 0) {
            console.log('[CarrotSDK Video] Frame sent #' + this.frameCount + ' key=' + isKeyFrame + ' size=' + msgLen + ' ts=' + (this.timestamp / 1000).toFixed(0));
        }
        this._emitStats();
    };

    PushChannel.prototype._buildConfigFromDescription = function (description, width, height) {
        var desc;
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

        var offset = 5;
        var numSPS = desc[offset] & 0x1F;
        offset += 1;
        if (numSPS === 0) return null;

        var spsLen = (desc[offset] << 8) | desc[offset + 1];
        offset += 2;
        if (offset + spsLen > desc.length) return null;
        var sps = desc.slice(offset, offset + spsLen);
        offset += spsLen;

        var numPPS = desc[offset];
        offset += 1;
        if (numPPS === 0 || offset + 2 > desc.length) return null;
        var ppsLen = (desc[offset] << 8) | desc[offset + 1];
        offset += 2;
        if (offset + ppsLen > desc.length) return null;
        var pps = desc.slice(offset, offset + ppsLen);

        return this._buildConfigMsg(sps, pps, width, height);
    };

    PushChannel.prototype._extractAVCConfig = function (chunk, width, height) {
        var rawData = new Uint8Array(chunk.byteLength);
        chunk.copyTo(rawData);

        // Try AVCC format first (4-byte NALU length prefix)
        var sps = null;
        var pps = null;

        if (rawData.length >= 4) {
            // Check if first 4 bytes look like a reasonable NALU length (< 1MB)
            var firstLen = (rawData[0] << 24) | (rawData[1] << 16) | (rawData[2] << 8) | rawData[3];
            if (firstLen > 0 && firstLen < 1024 * 1024 && firstLen < rawData.length - 4) {
                sps = null; pps = null;
                var offset = 0;
                while (offset + 4 <= rawData.length) {
                    var naluLen = (rawData[offset] << 24) | (rawData[offset + 1] << 16) |
                        (rawData[offset + 2] << 8) | rawData[offset + 3];
                    offset += 4;
                    if (offset + naluLen > rawData.length) break;
                    var naluType = rawData[offset] & 0x1F;
                    if (naluType === 7) sps = rawData.slice(offset, offset + naluLen);
                    else if (naluType === 8) pps = rawData.slice(offset, offset + naluLen);
                    offset += naluLen;
                    // If we have both SPS and PPS, we can stop early
                    if (sps && pps) break;
                }
            }
        }

        // If AVCC parsing failed, try Annex B format (0x00000001 or 0x000001 start codes)
        if (!sps || !pps) {
            console.log('[CarrotSDK Video] AVCC parse failed, trying Annex B');
            sps = null; pps = null;
            var offset = 0;
            while (offset + 4 <= rawData.length) {
                // Look for Annex B start code: 0x00000001 or 0x000001
                var startCodeLen = 0;
                if (rawData[offset] === 0 && rawData[offset + 1] === 0) {
                    if (rawData[offset + 2] === 0 && rawData[offset + 3] === 1) {
                        startCodeLen = 4;
                    } else if (rawData[offset + 2] === 1) {
                        startCodeLen = 3;
                    }
                }
                if (startCodeLen === 0) {
                    offset++;
                    continue;
                }
                // Find the next start code to determine NALU length
                var naluStart = offset + startCodeLen;
                var nextOffset = naluStart;
                while (nextOffset + 3 < rawData.length) {
                    if (rawData[nextOffset] === 0 && rawData[nextOffset + 1] === 0 &&
                        (rawData[nextOffset + 2] === 1 || (nextOffset + 3 < rawData.length && rawData[nextOffset + 2] === 0 && rawData[nextOffset + 3] === 1))) {
                        break;
                    }
                    nextOffset++;
                }
                var naluLen = nextOffset - naluStart;
                if (naluLen <= 0) {
                    offset = nextOffset;
                    continue;
                }
                var naluType = rawData[naluStart] & 0x1F;
                if (naluType === 7) sps = rawData.slice(naluStart, naluStart + naluLen);
                else if (naluType === 8) pps = rawData.slice(naluStart, naluStart + naluLen);
                offset = nextOffset;
                if (sps && pps) break;
            }
        }

        if (!sps || !pps) {
            console.warn('[CarrotSDK Video] _extractAVCConfig: no SPS/PPS found, rawData[0-7]:', Array.from(rawData.slice(0, Math.min(8, rawData.length))).map(function (b) { return '0x' + b.toString(16); }).join(' '));
            return null;
        }
        console.log('[CarrotSDK Video] _extractAVCConfig: SPS=' + sps.length + ' PPS=' + pps.length);
        return this._buildConfigMsg(sps, pps, width, height);
    };

    PushChannel.prototype._buildConfigMsg = function (sps, pps, width, height) {
        var configLen = 4 + sps.length + 4 + pps.length + 4 + 4;
        var config = new Uint8Array(configLen);
        var view = new DataView(config.buffer);
        var pos = 0;
        view.setUint32(pos, sps.length, false); pos += 4;
        config.set(sps, pos); pos += sps.length;
        view.setUint32(pos, pps.length, false); pos += 4;
        config.set(pps, pos); pos += pps.length;
        view.setUint32(pos, width, false); pos += 4;
        view.setUint32(pos, height, false); pos += 4;
        return config;
    };

    // ---- CarrotPusher (public API) ----

    /**
     * @param {Object} [options]
     * @param {Object} [options.audio]
     * @param {string} [options.audio.streamUrl]  - Audio stream path
     * @param {Object} [options.audio.constraints] - getUserMedia constraints for audio
     * @param {Object} [options.video]
     * @param {string} [options.video.streamUrl]  - Video stream path
     * @param {Object} [options.video.constraints] - getUserMedia constraints for video
     * @param {HTMLElement|string} [options.video.preview] - <video> element or id for preview
     * @param {function(string, string):void} [options.onStatus] - callback(type, msg)
     * @param {function(Object):void} [options.onStats]           - callback(statsObj)
     */
    function CarrotPusher(options) {
        options = options || {};

        // Global server config (can be overridden per channel)
        var globalHost = options.host || window.location.hostname;
        var globalPort = options.port || 7778;

        var audioOpts = options.audio || {};
        var videoOpts = options.video || {};

        this.audio = new PushChannel('audio', {
            host: audioOpts.host || globalHost,
            port: audioOpts.port || globalPort,
            constraints: audioOpts.constraints || {
                audio: { sampleRate: 44100, channelCount: 1, echoCancellation: true, noiseSuppression: true },
                video: false
            }
        });
        this.video = new PushChannel('video', {
            host: videoOpts.host || globalHost,
            port: videoOpts.port || globalPort,
            constraints: videoOpts.constraints || {
                audio: false,
                video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } }
            }
        });

        // Wire DOM elements (optional)
        this.audio.el = {
            enabled: resolveEl(audioOpts.enabledEl) || document.getElementById('enableAudio'),
            streamUrl: resolveEl(audioOpts.streamUrlEl) || document.getElementById('audioStreamUrl'),
            btnStart: resolveEl(audioOpts.btnStartEl) || document.getElementById('btnAudioStart'),
            btnStop: resolveEl(audioOpts.btnStopEl) || document.getElementById('btnAudioStop'),
            status: resolveEl(audioOpts.statusEl) || document.getElementById('audioStatus'),
            stats: resolveEl(audioOpts.statsEl) || document.getElementById('audioStats'),
        };
        this.video.el = {
            enabled: resolveEl(videoOpts.enabledEl) || document.getElementById('enableVideo'),
            streamUrl: resolveEl(videoOpts.streamUrlEl) || document.getElementById('videoStreamUrl'),
            btnStart: resolveEl(videoOpts.btnStartEl) || document.getElementById('btnVideoStart'),
            btnStop: resolveEl(videoOpts.btnStopEl) || document.getElementById('btnVideoStop'),
            status: resolveEl(videoOpts.statusEl) || document.getElementById('videoStatus'),
            stats: resolveEl(videoOpts.statsEl) || document.getElementById('videoStats'),
            preview: resolveEl(videoOpts.previewEl || videoOpts.preview) || document.getElementById('preview'),
        };

        // Bind DOM events if elements exist
        if (this.audio.el.btnStart) {
            var self = this;
            this.audio.el.btnStart.addEventListener('click', function () {
                self.startAudio(self.audio.el.streamUrl ? self.audio.el.streamUrl.value.trim() : '');
            });
        }
        if (this.audio.el.btnStop) {
            this.audio.el.btnStop.addEventListener('click', this.stopAudio.bind(this));
        }
        if (this.video.el.btnStart) {
            this.video.el.btnStart.addEventListener('click', function () {
                self.startVideo(self.video.el.streamUrl ? self.video.el.streamUrl.value.trim() : '');
            });
        }
        if (this.video.el.btnStop) {
            this.video.el.btnStop.addEventListener('click', this.stopVideo.bind(this));
        }

        // Wire callbacks
        this._onStatus = options.onStatus || null;
        this._onStats = options.onStats || null;
        this.audio._onStatus = this._onStatus;
        this.audio._onStats = this._onStats;
        this.video._onStatus = this._onStatus;
        this.video._onStats = this._onStats;

        console.log('[CarrotSDK Pusher] Ready');
    }

    /**
     * Start audio push.
     * @param {string} [streamUrl] - Stream path (e.g. 'audio/browser')
     */
    CarrotPusher.prototype.startAudio = function (streamUrl) {
        if (streamUrl) this.audio.streamUrl = streamUrl;
        this.audio.start(streamUrl);
    };

    /** Stop audio push */
    CarrotPusher.prototype.stopAudio = function () {
        this.audio.stop();
    };

    /**
     * Start video push.
     * @param {string} [streamUrl] - Stream path (e.g. 'video/browser')
     */
    CarrotPusher.prototype.startVideo = function (streamUrl) {
        if (streamUrl) this.video.streamUrl = streamUrl;
        this.video.start(streamUrl);
    };

    /** Stop video push */
    CarrotPusher.prototype.stopVideo = function () {
        this.video.stop();
    };

    /** Stop both audio and video */
    CarrotPusher.prototype.stopAll = function () {
        this.audio.stop();
        this.video.stop();
    };

    /**
     * Get current stats for both audio and video.
     * @returns {Object} { audio: { frameCount, bytesSent, pushing }, video: { ... } }
     */
    CarrotPusher.prototype.getStats = function () {
        return {
            audio: {
                pushing: this.audio.pushing,
                frameCount: this.audio.frameCount,
                bytesSent: this.audio.bytesSent,
                streamUrl: this.audio.streamUrl
            },
            video: {
                pushing: this.video.pushing,
                frameCount: this.video.frameCount,
                bytesSent: this.video.bytesSent,
                streamUrl: this.video.streamUrl
            }
        };
    };


    // ========================================================================
    //  Export
    // ========================================================================

    var CarrotSDK = {
        version: VERSION,
        Player: CarrotPlayer,
        Pusher: CarrotPusher
    };

    // Legacy aliases for backward compatibility
    if (typeof StreamPlayer === 'undefined') {
        window.StreamPlayer = CarrotPlayer;
    }
    if (typeof MediaPusher === 'undefined') {
        window.MediaPusher = CarrotPusher;
    }
    if (typeof PushChannel === 'undefined') {
        window.PushChannel = PushChannel;
    }

    // Export
    window.CarrotSDK = CarrotSDK;

    console.log('[CarrotSDK] v' + VERSION + ' loaded');

    // ========================================================================
    //  Auto-initialization on DOMContentLoaded (backward compatibility)
    //  Creates window.player and/or window.pusher if matching DOM exists.
    // ========================================================================

    document.addEventListener('DOMContentLoaded', function () {
        // Auto-create Player if <canvas id="videoCanvas"> exists
        if (document.getElementById('videoCanvas') && !window.player) {
            window.player = new CarrotPlayer();
        }

        // Auto-create Pusher if push page elements exist
        if ((document.getElementById('btnAudioStart') ||
            document.getElementById('btnVideoStart')) && !window.pusher) {
            window.pusher = new CarrotPusher();
        }
    });
})();
