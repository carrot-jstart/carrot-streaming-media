'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../web/js/carrot-sdk.js'), 'utf8');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/latency_stamp.json'), 'utf8'));
const epoch = 1700000000000;

function environment(options = {}) {
    let now = 1000, sequence = 0, pendingFetch = null;
    const timers = new Map(), sockets = [], decoders = [], stats = [], statuses = [];
    const clock = {
        now: () => now,
        elapse(ms) { now += ms; },
        advance(ms) {
            const end = now + ms;
            for (let attempts = 0; attempts < 1000; attempts++) {
                const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                const [id, t] = due; timers.delete(id); now = t.at; t.fn();
            }
            now = end;
        }
    };
    class Element {}
    let draws = 0;
    const canvas = Object.assign(new Element(), { width: 0, height: 0,
        getContext: () => ({ drawImage() { draws++; clock.elapse(3); } }) });
    class Socket {
        constructor(url) { this.url = url; sockets.push(this); this.readyState = 0; }
        open() { this.readyState = 1; if (this.onopen) this.onopen({}); }
        close() { this.readyState = 3; }
    }
    class Decoder {
        constructor(callbacks) { this.callbacks = callbacks; this.state = 'unconfigured'; this.chunks = []; decoders.push(this); }
        configure(config) { this.config = config; this.state = 'configured'; }
        decode(chunk) { if (this.fail) throw new Error('decode failed'); this.chunks.push(chunk); }
        close() { this.state = 'closed'; }
    }
    const location = { protocol: 'https:', hostname: 'media.test', host: 'media.test:7777', port: '7777', search: '' };
    const requests = [];
    const fetch = (url, init) => {
        requests.push({ url, init });
        if (options.pending) return new Promise((resolve, reject) => {
            pendingFetch = resolve;
            init.signal.addEventListener('abort', () => { if (!options.ignoreAbort) reject(new Error('aborted')); });
        });
        clock.elapse(10);
        const data = { unix_ms: epoch + now + (options.clockOffset || 0), synchronized: options.synchronized !== false,
            max_error_ms: options.badReport ? -1 : 3 };
        clock.elapse(options.slow ? 2100 : 10);
        return Promise.resolve({ ok: !options.unavailable, json: async () => data });
    };
    const context = vm.createContext({
        window: { location }, location, HTMLElement: Element, URLSearchParams,
        document: { getElementById: () => null, addEventListener() {}, title: '' },
        console: { log() {}, error() {}, warn() {} },
        performance: { now: clock.now }, Date: class extends Date { static now() { return epoch + now + 99999999; } },
        fetch, AbortController, WebSocket: Socket, VideoDecoder: Decoder,
        EncodedVideoChunk: class { constructor(properties) { Object.assign(this, properties); } },
        setTimeout(fn, ms) { const id = ++sequence; timers.set(id, { fn, at: now + ms }); return id; },
        clearTimeout(id) { timers.delete(id); }
    });
    vm.runInContext(source, context);
    const player = new context.window.CarrotSDK.Player({ videoUrl: 'live/test', canvas: options.noCanvas ? null : canvas,
        onStats: s => stats.push(s), onStatus: s => statuses.push(s) });
    player.connect();
    player.videoWs.open();
    function message(type, timestamp, payload) {
        const data = new Uint8Array(12 + payload.length), view = new DataView(data.buffer);
        view.setUint32(0, type); view.setUint32(4, timestamp); view.setUint32(8, payload.length);
        data.set(payload, 12); player.videoWs.onmessage({ data: data.buffer });
    }
    function configure() {
        message(0, 0, Uint8Array.from([0,0,0,0,4,103,100,0,31,0,0,0,2,104,0]));
    }
    function feed(timestamp = 42, au = Buffer.from(fixture.auHex, 'hex')) {
        message(1, timestamp, Uint8Array.from([0, ...au]));
        return player.videoDecoder && player.videoDecoder.chunks.at(-1);
    }
    function emit(chunk, delay = 12, decoder = player.videoDecoder) {
        clock.elapse(delay);
        const frame = { timestamp: chunk.timestamp, displayWidth: 640, displayHeight: 360, closed: 0,
            close() { this.closed++; } };
        decoder.callbacks.output(frame); return frame;
    }
    return { player, clock, timers, requests, sockets, decoders, stats, statuses, configure, feed, emit,
        draws: () => draws, resolveFetch() { pendingFetch({ ok: true, json: async () => ({
            unix_ms: epoch + now, synchronized: true, max_error_ms: 1 }) }); } };
}
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
async function ready(options) { const env = environment(options); await flush(); env.configure(); return env; }

test('reports capture-to-Canvas estimate and separate receive-to-Canvas duration, independent of browser wall clock', async () => {
    const env = await ready(), chunk = env.feed(), frame = env.emit(chunk);
    const s = env.stats.at(-1);
    assert.equal(s.receiveToRenderMs, 15);
    assert.equal(s.endToEndLatencyMs, epoch + env.clock.now() - fixture.unixMs);
    assert.equal(s.latency, s.endToEndLatencyMs);
    assert.ok(s.latencyUncertaintyMs >= 30 && s.latencyUncertaintyMs < 34);
    assert.equal(frame.closed, 1);
    assert.equal(env.requests.length, 3);
    assert.ok(env.requests.every(r => r.url === 'https://media.test:7777/api/time' && r.init.cache === 'no-store'));
    assert.match(env.statuses.at(-1), /取帧→绘制估算:.*网页处理:15\.0ms/);
    env.player.disconnect(); assert.equal(env.timers.size, 0);
});

test('old streams without timestamp metadata remain playable and report unavailable, not zero', async () => {
    const env = await ready(), chunk = env.feed(42, Buffer.from('00000003658884', 'hex'));
    env.emit(chunk);
    assert.equal(env.stats.at(-1).endToEndLatencyMs, null);
    assert.equal(env.stats.at(-1).receiveToRenderMs, 15);
    assert.match(env.stats.at(-1).latencyUnavailableReason, /无时间戳/);
    env.player.disconnect();
});

for (const [title, options, reason] of [
    ['server not synchronized', { synchronized: false }, /平台时钟未同步/],
    ['time endpoint unavailable', { unavailable: true }, /接口不可用/],
    ['invalid time report', { badReport: true }, /数据无效/],
    ['time sampling too slow', { slow: true }, /数据无效/],
    ['negative age from a clock mismatch', { clockOffset: -20000 }, /时钟偏差/]
]) test(title + ' never produces a fabricated end-to-end value', async () => {
    const env = await ready(options); env.emit(env.feed());
    assert.equal(env.stats.at(-1).latency, null);
    assert.match(env.stats.at(-1).latencyUnavailableReason, reason);
    env.player.disconnect();
});

test('vehicle clock must be synchronized', async () => {
    const env = await ready(), au = Buffer.from(fixture.auHex, 'hex'); au[24] = 0;
    env.emit(env.feed(42, au));
    assert.equal(env.stats.at(-1).latency, null);
    assert.match(env.stats.at(-1).latencyUnavailableReason, /车端时钟未同步/);
    env.player.disconnect();
});

test('expired time samples become unavailable', async () => {
    const env = await ready(); env.clock.elapse(90001); env.emit(env.feed());
    assert.equal(env.stats.at(-1).latency, null);
    assert.match(env.stats.at(-1).latencyUnavailableReason, /已过期/);
    env.player.disconnect();
});

test('each decoder output uses its own received frame timestamp even when outputs are reordered', async () => {
    const env = await ready(), a = env.feed(42);
    env.clock.elapse(20); const b = env.feed(43);
    env.emit(b, 10); assert.equal(env.stats.at(-1).receiveToRenderMs, 13);
    env.emit(a, 5); assert.equal(env.stats.at(-1).receiveToRenderMs, 41);
    env.player.disconnect();
});

test('late decoder outputs and late time responses after reconnect cannot overwrite the new session', async () => {
    const env = await ready(), a = env.feed(), old = env.player.videoDecoder;
    env.player.connect('live/next'); env.player.videoWs.open();
    const drawn = env.draws(), frame = env.emit(a, 1, old);
    assert.equal(frame.closed, 1); assert.equal(env.draws(), drawn);
    env.player.disconnect();

    const pending = environment({ pending: true, ignoreAbort: true });
    pending.player.disconnect(); pending.resolveFetch(); await flush();
    assert.equal(pending.player._timeSample, null);
    assert.equal(pending.timers.size, 0);
    assert.equal(pending.requests.length, 1);
});

test('disconnect aborts a pending clock request and removes its timers', async () => {
    const env = environment({ pending: true });
    env.player.disconnect(); await flush();
    assert.equal(env.requests[0].init.signal.aborted, true);
    assert.equal(env.timers.size, 0);
});

test('timing history is bounded and failed decodes do not leak timing records', async () => {
    const env = await ready(); env.player.videoDecoder.fail = true; env.feed();
    assert.equal(env.player._frameTimings.size, 0);
    // A failed decoder is discarded; the next keyframe rebuilds it from the
    // cached codec configuration instead of reusing its broken reference chain.
    assert.equal(env.player.videoDecoder, null);
    for (let i = 0; i < 300; i++) env.feed(i);
    assert.equal(env.player._frameTimings.size, 256);
    env.player.disconnect(); assert.equal(env.player._frameTimings.size, 0);
});

test('malformed or unknown SEI does not break playback', async () => {
    for (const make of [
        au => au.subarray(0, 14),
        au => { au[10] ^= 1; return au; },
        au => { au[23] = 9; return au; },
        au => Buffer.concat([Buffer.from('000000050605010080', 'hex'), au])
    ]) {
        const env = await ready(), au = make(Buffer.from(fixture.auHex, 'hex'));
        env.emit(env.feed(42, au));
        assert.equal(env.stats.length, 1);
        assert.equal(env.stats.at(-1).receiveToRenderMs, 15);
        env.player.disconnect();
    }
});

test('unsigned 32-bit media timestamps remain positive after bit 31 is set', async () => {
    const env = await ready(), chunk = env.feed(0x80000001);
    assert.equal(chunk.timestamp, 0x80000001 * 1000);
    env.emit(chunk);
    assert.notEqual(env.stats.at(-1).latency, null);
    env.player.disconnect();
});

test('without a Canvas submission there is no invented render duration', async () => {
    const env = await ready({ noCanvas: true });
    env.emit(env.feed());
    assert.equal(env.stats.at(-1).latency, null);
    assert.equal(env.stats.at(-1).receiveToRenderMs, null);
    env.player.disconnect();
});
