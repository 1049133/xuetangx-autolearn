const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(require('node:path').join(__dirname, '../userscripts/xuetangx-autolearn.user.js'), 'utf8');

// Representative markup inspected on the user's 2026-10-28 learn/space page.
function unit(id, type = '视频', status = '', active = false) {
    return `<div id="unit-item-${id}" class="menu-content-item ${active ? 'is-active' : ''}"><div class="item-type">${type}</div><div class="item-name">视频标题${id}</div><div class="item-status">${status}</div></div>`;
}
function harness(html = '') {
    const dom = new JSDOM(html, { url: 'https://www.xuetangx.com/learn/space/a/a/1/video/1', runScripts: 'outside-only' });
    const w = dom.window;
    let now = 0, id = 0;
    const jobs = new Map();
    w.Date.now = () => now;
    w.console = { log() {}, error: console.error };
    w.alert = message => { throw Error(`Unexpected alert: ${message}`); };
    w.setTimeout = (fn, delay) => { jobs.set(++id, { fn, at: now + delay }); return id; };
    w.setInterval = (fn, delay) => { jobs.set(++id, { fn, at: now + delay, delay }); return id; };
    w.clearTimeout = w.clearInterval = id => jobs.delete(id);
    w.eval(source.replace('    setTimeout(main, 2000);', `
        window.testAPI = { main, next, getChapterLists, isComplete, isLocked, getVideo,
            get running() { return running; }, get index() { return index; } };
    `));
    w.testAPI.main();
    return {
        w, api: w.testAPI, doc: w.document,
        start() { w.document.querySelector('#start-automation').click(); },
        stop() { w.document.querySelector('#stop-automation').click(); },
        advance(ms) {
            const end = now + ms;
            while (true) {
                const due = [...jobs].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                const [key, job] = due; now = job.at;
                if (job.delay) job.at += job.delay; else jobs.delete(key);
                job.fn();
            }
            now = end;
        },
        video({ ended = false, time = 0, duration = 100, src = 'https://example.com/1.mp4' } = {}) {
            const v = w.document.createElement('video'); v.src = src;
            for (const [key, value] of Object.entries({ ended, duration, readyState: 4, paused: true })) {
                Object.defineProperty(v, key, { configurable: true, value });
            }
            v.currentTime = time;
            v.getClientRects = () => [1]; v.play = () => Promise.resolve();
            w.document.body.append(v); return v;
        },
        close() { dom.window.close(); }
    };
}

test('new directory: hidden videos included, other resource types and locked/completed videos excluded', () => {
    const h = harness(`<div style="display:none">${unit(1, '视频', '<div class="status-pie" style="--p:9.41"></div>')}</div>` +
        unit(2, '图文') + unit(3, '作业') + unit(4, '考试') + unit(5, '视频', '<i class="iconfont is-finish"></i>') +
        unit(6, '视频', '<i class="iconfont">\ue660</i>') + unit(7));
    assert.equal(h.api.getChapterLists().length, 4);
    assert.deepEqual([...h.doc.querySelector('#start-select').options].map(o => o.dataset.key), ['unit-item-1', 'unit-item-7']);
    h.close();
});
test('new progress supports finish icon and exact 100%, does not round 99.99% to complete', () => {
    const h = harness(unit(1, '视频', '<div class="status-pie" style="--p:100"></div>') + unit(2, '视频', '<div class="status-pie" style="--p:99.99"></div>'));
    assert.equal(h.api.isComplete(h.doc.getElementById('unit-item-1')), true);
    assert.equal(h.api.isComplete(h.doc.getElementById('unit-item-2')), false);
    h.close();
});
test('legacy third/li directory still excludes homework and percentFull', () => {
    const h = harness('<div class="third"><li><span class="titlespan">第一讲</span></li></div><div class="third"><li><span class="titlespan noScore">作业</span></li></div><div class="third"><li><span>已完成</span><i class="percentFull"></i></li></div>');
    assert.equal(h.api.getChapterLists().length, 2);
    assert.equal(h.doc.querySelector('#start-select').options.length, 1);
    h.close();
});
test('late SPA directory enables start automatically and retains selected lesson', () => {
    const h = harness();
    assert.equal(h.doc.querySelector('#start-automation').disabled, true);
    h.doc.body.insertAdjacentHTML('afterbegin', unit(1) + unit(2)); h.advance(2000);
    const select = h.doc.querySelector('#start-select'); select.value = '1';
    h.doc.getElementById('unit-item-1').querySelector('.item-status').innerHTML = '<i class="is-finish"></i>';
    h.advance(2000);
    assert.equal(select.selectedOptions[0].dataset.key, 'unit-item-2');
    assert.equal(h.doc.querySelector('#start-automation').disabled, false);
    h.close();
});
test('missing video waits instead of skipping; stops after load timeout', () => {
    const h = harness(unit(1) + unit(2)); let clicks = 0;
    h.doc.getElementById('unit-item-2').onclick = () => clicks++;
    h.start(); h.advance(95000);
    assert.equal(clicks, 0); assert.equal(h.api.running, false); h.close();
});
test('nearly ended video remains on lesson; native media controls apply without icon clicks', () => {
    const h = harness(unit(1, '视频', '', true) + unit(2)); const v = h.video({ time: 99.8 });
    h.start(); h.api.next();
    assert.equal(h.api.index, 0); assert.equal(v.muted, true); assert.equal(v.playbackRate, 2); h.close();
});
test('stopping during refresh cancels delayed replay and navigation', () => {
    const h = harness(unit(1) + unit(2)); h.video({ ended: true, time: 100 }); let clicks = 0;
    h.doc.getElementById('unit-item-1').onclick = () => clicks++;
    h.start(); h.api.next(); h.stop(); h.advance(20000);
    assert.equal(clicks, 1); assert.equal(h.api.running, false); h.close();
});
test('refresh runs once and proceeds when platform reports completion', () => {
    const h = harness(unit(1) + unit(2)); h.video({ ended: true, time: 100 }); let clicks = 0;
    h.doc.getElementById('unit-item-2').onclick = () => clicks++;
    h.start(); h.api.next(); h.api.next(); assert.equal(clicks, 1);
    h.doc.getElementById('unit-item-1').querySelector('.item-status').innerHTML = '<i class="is-finish"></i>';
    h.advance(5000); assert.equal(h.api.index, 1); h.close();
});
test('old ended video is ignored while selected next lesson loads', () => {
    const h = harness(unit(1, '视频', '', true) + unit(2)); h.video({ ended: true });
    h.doc.querySelector('#start-select').value = '1';
    h.doc.getElementById('unit-item-2').onclick = () => {
        h.doc.getElementById('unit-item-1').classList.remove('is-active');
        h.doc.getElementById('unit-item-2').classList.add('is-active');
    };
    h.start(); h.api.next(); assert.equal(h.api.index, 1); assert.equal(h.api.running, true);
    assert.match(h.doc.querySelector('#gemini-status').textContent, /等待当前视频加载/); h.close();
});
test('single video replays after waiting, with working stop control', () => {
    const h = harness(unit(1)); const v = h.video({ ended: true, time: 100 });
    h.start(); h.api.next(); h.advance(5000);
    Object.defineProperty(v, 'ended', { configurable: true, value: false });
    h.api.next(); assert.equal(v.currentTime, 0); h.stop(); assert.equal(h.api.running, false); h.close();
});
