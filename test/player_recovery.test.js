'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../web/js/carrot-sdk.js'), 'utf8');

function environment(options = {}) {
    let now = 1000, timerId = 0, draws = 0, writes = 0;
    const timers = new Map(), decoders = [], sockets = [], statuses = [], stats = [], logs = [];
    const controls = { failConfigure: false };
    class Element {}
    const status = Object.assign(new Element(), { className: '' });
    let text = '';
    Object.defineProperty(status, 'textContent', {
        get: () => text, set: value => { writes++; text = value; }
    });
    const canvas = Object.assign(new Element(), { width: 0, height: 0,
        getContext: () => ({ drawImage() { draws++; if (options.drawThrows) throw Error('lost drawing context'); } }) });
    class Socket {
        constructor(url) { this.url = url; this.closeCount = 0; sockets.push(this); }
        close() { this.closeCount++; }
    }
    class Decoder {
        constructor(callbacks) {
            this.callbacks = callbacks; this.state = 'unconfigured'; this.decodeQueueSize = 0;
            this.chunks = []; this.pending = []; this.closeCount = 0; decoders.push(this);
        }
        configure(config) {
            if (controls.failConfigure) throw Error('unsupported codec');
            this.config = config; this.state = 'configured';
        }
        decode(chunk) {
            if (this.failDecode) throw Error('corrupt bitstream');
            assert.equal(this.state, 'configured');
            this.decodeQueueSize++; this.chunks.push(chunk); this.pending.push(chunk);
        }
        close() {
            if (this.state === 'closed') throw Error('already closed');
            this.closeCount++; this.state = 'closed'; this.decodeQueueSize = 0;
        }
        fail() { this.state = 'closed'; this.callbacks.error(Error('hardware decoder failed')); }
    }
    const location = { protocol: 'https:', hostname: 'media.test', port: '7777', search: '' };
    const context = vm.createContext({
        window: { location }, location, HTMLElement: Element, URLSearchParams,
        document: { getElementById: () => null, addEventListener() {}, title: '' },
        console: { log: (...a) => logs.push(a), warn: (...a) => logs.push(a), error: (...a) => logs.push(a) },
        performance: { now: () => now }, Date: class extends Date { static now() { return now; } },
        WebSocket: Socket, VideoDecoder: Decoder,
        EncodedVideoChunk: class { constructor(p) { Object.assign(this, p); } },
        setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
        clearTimeout(id) { timers.delete(id); }
    });
    vm.runInContext(source, context);
    const player = new context.window.CarrotSDK.Player({ videoUrl: 'live/test',
        audioUrl: options.audio ? 'live/audio' : '', canvas, statusEl: status,
        onStats: s => stats.push(s), onStatus: s => statuses.push(s), onFrame: options.onFrame });
    player.connect();
    function message(type, timestamp, payload) {
        const data = new Uint8Array(12 + payload.length), view = new DataView(data.buffer);
        view.setUint32(0, type); view.setUint32(4, timestamp); view.setUint32(8, payload.length);
        data.set(payload, 12); player.videoWs.onmessage({ data: data.buffer });
    }
    const configure = () => message(0, 0, Uint8Array.from([0,0,0,0,4,103,100,0,31,0,0,0,2,104,0]));
    const feed = (key = false, timestamp = now) => message(1, timestamp,
        Uint8Array.from([key ? 0 : 1, 0,0,0,3, key ? 0x65 : 0x41, 0x88,0x84]));
    function emit(decoder = player.videoDecoder, chunk = decoder.pending.shift()) {
        decoder.decodeQueueSize = Math.max(0, decoder.decodeQueueSize - 1);
        const frame = { timestamp: chunk.timestamp, displayWidth: 640, displayHeight: 360,
            closed: 0, close() { this.closed++; } };
        decoder.callbacks.output(frame);
        return frame;
    }
    return { player, configure, feed, emit, controls, decoders, sockets, statuses, stats, logs, timers,
        elapse(ms) { now += ms; }, draws: () => draws, writes: () => writes };
}

test('decode backlog is bounded; recovery drops deltas until the next keyframe', () => {
    const env = environment(); env.configure(); env.feed(true);
    const old = env.player.videoDecoder, ws = env.player.videoWs;
    for (let i = 1; i < 6; i++) env.feed(false, i);
    assert.equal(old.decodeQueueSize, 6);
    env.feed(false, 7);
    assert.equal(old.closeCount, 1);
    assert.equal(env.player.videoDecoder, null);
    assert.equal(env.player._frameTimings.size, 0);
    assert.equal(env.player.videoNeedsKeyframe, true);
    assert.equal(env.player.videoRecoveryCount, 1);
    for (let i = 0; i < 20; i++) env.feed(false, 8 + i);
    assert.equal(env.decoders.length, 1);
    env.feed(true, 30);
    assert.equal(env.decoders.length, 2);
    assert.equal(env.player.videoDecoder.chunks[0].type, 'key');
    assert.equal(env.player.videoNeedsKeyframe, false);
    assert.equal(env.player.videoWs, ws);
    assert.equal(ws.closeCount, 0);
    env.player.disconnect();
});

test('an incoming keyframe can restart immediately when it encounters an overloaded decoder', () => {
    const env = environment(); env.configure();
    for (let i = 0; i < 6; i++) env.feed(i === 0, i);
    env.feed(true, 7);
    assert.equal(env.decoders.length, 2);
    assert.equal(env.player.videoDecoder.chunks.length, 1);
    assert.equal(env.player.videoDecoder.chunks[0].timestamp, 7000);
    env.player.disconnect();
});

test('async decoder errors in closed state recover on a keyframe without disturbing audio', () => {
    const env = environment({ audio: true }); env.configure(); env.feed(true);
    const old = env.player.videoDecoder, videoWs = env.player.videoWs, audioWs = env.player.audioWs;
    let audioClosed = 0;
    const audioDecoder = env.player.audioDecoder = { close() { audioClosed++; } };
    old.fail();
    assert.equal(old.closeCount, 0); // close() on an already closed WebCodecs decoder throws.
    assert.equal(env.player.videoDecoder, null);
    assert.equal(env.player._frameTimings.size, 0);
    env.feed(false); assert.equal(env.decoders.length, 1);
    env.feed(true); assert.equal(env.decoders.length, 2);
    assert.equal(env.player.videoWs, videoWs); assert.equal(env.player.audioWs, audioWs);
    assert.equal(env.player.audioDecoder, audioDecoder); assert.equal(audioClosed, 0);
    env.player.disconnect();
});

test('synchronous decode failures discard the failed reference chain and recover', () => {
    const env = environment(); env.configure();
    const old = env.player.videoDecoder; old.failDecode = true;
    env.feed(true);
    assert.equal(old.closeCount, 1); assert.equal(env.player.videoDecoder, null);
    assert.equal(env.player._frameTimings.size, 0); assert.equal(env.player.videoNeedsKeyframe, true);
    env.feed(false); assert.equal(env.decoders.length, 1);
    env.feed(true); assert.equal(env.decoders.length, 2);
    assert.equal(env.emit().closed, 1);
    env.player.disconnect();
});

test('stale decoder output is closed and stale errors cannot destroy its replacement', () => {
    const env = environment(); env.configure(); env.feed(true);
    const old = env.player.videoDecoder, chunk = old.chunks[0];
    old.fail(); env.feed(true);
    const replacement = env.player.videoDecoder, draws = env.draws(), recovered = env.player.videoRecoveryCount;
    assert.equal(env.emit(old, chunk).closed, 1);
    assert.equal(env.draws(), draws);
    old.callbacks.error(Error('late failure'));
    assert.equal(env.player.videoDecoder, replacement);
    assert.equal(env.player.videoRecoveryCount, recovered);
    env.player.disconnect();
});

test('disconnect ignores late decoder events and clears configuration before a stream switch', () => {
    const env = environment(); env.configure(); env.feed(true);
    const old = env.player.videoDecoder, chunk = old.chunks[0];
    old.state = 'closed';
    assert.doesNotThrow(() => env.player.disconnect());
    old.callbacks.error(Error('late failure'));
    assert.equal(env.emit(old, chunk).closed, 1);
    assert.equal(env.decoders.length, 1);
    assert.equal(env.player._videoDecoderConfig, null);
    env.player.connect('live/new'); env.feed(true);
    assert.equal(env.player.videoDecoder, null); // No use of the previous stream's SPS/PPS.
    env.configure(); env.feed(true); assert.equal(env.decoders.length, 2);
    env.player.disconnect();
});

test('failed configure retries only on new keyframes, never in an error callback loop', () => {
    const env = environment(); env.controls.failConfigure = true; env.configure();
    assert.equal(env.decoders.length, 1); assert.equal(env.player.videoDecoder, null);
    for (let i = 0; i < 20; i++) env.feed(false);
    assert.equal(env.decoders.length, 1);
    env.feed(true); assert.equal(env.decoders.length, 2);
    env.controls.failConfigure = false; env.feed(true);
    assert.equal(env.decoders.length, 3); assert.equal(env.player.videoDecoder.state, 'configured');
    env.player.disconnect();
});

for (const failure of ['drawImage', 'onFrame']) test(failure + ' exceptions always release VideoFrame once', () => {
    const env = environment(failure === 'drawImage' ? { drawThrows: true } :
        { onFrame() { throw Error('user callback failed'); } });
    env.configure(); env.feed(true);
    let frame;
    assert.doesNotThrow(() => { frame = env.emit(); });
    assert.equal(frame.closed, 1);
    assert.equal(env.player._frameTimings.size, 0);
    assert.equal(env.player.droppedCount, 1);
    if (failure === 'drawImage') assert.equal(env.stats.at(-1).receiveToRenderMs, null);
    env.player.disconnect();
});

test('normal video keeps per-frame statistics with bounded DOM updates and no per-frame logs', () => {
    const env = environment(); env.configure();
    env.logs.length = 0; env.statuses.length = 0;
    const writes = env.writes();
    for (let i = 0; i < 30; i++) {
        env.feed(i === 0, i); assert.equal(env.emit().closed, 1); env.elapse(33);
    }
    assert.equal(env.player.decodedCount, 30); assert.equal(env.player.frameCount, 30);
    assert.equal(env.stats.length, 30);
    assert.ok(env.statuses.length <= 4); assert.ok(env.writes() - writes <= 4);
    assert.equal(env.logs.length, 0); assert.equal(env.player.videoRecoveryCount, 0);
    assert.equal(env.player._frameTimings.size, 0);
    env.player.disconnect();
});
