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
test('single video without a refresh target stops with pending status instead of replaying stale progress', () => {
    const h = harness(unit(1)); const v = h.video({ ended: true, time: 100 });
    h.start(); h.api.next(); h.advance(5000);
    Object.defineProperty(v, 'ended', { configurable: true, value: false });
    h.api.next(); assert.equal(v.currentTime, 100); assert.equal(h.api.running, false);
    assert.match(h.doc.querySelector('#gemini-status').textContent, /完成状态待平台确认/); h.close();
});

test('delayed pie refresh does not replay after five seconds and does not click next video twice', () => {
    const h = harness(unit(1, '视频', '<div class="status-pie" style="--p:40"></div>') + unit(2));
    const old = h.video({ended:true}); let firstClicks = 0, secondClicks = 0;
    h.doc.getElementById('unit-item-1').onclick = () => firstClicks++;
    h.doc.getElementById('unit-item-2').onclick = () => { secondClicks++; old.remove(); h.video({src:'https://example.com/2.mp4'}); };
    h.start(); h.api.next(); h.advance(16000);
    assert.equal(firstClicks, 1); assert.equal(secondClicks, 1);
    h.doc.querySelector('#unit-item-1 .item-status').innerHTML = '<i class="is-finish"></i>';
    h.advance(1000); assert.equal(h.api.index, 1); assert.equal(secondClicks, 1); h.close();
});

test('unchanged stale pie times out as unconfirmed instead of replaying', () => {
    const h = harness(unit(1) + unit(2)); h.video({ended:true}); let clicks = 0;
    h.doc.getElementById('unit-item-1').onclick = () => clicks++;
    h.start(); h.api.next(); h.advance(31000);
    assert.equal(clicks, 1); assert.equal(h.api.running, false);
    assert.match(h.doc.querySelector('#gemini-status').textContent, /未观察到上一节饼图更新/); h.close();
});

test('updated partial progress allows bounded replay only after refresh wait', () => {
    const h = harness(unit(1, '视频', '<div class="status-pie" style="--p:40"></div>') + unit(2)); h.video({ended:true}); let clicks=0;
    h.doc.getElementById('unit-item-1').onclick = () => clicks++;
    h.start(); h.api.next(); h.advance(5000);
    h.doc.querySelector('.status-pie').style.setProperty('--p','80');
    h.advance(24000); assert.equal(clicks, 1);
    h.advance(1000); assert.equal(clicks, 2); assert.equal(h.api.running, true); h.close();
});

test('refresh clicks next unlocked video even if immediate next is locked', () => {
    const h = harness(unit(1) + unit(2,'视频','<i class="iconfont">\ue660</i>') + unit(3)); h.video({ended:true});
    let clicks=0; h.doc.getElementById('unit-item-3').onclick=()=>clicks++;
    h.start(); h.api.next(); assert.equal(clicks,1); h.close();
});

test('last video clicks previous available video before inspecting completion', () => {
    const h = harness(unit(1,'视频','<i class="is-finish"></i>') + unit(2)); h.video({ended:true}); let clicks=0;
    h.doc.getElementById('unit-item-1').onclick=()=>clicks++;
    h.start(); h.api.next(); assert.equal(clicks,1);
    h.doc.querySelector('#unit-item-2 .item-status').innerHTML='<i class="is-finish"></i>';
    h.advance(1000); assert.equal(h.api.running,false); h.close();
});

function xtPlayer(h, video) {
    const wrap = h.doc.createElement('xt-wrap'); wrap.className = 'xt_video_player_wrap';
    h.doc.body.append(wrap); wrap.append(video);
    wrap.insertAdjacentHTML('beforeend', '<xt-volumebutton class="xt_video_player_volume"><xt-icon class="xt_video_player_common_icon"></xt-icon></xt-volumebutton>');
    const icon = wrap.querySelector('xt-icon');
    let isMuted = false, clicks = 0;
    icon.onclick = () => { clicks++; isMuted = !isMuted; icon.classList.toggle('xt_video_player_common_icon_muted', isMuted); };
    return {
        icon, get clicks() { return clicks; },
        // Model the public player's timeupdate.volume recovery logic.
        recoverVolume() {
            if (video.muted || video.defaultMuted) {
                video.muted = false; video.defaultMuted = false;
                if (!isMuted) video.volume = 1;
            } else if (!isMuted) video.volume = 1;
        }
    };
}
test('XtPlayer stays silent after its native-muted reset; repeated checks do not toggle sound on', () => {
    const h = harness(unit(1)); const v = h.video(); const player = xtPlayer(h, v);
    h.start(); assert.equal(v.volume, 0); assert.equal(player.clicks, 1);
    v.muted = true; player.recoverVolume(); h.advance(6000); player.recoverVolume();
    assert.equal(v.muted, false); assert.equal(v.volume, 0); assert.equal(player.clicks, 1);
    h.close();
});
test('settings apply immediately, before first five-second progress check and before metadata', () => {
    const h = harness(unit(1)); const v = h.video(); Object.defineProperty(v, 'readyState', { value: 0, configurable: true });
    h.start(); assert.equal(v.muted, true); assert.equal(v.volume, 0); assert.equal(v.playbackRate, 2); h.close();
});
test('replacement video is silenced on metadata, and stopped automation leaves controls alone', () => {
    const h = harness(unit(1)); h.start(); const v = h.video(); const player = xtPlayer(h, v);
    v.dispatchEvent(new h.w.Event('loadedmetadata'));
    assert.equal(v.volume, 0); assert.equal(player.clicks, 1);
    h.stop(); player.icon.click(); v.volume = 0.8; h.advance(2000);
    assert.equal(v.volume, 0.8); assert.equal(player.clicks, 2); h.close();
});
test('new XtPlayer is silenced while the progress-refresh timer is pending', () => {
    const h = harness(unit(1) + unit(2)); const old = h.video({ ended: true });
    h.start(); h.api.next(); old.remove(); const v = h.video(); const player = xtPlayer(h, v);
    h.advance(500); assert.equal(v.volume, 0); assert.equal(player.clicks, 1); h.close();
});
