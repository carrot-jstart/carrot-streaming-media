'use strict';

// The real SDK runs in a mock browser; no network or media devices are opened.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../web/js/carrot-sdk.js'), 'utf8');

function browser(search = '') {
    let now = 1000, sequence = 0;
    const timers = new Map(), sockets = [];
    const setTimeout = (fn, ms) => {
        const id = ++sequence;
        timers.set(id, { fn, due: now + ms });
        return id;
    };
    const clock = {
        callback(id) { return timers.get(id).fn; },
        advance(ms) {
            const end = now + ms;
            let iterations = 0;
            while (true) {
                const next = [...timers.entries()].filter(([, t]) => t.due <= end)
                    .sort((a, b) => a[1].due - b[1].due)[0];
                if (!next) break;
                if (++iterations > 1000) throw new Error('timer loop');
                const [id, timer] = next;
                timers.delete(id);
                now = timer.due;
                timer.fn();
            }
            now = end;
        },
        get size() { return timers.size; }
    };
    class Socket {
        constructor(url) { this.url = url; this.readyState = 0; this.closeCount = 0; sockets.push(this); }
        open() { this.readyState = 1; if (this.onopen) this.onopen({}); }
        close() {
            this.closeCount++;
            this.readyState = 3;
            const callback = this.onclose;
            if (callback) setTimeout(() => callback({}), 0);
        }
        serverClose() { this.readyState = 3; if (this.onclose) this.onclose({ code: 1000 }); }
    }
    const location = { protocol: 'https:', hostname: 'media.test', port: '7777',
        host: 'media.test:7777', search };
    const window = { location };
    const context = vm.createContext({
        window, location, WebSocket: Socket, URLSearchParams,
        HTMLElement: class {},
        document: { getElementById: () => null, addEventListener: () => {}, title: '' },
        console: { log() {}, warn() {}, error() {} },
        Date: class extends Date { static now() { return now; } },
        performance: { now: () => now }, setTimeout, clearTimeout: id => timers.delete(id)
    });
    vm.runInContext(source, context, { timeout: 1000 });
    return { sockets, clock,
        player(options = { audioUrl: 'live/audio' }) { return new window.CarrotSDK.Player(options); } };
}

for (const medium of ['audio', 'video']) {
    const title = medium[0].toUpperCase() + medium.slice(1);
    test(`${medium}: stale close/open/error/message cannot affect a replacement socket`, () => {
        const env = browser(), player = env.player({ [medium + 'Url']: 'live/' + medium });
        player.connect();
        const old = player[medium + 'Ws'];
        old.open();
        const stale = [old.onopen, old.onclose, old.onerror, old.onmessage];
        let messages = 0;
        player['_handle' + title + 'Message'] = () => messages++;
        env.clock.advance(10000); // Existing no-data watchdog replaces the socket.
        const replacement = player[medium + 'Ws'];
        assert.notEqual(replacement, old);
        assert.equal(old.closeCount, 1);
        for (const event of ['onopen', 'onclose', 'onerror', 'onmessage']) assert.equal(old[event], null);
        for (const callback of stale) callback({ data: new ArrayBuffer(12) });
        assert.equal(player[medium + 'Ws'], replacement);
        assert.equal(replacement.closeCount, 0);
        assert.equal(player[medium + 'ReconnectTimer'], null);
        assert.equal(messages, 0);
    });

    test(`${medium}: queued data watchdog from a prior connection is ignored`, () => {
        const env = browser(), player = env.player({ [medium + 'Url']: 'live/old' });
        player.connect();
        player[medium + 'Ws'].open();
        const callback = env.clock.callback(player['_' + medium + 'DataTimer']);
        player.connect(medium === 'video' ? 'live/new' : undefined,
            medium === 'audio' ? 'live/new' : undefined);
        const replacement = player[medium + 'Ws'];
        replacement.open();
        callback();
        assert.equal(player[medium + 'Ws'], replacement);
        assert.equal(replacement.closeCount, 0);
    });

    test(`${medium}: destroy stops queued events, while explicit connect can resume`, () => {
        const env = browser(), player = env.player({ [medium + 'Url']: 'live/' + medium });
        player.connect();
        const old = player[medium + 'Ws'];
        old.open();
        const close = old.onclose, check = env.clock.callback(player['_' + medium + 'DataTimer']);
        player.destroy();
        close({});
        check();
        env.clock.advance(40000);
        assert.equal(env.sockets.length, 1);
        assert.equal(env.clock.size, 0);
        assert.equal(player[medium + 'Ws'], null);
        player.connect();
        assert.equal(env.sockets.length, 2);
        assert.equal(player[medium + 'Ws'], env.sockets[1]);
    });
}

test('audio retries in 500 ms and leaves video running', () => {
    const env = browser(), player = env.player({ videoUrl: 'live/video', audioUrl: 'live/audio' });
    player.connect();
    const video = player.videoWs;
    player.audioWs.serverClose();
    env.clock.advance(499);
    assert.equal(env.sockets.length, 2);
    env.clock.advance(1);
    assert.equal(env.sockets.length, 3);
    assert.equal(player.videoWs, video);
    assert.equal(video.closeCount, 0);
});

test('video retains its existing 5 second retry delay', () => {
    const env = browser(), player = env.player({ videoUrl: 'live/video' });
    player.connect();
    player.videoWs.serverClose();
    env.clock.advance(4999);
    assert.equal(env.sockets.length, 1);
    env.clock.advance(1);
    assert.equal(env.sockets.length, 2);
});

test('audio retry delay is configurable in options and stock page query', () => {
    for (const query of [false, true]) {
        const env = browser(query ? '?audioUrl=live/audio&audioReconnectDelay=750' : '');
        const player = query ? env.player({}) : env.player({ audioUrl: 'live/audio', audioReconnectDelay: 750 });
        if (!query) player.connect();
        player.audioWs.serverClose();
        env.clock.advance(749);
        assert.equal(env.sockets.length, 1);
        env.clock.advance(1);
        assert.equal(env.sockets.length, 2);
    }
});

test('invalid audio retry delays fail before opening a socket', () => {
    for (const value of [0, -1, 99, 30001, 100.5, Infinity, NaN, '500', null]) {
        const env = browser();
        assert.throws(() => env.player({ audioUrl: 'live/audio', audioReconnectDelay: value }), /audioReconnectDelay/);
        assert.equal(env.sockets.length, 0);
    }
    for (const value of ['0', '-1', 'NaN', '30001', '100.5', '']) {
        const env = browser('?audioUrl=live/audio&audioReconnectDelay=' + value);
        assert.throws(() => env.player({}), /audioReconnectDelay/);
        assert.equal(env.sockets.length, 0);
    }
});

test('disconnect cancels retries; a queued retry cannot overwrite a later connection', () => {
    const env = browser(), player = env.player();
    player.connect();
    player.audioWs.serverClose();
    const stale = env.clock.callback(player.audioReconnectTimer);
    player.disconnect();
    stale();
    assert.equal(env.sockets.length, 1);
    player.connect(undefined, 'live/new');
    const replacement = player.audioWs;
    stale();
    assert.equal(player.audioWs, replacement);
    assert.equal(replacement.closeCount, 0);
    env.clock.advance(1000);
    assert.equal(env.sockets.length, 2);
});

test('explicit connect replaces both channels without leaving old sockets alive', () => {
    const env = browser(), player = env.player({ videoUrl: 'live/video', audioUrl: 'live/audio' });
    player.connect();
    const [oldVideo, oldAudio] = env.sockets;
    player.connect('live/new-video', 'live/new-audio');
    assert.equal(oldVideo.closeCount, 1);
    assert.equal(oldAudio.closeCount, 1);
    assert.match(player.videoWs.url, /videoUrl=live%2Fnew-video$/);
    assert.match(player.audioWs.url, /audioUrl=live%2Fnew-audio$/);
    env.clock.advance(5000);
    assert.equal(env.sockets.length, 4);
});
