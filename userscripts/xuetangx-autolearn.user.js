// ==UserScript==
// @name         学堂在线视频自动学习面板脚本
// @namespace    http://tampermonkey.net/
// @version      1.7.3
// @license      MIT
// @description  为学堂在线(xuetangx.com/learn/)提供一个操作面板，只播放左侧“饼图未满”的章节；自动 2.0 倍速、静音、循环播放，兼容新版知识点目录及旧版章节目录。
// @author       Yangkunlong + ChatGPT
// @homepageURL  https://github.com/1049133/xuetangx-autolearn
// @downloadURL  https://raw.githubusercontent.com/1049133/xuetangx-autolearn/main/userscripts/xuetangx-autolearn.user.js
// @updateURL    https://raw.githubusercontent.com/1049133/xuetangx-autolearn/main/userscripts/xuetangx-autolearn.user.js
// @match        *://www.xuetangx.com/learn/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    // --- 全局变量 ---
    var index = 0;                  // 当前正在播放的章节索引（对应 lists 的下标）
    var runIt;                      // 定时器
    var lists;                      // 左侧章节列表（class="third"）
    var replayCountMap = {};        // 每节的重播次数，防止死循环
    var pendingCheckIndex = null;   // 记录哪一节需要在切章后检查饼图
    var isRefreshingPie = false;    // 正在“切章刷新饼图”的过程中，避免重复触发

    var running = false;
    var refreshTimer;
    var loadStartedAt = 0;
    var pendingChapterKey = null;
    var chapterSignature = '';
    var coursePath = '';
    var playPending = false;
    var lastMessage = '';
    var staleSource = null;
    var replayFromStart = false;
    var refreshTargetKey = null;
    var refreshStartedAt = 0;
    var progressBeforeRefresh = '';
    var progressChangedAfterSwitch = false;

    function progressSignature(el) {
        var pie = el.querySelector('.status-pie');
        return isComplete(el) ? 'complete' : pie ? pie.style.getPropertyValue('--p') : 'unknown';
    }

    function selectChapter(el) {
        var active = document.querySelector('[id^="unit-item-"].is-active');
        var video = getVideo();
        staleSource = active && active.id !== el.id && video ? (video.currentSrc || video.src) : null;
        loadStartedAt = Date.now();
        el.click();
    }

    // 新版知识点目录：折叠章节仍在 DOM 中，用 textContent 读取标题。
    function getChapterLists() {
        var modern = Array.from(document.querySelectorAll('[id^="unit-item-"].menu-content-item'));
        if (modern.length) {
            return modern.filter(function(el) {
                var type = el.querySelector('.item-type');
                return type && /^(视频|video)$/i.test(type.textContent.trim());
            });
        }
        return Array.from(document.getElementsByClassName('third')).filter(function(el) {
            return chapterChildren(el).length && !isHomeworkChapter(el);
        });
    }

    function chapterChildren(el) {
        if (!el) return [];
        return el.matches('[id^="unit-item-"]') ? [el] : el.getElementsByTagName('li');
    }

    function chapterTitle(el) {
        var node = el.querySelector('.item-name, .titlespan, span');
        return (node ? node.textContent : el.textContent).trim() || '无标题';
    }

    function chapterKey(el) {
        return el.id || chapterTitle(el);
    }

    function isComplete(el) {
        if (el.querySelector('.percentFull, .item-status .is-finish')) return true;
        var pie = el.querySelector('.status-pie');
        var value = pie ? parseFloat(pie.style.getPropertyValue('--p')) : NaN;
        return Number.isFinite(value) && value >= 100;
    }

    function isLocked(el) {
        // 新版 lessonGraphMenu 的锁图标 U+E660，来自页面公开组件。
        return el.getAttribute('aria-disabled') === 'true' ||
            Array.from(el.querySelectorAll('.item-status .iconfont')).some(function(icon) {
                return icon.textContent.trim() === '\ue660';
            });
    }

    function getVideo() {
        var videos = Array.from(document.querySelectorAll('video'));
        return videos.find(function(v) { return v.getClientRects().length && v.matches('.xt_video_player'); }) ||
            videos.find(function(v) { return v.getClientRects().length; });
    }

    function ensureMuted(video) {
        // XtPlayer 的 timeupdate.volume 定时清除 muted/defaultMuted。
        // 必须点音量图标同步其内部 isMuted 状态，而非只修改 video.muted。
        var player = video.closest('.xt_video_player_wrap, .xt_video_player_container');
        var icon = player && player.querySelector('.xt_video_player_volume > .xt_video_player_common_icon');
        if (icon) {
            if (!icon.classList.contains('xt_video_player_common_icon_muted')) icon.click();
            // 音量控件有写入节流，直接归零可覆盖首次点击未写入的情况。
            if (video.volume !== 0) video.volume = 0;
        } else {
            // 原生/其他播放器没有 XtPlayer 的状态同步逻辑。
            if (!video.muted) video.muted = true;
            if (video.volume !== 0) video.volume = 0;
        }
    }

    function applyPlaybackSettings() {
        if (!running) return;
        var video = getVideo();
        if (!video) return;
        ensureMuted(video);
        speed(video);
    }

    function stopAutomation(message) {
        running = false;
        clearInterval(runIt);
        clearTimeout(refreshTimer);
        isRefreshingPie = false;
        pendingCheckIndex = null;
        pendingChapterKey = null;
        staleSource = null;
        replayFromStart = false;
        refreshTargetKey = null;
        progressChangedAfterSwitch = false;
        if (message) logStatus(message);
        var button = document.getElementById('stop-automation');
        if (button) button.disabled = true;
    }

    function tryPlay(video) {
        if (playPending || !video.paused || video.ended) return;
        playPending = true;
        Promise.resolve().then(function() { return video.play(); }).catch(function(error) {
            logStatus('播放未成功（' + error.name + '），请手动点击播放器播放。');
        }).finally(function() { playPending = false; });
    }

    // --- UI/操作面板 相关函数 ---

    /**
     * 构建操作面板的HTML和CSS，并使其可拖动
     */
    function createPanel() {
        if (document.getElementById('gemini-automation-panel')) return;
        // CSS 样式
        const panelStyle = `
            #gemini-automation-panel {
                position: fixed;
                top: 100px;
                right: 20px;
                width: 320px;
                background-color: #fff;
                border: 1px solid #ccc;
                box-shadow: 0 4px 12px rgba(0,0,0,0.3);
                z-index: 9999;
                font-family: 'Microsoft YaHei', Arial, sans-serif;
                border-radius: 8px;
                overflow: hidden;
                font-size: 13px;
            }
            #gemini-panel-header {
                cursor: move;
                background-color: #007bff;
                color: white;
                padding: 10px;
                border-bottom: 1px solid #0056b3;
                font-weight: bold;
                user-select: none;
            }
            #gemini-automation-panel button {
                transition: background-color 0.3s;
            }
            #gemini-automation-panel button:hover {
                background-color: #1e7e34 !important;
            }
        `;

        // 插入 CSS
        const styleSheet = document.createElement("style");
        styleSheet.type = "text/css";
        styleSheet.innerText = panelStyle;
        document.head.appendChild(styleSheet);

        // HTML 结构
        const panelHTML = `
            <div id="gemini-panel-header">
                🚀 学堂在线自动学习面板 v1.7.3
            </div>
            <div style="padding: 10px;">
                <p><strong>未完成章节数: </strong><span id="video-count">加载中...</span></p>
                <div style="margin-bottom: 15px; margin-top: 10px;">
                    <label for="start-select" style="display: block; font-weight: bold;">选择起始视频（仅显示未完成且可学习的视频）:</label>
                    <select id="start-select" style="width: 100%; padding: 7px; margin-top: 5px; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box;"></select>
                </div>
                <button id="start-automation" style="width: 100%; padding: 10px; background-color: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer;">
                    ▶️ 从所选章节开始自动学习
                </button>
                <button id="stop-automation" disabled style="width:100%;padding:8px;margin-top:6px;">停止自动切换</button>
                <button id="rescan-automation" style="width:100%;padding:8px;margin-top:6px;">重新扫描目录</button>
                <p style="margin-top: 10px; font-size: 12px; color: #666; text-align: center;">
                    * 只播放饼图未满的章节；自动 2.0 倍速、静音，播放结束后点击下一视频刷新饼图；等待平台确认后继续或重播。
                </p>

                <div id="gemini-status"
                    style="margin-top: 8px; font-size: 12px; color: #333;
                           background: #f8f9fa; border-radius: 4px; padding: 6px;
                           max-height: 140px; overflow-y: auto; white-space: pre-line; border: 1px solid #e1e4e8;">
                    等待启动...
                </div>
            </div>
        `;

        const panel = document.createElement("div");
        panel.id = "gemini-automation-panel";
        panel.innerHTML = panelHTML;
        document.body.appendChild(panel);

        document.getElementById('stop-automation').onclick = function() {
            stopAutomation('已停止自动切换；当前视频可手动控制。');
        };
        document.getElementById('rescan-automation').onclick = function() {
            if (running) stopAutomation('重新扫描目录，已停止自动切换，请重新选择起点。');
            populatePanel();
        };
        makeDraggable(panel);

        return panel;
    }
        /**
     * 判断某个章节是不是“作业/习题”等非视频单元
     * 依据：
     *   - li 里是否存在 span.titlespan.noScore
     *   - 文本里是否包含“习题”等关键字（防御性补刀）
     */
     function isHomeworkChapter(listElement) {
        if (!listElement) return false;

        var li = listElement.querySelector("li");
        if (!li) return false;

        // 只看 span.titlespan.noScore
        var span = li.querySelector("span.titlespan.noScore");
        if (!span) return false;

        var text = (span.textContent || "").trim();
        if (!text) return false;

        // 只在这个 span 文本里找关键字
        return /习题|作业|练习|测验|考试|homework|quiz|exercise/i.test(text);
    }


    /**
     * 将状态信息输出到面板上的状态框
     */
    function logStatus(msg) {
        var box = document.getElementById("gemini-status");
        if (!box) return;

        if (lastMessage === msg) return;
        lastMessage = msg;
        var time = new Date().toLocaleTimeString();
        var line = "[" + time + "] " + msg;

        if (box.textContent && box.textContent.trim() !== "") {
            box.textContent += "\n" + line;
        } else {
            box.textContent = line;
        }

        box.textContent = box.textContent.split('\n').slice(-60).join('\n');
        box.scrollTop = box.scrollHeight;
    }

    /**
     * 实现面板拖动功能
     */
    function makeDraggable(element) {
        var header = document.getElementById("gemini-panel-header");
        var pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;

        if (header) {
            header.onmousedown = dragMouseDown;
        }

        function dragMouseDown(e) {
            e = e || window.event;
            e.preventDefault();
            pos3 = e.clientX;
            pos4 = e.clientY;
            document.onmouseup = closeDragElement;
            document.onmousemove = elementDrag;
        }

        function elementDrag(e) {
            e = e || window.event;
            e.preventDefault();
            pos1 = pos3 - e.clientX;
            pos2 = pos4 - e.clientY;
            pos3 = e.clientX;
            pos4 = e.clientY;
            element.style.top = (element.offsetTop - pos2) + "px";
            element.style.left = (element.offsetLeft - pos1) + "px";
        }

        function closeDragElement() {
            document.onmouseup = null;
            document.onmousemove = null;
        }
    }

    /**
     * 面板：只把“饼图未满”的章节放进下拉框
     */
    function populatePanel() {
        try {
            lists = getChapterLists();

            const videoCountSpan = document.getElementById("video-count");
            const startSelect = document.getElementById("start-select");
            const startButton = document.getElementById("start-automation");

            if (lists.length === 0) {
                videoCountSpan.innerText = "0（等待视频目录加载，可展开目录后重新扫描）";
                logStatus("等待视频目录加载；若目录已显示，请点击重新扫描。");
                startSelect.innerHTML = '<option value="-1">未找到视频列表</option>';
                startButton.disabled = true;
                return;
            }

            var selectedKey = startSelect.selectedOptions[0]?.dataset.key;
            startSelect.innerHTML = '';
            let unfinishedCount = 0;

            for (let i = 0; i < lists.length; i++) {
                const temp = chapterChildren(lists[i]);
                if (temp.length === 0) continue;
                const li = temp[0];

                // 有 .percentFull 说明饼图已满，直接跳过
                const fullIcon = isComplete(li);
                if (fullIcon || isLocked(li)) {
                    continue;
                }
                // 作业/习题：用 DOM 标记过滤掉
                if (isHomeworkChapter(lists[i])) {
                    // 可选：logStatus("过滤作业章节 #" + i);
                    continue;
                }

                unfinishedCount++;

                let titleText = chapterTitle(li);
                const titleSpan = li.getElementsByTagName("span");
                if (titleSpan.length > 0) {
                    titleText = chapterTitle(li);
                }

                const option = document.createElement("option");
                option.dataset.key = chapterKey(li);
                option.selected = selectedKey ? selectedKey === chapterKey(li) : li.classList.contains('is-active');
                option.value = i; // 直接保存原始索引
                option.innerText = `[#${i}] ${titleText}`;
                startSelect.appendChild(option);
            }

            videoCountSpan.innerText = unfinishedCount;
            logStatus("当前未完成章节数：" + unfinishedCount + "。");

            if (unfinishedCount === 0) {
                startSelect.innerHTML = '<option value="-1">没有未完成的章节</option>';
                startButton.disabled = true;
            logStatus("当前没有未完成且可学习的视频；请查看平台进度及锁定状态。");
                return;
            } else {
                startButton.disabled = false;
            }

            // 绑定开始按钮事件
            startButton.onclick = function() {
                const selectedValue = startSelect.value;
                const selectedIndex = parseInt(selectedValue, 10);
                if (!isNaN(selectedIndex) && selectedIndex >= 0) {
                    console.log("用户选择从章节 #", selectedIndex, " 开始。");
                    logStatus("开始自动学习，从章节 #" + selectedIndex + " 开始（饼图未满）。");
                    stopAutomation();
                    replayCountMap = {};
                    running = true;
                    document.getElementById('stop-automation').disabled = false;
                    index = selectedIndex;
                    startNum(selectedIndex);
                } else {
                    alert("请选择一个有效的起始章节！");
                }
            };

        } catch (e) {
            console.error("面板初始化失败:", e);
            logStatus("面板初始化失败：" + e.message);
        }
    }

    // --- 播放列表：只在“饼图未满”的章节之间跳转 ---

    /**
     * 从指定起点之后，找到下一个饼图未满的章节索引
     * @param {number} startIndex - 从哪个索引之后开始找（一般是当前 index）
     * @returns {number} - 下一未完成章节索引；找不到则返回 -1
     */
    function findNextUnfinished(startIndex) {
        lists = getChapterLists();
        for (let i = startIndex + 1; i < lists.length; i++) {
            const temp = chapterChildren(lists[i]);
            if (temp.length === 0) continue;
            const li = temp[0];
            const fullIcon = isComplete(li);
            if (!fullIcon && !isLocked(li) && !isHomeworkChapter(lists[i])) {
                return i;
            }
        }
        return -1;
    }

    /**
     * 跳转到下一个饼图未满的章节；如果没有，就结束脚本
     * @param {number} currentIndex - 当前章节索引
     */
    function gotoNextUnfinished(currentIndex) {
        const nextIdx = findNextUnfinished(currentIndex);
        if (nextIdx === -1) {
            console.log("没有更多未完成的章节，脚本结束。");
            logStatus("没有更多未完成的章节，脚本结束。");
            stopAutomation('所选起点之后已无可学习的未完成视频，请以平台显示进度为准。');
            return;
        }
        startNum(nextIdx);
    }

    // --- 核心自动化逻辑函数 ---

    /**
     * 根据索引启动某个章节的播放 (模拟点击)
     * @param {number} num - 章节索引
     */
        function startNum(num) {
        lists = getChapterLists();

        if (num < 0 || num >= lists.length) {
            console.log("索引超出范围，尝试结束。");
            logStatus("章节索引超出范围，脚本结束。");
            stopAutomation();
            return;
        }

        if (!running) return;
        index = num;
        loadStartedAt = Date.now();
        var currentList = lists[index];
        var temp = chapterChildren(currentList);

        if (temp.length === 0) {
            console.log("章节 #" + index + " 中未找到 'li' 元素。尝试跳过。");
            logStatus("章节 #" + index + " 没有有效视频节点，跳到下一个未完成章节。");
            gotoNextUnfinished(index);
            return;
        }

        var li = temp[0];

        // 1. 作业/习题：直接跳过（你前面已经有 isHomeworkChapter 的话可以用它）
        if (typeof isHomeworkChapter === "function" && isHomeworkChapter(currentList)) {
            logStatus("章节 #" + index + " 是作业/习题，自动跳过。");
            gotoNextUnfinished(index);
            return;
        }

        // 2. 饼图已经满：不用再刷，跳下一个
        var fullIcon = isComplete(li);
        if (fullIcon) {
            logStatus("章节 #" + index + " 饼图已经满了，自动跳到下一个未完成章节。");
            gotoNextUnfinished(index);
            return;
        }

        // 3. 真的需要刷这节 → 点击进入，开始自动播放
        if (isLocked(li)) {
            logStatus('当前视频暂不可学习，已停止。');
            stopAutomation();
            return;
        }
        selectChapter(li);

        var titleSpan = li.getElementsByTagName("span");
        var titleText = chapterTitle(li);

        console.log("当前章节编号：" + index + ", 章节标题：" + titleText);
        logStatus("正在播放章节 #" + index + " - " + titleText);

        start();  // 开启 5 秒轮询
    }


    /**
     * 开始/设置定时器检查进度
     */
    function start() {
        console.log("播放检查/启动----");
        window.clearInterval(runIt);
        if (!running) return;
        applyPlaybackSettings();
        runIt = setInterval(next, 5000); // 每5秒检查一次
    }

        /**
     * 定时器触发函数：检查播放进度，进行下一节跳转
     */
        function next() {
        if (!running || isRefreshingPie) return;
        var video = getVideo();
        if (video) ensureMuted(video);
        if (!video || video.readyState === 0 ||
            (staleSource && (video.currentSrc || video.src) === staleSource)) {
            if (Date.now() - loadStartedAt > 90000) {
                stopAutomation('视频加载超过90秒，请检查登录、课程权限或网络后重新启动。');
            } else {
                logStatus('等待当前视频加载，不自动跳过。');
            }
            return;
        }
        staleSource = null;
        // 手动切章时停止，避免旧索引控制新页面。
        var active = document.querySelector('[id^="unit-item-"].is-active');
        if (active && lists[index] && active.id !== lists[index].id) {
            stopAutomation('检测到手动切换章节，已停止自动切换。');
            return;
        }
        speed(video);
        ensureMuted(video);
        if (replayFromStart) {
            try {
                video.currentTime = 0;
                replayFromStart = false;
            } catch (error) {
                logStatus('等待视频可重播：' + error.name);
                return;
            }
        }
        var c = video.currentTime;
        var d = video.duration;

        if (!isFinite(d) || d < 1) {
            if (Date.now() - loadStartedAt > 90000) {
                stopAutomation('视频时长持续无效，请检查播放器后重新启动。');
                return;
            }
            console.log("视频时长无效或仍在加载中，等待加载...");
            logStatus("视频时长未正确获取，等待加载中...");
            tryPlay(video);
            return;
        }

        tryPlay(video);

        var ratio = c / d;
        var percentText = (ratio * 100).toFixed(2) + "%";

        // ✅ 关键点：只要这一遍“看完了”，就触发刷新饼图的流程
        if (video.ended) {
            if (isRefreshingPie) return;

            isRefreshingPie = true;
            pendingCheckIndex = index;
            pendingChapterKey = chapterKey(lists[index]);

            console.log("本节视频完整播放结束，进度：" + percentText + "，准备切换章节刷新饼图...");
            logStatus("本节视频完整播放结束（" + percentText + "），切到其他章节刷新饼图，然后再看饼图是否满。");

            switchChapterForPieRefresh();
            return;
        }

        // 否则就是正常播放中，什么都不做
        console.log("视频正在播放中... 进度: " + percentText);
    }


    /**
     * 为了刷新当前章节的饼图：临时切换到别的章节
     */
    function switchChapterForPieRefresh() {
        lists = getChapterLists();
        // 优先真正点击下一个可学习视频；末节才用前一个视频刷新。
        var jumpIndex = -1;
        for (var i = index + 1; i < lists.length; i++) {
            if (!isLocked(lists[i])) { jumpIndex = i; break; }
        }
        if (jumpIndex === -1) {
            for (var j = index - 1; j >= 0; j--) {
                if (!isLocked(lists[j])) { jumpIndex = j; break; }
            }
        }
        if (jumpIndex === -1) {
            stopAutomation('视频已播完，但没有其他可点击的视频刷新饼图；完成状态待平台确认，请手动检查。');
            return;
        }
        progressBeforeRefresh = progressSignature(lists[index]);
        progressChangedAfterSwitch = false;
        refreshTargetKey = chapterKey(lists[jumpIndex]);
        refreshStartedAt = Date.now();
        selectChapter(chapterChildren(lists[jumpIndex])[0]);
        logStatus('已点击视频 #' + jumpIndex + '，等待平台刷新上一节饼图（最多30秒），暂不判定未完成。');
        refreshTimer = setTimeout(checkProgressAndMaybeGotoNext, 1000);
    }

    /**
     * 在“切到其它章节刷新饼图”之后，检查 pendingCheckIndex 那节的饼图
     * 如果饼图满 → 跳到下一未完成章节
     * 如果没满   → 切回去重播 pendingCheckIndex
     */
    var MAX_REPLAY_PER_CHAPTER = 3;

    function checkProgressAndMaybeGotoNext() {
        lists = getChapterLists();

        if (pendingCheckIndex == null) {
            isRefreshingPie = false;
            logStatus("没有 pendingCheckIndex，跳过饼图检查。");
            return;
        }

        if (!running) return;
        var idx = lists.findIndex(function(el) { return chapterKey(el) === pendingChapterKey; });
        if (idx < 0) {
            stopAutomation('目录已变化，无法定位待检查视频，请重新扫描后启动。');
            return;
        }
        var currentList = lists[idx];

        if (!currentList) {
            console.log("找不到 pending 章节节点，跳到下一个未完成章节。");
            logStatus("找不到 pending 章节节点，跳到下一个未完成章节。");
            isRefreshingPie = false;
            pendingCheckIndex = null;
            gotoNextUnfinished(idx);
            return;
        }

        var lis = chapterChildren(currentList);
        if (lis.length === 0) {
            console.log("pending 章节没有 li，跳到下一个未完成章节。");
            logStatus("pending 章节没有 li，跳到下一个未完成章节。");
            isRefreshingPie = false;
            pendingCheckIndex = null;
            gotoNextUnfinished(idx);
            return;
        }

        var currentLi = lis[0];
        var fullIcon = isComplete(currentLi);
        var active = document.querySelector('[id^="unit-item-"].is-active');
        var switched = !active || chapterKey(active) === refreshTargetKey;
        var elapsed = Date.now() - refreshStartedAt;
        if (!switched) {
            if (elapsed >= 30000) {
                stopAutomation('未能确认刷新用的视频已打开；上一节完成状态待确认，请检查页面后重新启动。');
            } else {
                refreshTimer = setTimeout(checkProgressAndMaybeGotoNext, 1000);
            }
            return;
        }
        if (progressSignature(currentLi) !== progressBeforeRefresh) progressChangedAfterSwitch = true;

        // ✅ 饼图满了：这一节彻底搞定，跳到下一个未完成视频
        if (fullIcon) {
            console.log("检测到章节 #" + idx + " 饼图已满，跳到下一个未完成章节。");
            logStatus("章节 #" + idx + " 饼图已满，开始下一节未完成视频。");
            replayCountMap[idx] = 0;
            isRefreshingPie = false;
            pendingCheckIndex = null;
            pendingChapterKey = null;
            var nextIdx = findNextUnfinished(idx);
            if (nextIdx !== -1 && chapterKey(lists[nextIdx]) === refreshTargetKey) {
                // 刷新时已点开下一节，不再点击一次以免重载/重置播放进度。
                index = nextIdx;
                refreshTargetKey = null;
                logStatus('上一节饼图已满，继续播放已打开的视频 #' + index + '。');
                start();
            } else {
                refreshTargetKey = null;
                gotoNextUnfinished(idx);
            }
            return;
        }

        if (elapsed < 30000) {
            var refreshVideo = getVideo();
            if (refreshVideo && refreshVideo.readyState > 0 &&
                (!staleSource || (refreshVideo.currentSrc || refreshVideo.src) !== staleSource)) tryPlay(refreshVideo);
            refreshTimer = setTimeout(checkProgressAndMaybeGotoNext, 1000);
            return;
        }
        if (!progressChangedAfterSwitch) {
            stopAutomation('已点击其他视频，但30秒内未观察到上一节饼图更新；完成状态待确认，已停止，避免按旧进度重复播放。');
            return;
        }
        refreshTargetKey = null;

        // ❌ 饼图没满：这一节需要再看一遍
        replayCountMap[idx] = (replayCountMap[idx] || 0) + 1;
        var times = replayCountMap[idx];

        console.log("章节 #" + idx + " 饼图仍未满，第 " + times + " 次重播。");
        logStatus("章节 #" + idx + " 饼图仍未满，第 " + times + " 次重播。");

        // 防止真的无限死循环（比如这节是互动题/课件，永远不会满）
        if (times > MAX_REPLAY_PER_CHAPTER) {
            console.log("本章节重播超过 " + MAX_REPLAY_PER_CHAPTER + " 次仍未满，跳到下一个未完成章节。");
            logStatus("章节 #" + idx + " 看了 " + MAX_REPLAY_PER_CHAPTER +
                      " 次饼图仍未满，可能需要你手动答题/操作，已自动跳过这一节。");
            isRefreshingPie = false;
            pendingCheckIndex = null;
            gotoNextUnfinished(idx);
            return;
        }

        // 重新回到这一节，从头播放
        index = idx;
        pendingCheckIndex = null;

        selectChapter(currentLi);
        replayFromStart = true;
        isRefreshingPie = false;
        start();
    }


    /**
     * 设置播放速度为2.0 (直接操作 video 元素)
     */
    function speed(video) {
        if (video && video.playbackRate !== 2.0) {
            video.playbackRate = 2.0;
            console.log("设置播放速度为 2.0 倍。");
        }
    }

    // --- 脚本启动入口 ---

    function main() {
        console.log("油猴脚本已启动，开始加载操作面板...");
        createPanel();
        // 新建/替换播放器、播放前均及时应用，包含临时切章刷新阶段。
        document.addEventListener('play', applyPlaybackSettings, true);
        document.addEventListener('loadedmetadata', applyPlaybackSettings, true);
        setInterval(applyPlaybackSettings, 500);
        logStatus("脚本已载入，正在识别未完成的章节...");
        function scan() {
            var path = location.pathname.split('/video/')[0].split('/article/')[0];
            if (coursePath && path !== coursePath) stopAutomation('课程页面已变化，已停止。');
            coursePath = path;
            var chapters = getChapterLists();
            var signature = path + chapters.map(function(el) {
                return chapterKey(el) + ':' + chapterTitle(el) + ':' + isComplete(el) + ':' + isLocked(el);
            }).join('|');
            if (signature !== chapterSignature) {
                if (running && lists && lists.map(chapterKey).join('|') !== chapters.map(chapterKey).join('|')) {
                    stopAutomation('视频目录已变化，请重新选择起点。');
                }
                chapterSignature = signature;
                populatePanel();
            }
        }
        scan();
        setInterval(scan, 2000);
    }

    setTimeout(main, 2000);
})();
