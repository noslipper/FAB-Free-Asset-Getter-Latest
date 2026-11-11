// ==UserScript==
// @name        FAB Free Asset Getter
// @namespace   https://greasyfork.org/en/users/313682-没拖鞋
// @version     3.8.2
// @description Bulk-import free FAB assets (whole free catalogue or one seller) into your library through the FAB API: streaming scan-and-import in adjustable batches, optional ownership check, resumable cursor. Fork of the original by subtixx.
// @author      noslipper
// @homepageURL https://greasyfork.org/zh-CN/scripts/534044-fab-free-asset-getter
// @downloadURL https://update.greasyfork.org/scripts/534044/FAB%20Free%20Asset%20Getter.user.js
// @updateURL   https://update.greasyfork.org/scripts/534044/FAB%20Free%20Asset%20Getter.meta.js
// @supportURL  https://github.com/noslipper/FAB-Free-Asset-Getter-Latest/issues
// @match       https://www.fab.com/*
// @grant       none
// @license     AGPL-3.0-or-later
// @icon        https://www.google.com/s2/favicons?sz=64&domain=fab.com
// ==/UserScript==

(function () {
    "use strict";

    /* ------------------------------------------------------------------
     * v3.2.0 — streaming pipeline
     *
     * v3.3.0 adds the bubble feed above the panel: every asset that lands in
     * the library pops up as a bubble, the newest one nearest the panel, older
     * ones cascading upward like a waterfall.
     *
     * v3.0 scanned the whole catalogue first and only then started importing,
     * so nothing happened for minutes and a paused run had nothing usable
     * queued. v3.2 flips the order: read a batch of listings, import that
     * batch, read the next one. Progress is visible immediately, a pause
     * leaves a ready-to-import queue, and the cursor is persisted so a
     * reload continues where it stopped.
     *
     * Data never comes from the DOM. The same endpoints the site uses:
     *
     *   GET  /i/listings/search?is_free=1[&sellers=..]&count=24&cursor=<c>
     *        -> { results: [{uid, title, startingPrice:{offerId, price}}], cursors:{next} }
     *   GET  /i/users/me/listings-states?listing_ids=...   (max 24 ids)
     *        -> [{uid, acquired, entitlementId}]
     *   GET  /i/listings/<uid>   -> { licenses: [{slug, offerId, priceTier}] }
     *   POST /i/listings/<uid>/add-to-library  (form offer_id) -> 204
     *
     * Every read runs with the user's own session: the anonymous index is not
     * the same catalogue the page is showing (it ignores or loosens some
     * facets), and it is the session that owns the library, so the scan and the
     * add-to-library call speak to the same account.
     * ------------------------------------------------------------------ */

    const BASE_HOST = "https://www.fab.com";
    const MEGASCAN_URL = BASE_HOST + "/search?sort_by=-firstPublishedAt&is_free=1&sellers=o-cbf5bbfdb340d6a839b5520cb31328";
    const UE_FREE_URL = BASE_HOST + "/search?sort_by=-firstPublishedAt&is_free=1";
    // Quixel Megascans mark (white on transparent), inlined so the button
    // never depends on a CDN URL.
    const QUIXEL_LOGO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAABS0lEQVR42t2UO07DUBBF79gpAkI0QOhSRRAoaGEpIFGxAvbAEpCQYAOIEhZAeqj5VBShSIkoCALFPhSMxZOxjZPQwFTjeTPH73NnpH9pQBT48W8ArQgExIBNCmwE35vAJdADtoJ4o/YPwkSgDRwDCV+WACdAu6imEgo0gX1g4LBRAM78gec06xzfgBZwxXe7AM4L4tfAclZf+vJA13c1AlLgDtgJ8raBW1/L8tby6ikCd4Bn380j0MrWg5wloO/3/QSs5sFRwa1YEH+VNHTJ8VlLLGko6cXz5iQleUg0ocRTSfOS+pJ2JT0AZmZpFRgvlKQZSbNmlvhJzP1FSUeSOmZ2Jgkzo7Jtaz7ePXAD7GVyK9XyFHLrAQulchujQcIuTIF3YL1UbmO0dAocAgfAm8dWfgSPOYQ2gFOgWwtcc2zGU8/oskEfduPftw/UR04OA/QiCgAAAABJRU5ErkJggg==";

    const CONFIG = {
        // Scope comes from the page URL: /search?is_free=1 scans the whole
        // free catalogue, /search?is_free=1&sellers=<id> scans that seller,
        // and any other search param (q, category, tags, ...) is carried over.
        forceFree: true,          // always ask the API for free listings
        sortBy: "-createdAt",
        pageSize: 24,             // /i/listings/search hard-caps at 24 per page
        stateChunkSize: 24,       // /i/users/me/listings-states hard-caps at 24 ids

        // Import batch: scan this many listings, import them, scan the next.
        batchSize: 100,
        batchMin: 1,
        batchMax: 5000,

        concurrency: 10,          // parallel add workers
        maxConcurrency: 12,
        minConcurrency: 3,
        indexConcurrency: 6,      // parallel ownership-state chunks
        preferProfessional: true,  // claim the professional tier when an asset offers one
        // 3000 pages x 24 listings covers the whole free catalogue (~47k).
        // The page counter persists, so a rerun continues where it stopped.
        maxPages: 3000,           // safety stop for one run
        // New listings land at the head of the newest-first index, so a run that
        // only resumes the saved cursor never sees them. Every run re-reads this
        // many pages from the head first, then jumps back to the saved cursor.
        headPages: 12,
        // The cart is a server-side object that the site has to render whole. A
        // very long cart has already made /i/cart hang and /cart answer 500, so
        // adding stops at this length and asks for a checkout instead.
        cartMax: 80,
        retries: 3,
        waveDelay: 45,            // ms of rest between two assets on the same worker
        waveJitter: 120,          // extra random spread so the burst stays polite
        cooldownEvery: 800,       // every N imported assets take a longer break
        cooldownMs: 3500,

        // Ownership check: "auto" detects whether the account hides assets
        // already in the library (Fab's "hide library items" preference).
        // When it does, search only returns unowned listings, so the extra
        // per-batch check is skipped. "on"/"off" force the behaviour.
        ownedCheck: "auto",

        // A bundle answers acquired=true the moment the account owns any single
        // listing inside it, so that flag alone cannot mean "you already own
        // this bundle". "auto" only trusts bundles that carry a real
        // entitlement; "on" trusts the flag blindly; "off" never skips one.
        bundleOwnedCheck: "auto"
    };

    const PANEL_ID = "fab-bfg-panel";
    const STORE_PREFIX = "fab_bfg_state_v3:";

    /* ------------------------------------------------------------------
     * i18n — the panel speaks whatever language the page is set to.
     *
     * The site publishes its locale two ways: <html lang> on every render and
     * an EPIC_LOCALE cookie. Those two are read in that order, then the
     * browser language. Locale codes follow the site's own language menu: ar,
     * de, en, es-ES, es-LA, fr, it, ja, ko, pl, pt-BR, ru, tr, zh-CN.
     * Unknown values fall back to English rather than to a guess.
     * ------------------------------------------------------------------ */
    const I18N = {
        "en": {
            logCheckoutNoScan: "Checkout page: nothing to scan here, start from a search page",
            cartEmptyNow: "Cart is empty — stale checkout records cleared",
            btnClearCart: "Clear cart",
            clearCartAsk: "Remove every item from the cart on fab.com? Items will have to be re-added.",
            clearCartDone: "Cart emptied.",
            clearCartFailed: "Could not clear the cart.",
            logCartFull: "The cart already holds {0} items — check out before adding more.",
            miniStats: "Scanned {0} · Added {1} · Skipped {2} · Failed {3} · {4}",
            tipCollapse: "Collapse the panel",
            tipExpand: "Expand the panel",
            logCartReconciled: "Cart check: {0} pending records are no longer in the cart, dropped",
            cartMiss: "Cart is empty but nothing new reached your library",
            cartBtn: "Checkout ({0})",
            cartAsk: "Added {0} free items to the cart — finish the checkout to collect them", cartWait: "Waiting for checkout · cart {0}", cartDone: "Checkout done · {0} added",
            loginOn: "Signed in as {0}", loginOff: "Not signed in",
            bundleNote: "{0} bundles need the cart (FAB rule)", doneAll: "All done · {0} added",

            navFree: "Free assets", navFreeTip: "Free assets of the Unreal Engine channel",
            name: "FAB Bulk Import",
            batch: "Batch", batchReset: "Reset batch to {0}",
            swScroll: "Follow cards", swFx: "Flip effect", onSuffix: " (on)", offSuffix: " (off)",
            start: "Start", pause: "Pause", resume: "Resume", importBtn: "Import({0})", stop: "Stop", clear: "Clear",
            ready: "Ready", idle: "idle",
            statusRunning: "Importing · added {0} · queue {1} · page {2}",
            statusScanning: "Scanning and importing…",
            statusAbortedUser: "Stopped", statusAbortedAuth: "Session expired",
            statusEnd: "Reached the end · added {0} · failed {1}",
            statusBatchEnd: "Batch done · added {0}",
            status401: "Session expired (401), please reload",
            statusRisk: "Site risk control suspected, retry later",
            statusError: "Error: {0}",
            statusManual: "Manual import {0} items",
            statusManualDone: "Manual import done · added {0} · failed {1}",
            statusPaused: "Paused · {0} queued, hit Import",
            statusResume: "Resuming…", statusStopped: "Stopped · {0} queued",
            counters: "Scanned {0} / Queue {1} / Added {2} / Skipped {3} / Failed {4}",
            meta: "Concurrency {0} · Batch {1} · {2}/s · page {3} · {4} elapsed",
            metaNoPage: "Concurrency {0} · Batch {1} · {2}/s",
            ownerOn: "Ownership check: on",
            ownerSkipped: "Ownership check: skipped (library items hidden)",
            scopePrefix: "Scope: {0}",
            scopeKeyword: "keyword", scopeSeller: "seller", scopeCategory: "category",
            scopeTag: "tags", scopeFormat: "format", scopeLicense: "license",
            scopeFreeOnly: "free only", scopeSort: "sort {0}", scopeChannel: "channel",
            scopeAll: "all free listings (newest first)", scopeNone: "free listings",
            logRestored: "Restored local state: cursor page {0} · {1} imported",
            logStoreFail: "Could not save local state: {0}",
            logThrottled: "Throttled (status={0}), concurrency down to {1}",
            logMaxPages: "Hit the per-run page cap ({0}), stopping here",
            logIndexFail: "Search request failed status={0}, retrying",
            logIndexFatal: "First index page failed status={0}",
            logEmptyPage: "Index returned no results (attempt {0}), cooling down",
            logEmptyFatal: "Search returned nothing, the site may be blocking — try later",
            logDupPages: "{0} pages without a single new asset — the index keeps repeating itself, treating it as the ceiling",
            logNoCursor: "Index returned no next cursor (attempt {0}), cooling down and lowering concurrency",
            logOwnedFail: "Ownership lookup failed: {0}",
            logOwnedShort: "Ownership lookup came back short ({0} items), treating the chunk as unowned",
            logHiddenOn: "“Hide library items” detected: skipping the ownership check",
            logHiddenSearch: "Search already excludes library items: skipping the ownership check",
            logKeepCheck: "Search still includes owned assets: keeping the ownership check",
            logDetectFail: "Ownership probe failed, keeping the check: {0}",
            logAddFail: "Import failed: {0}",
            logCooldown: "{0} imported, short cooldown",
            logAlreadyRunning: "Already running",
            logNoCsrf: "Missing CSRF token — reload the page and make sure you are signed in",
            logNoCsrfShort: "Missing CSRF token, reload the page",
            logNeedScanFirst: "Nothing queued — scan first",
            logNoManual: "Running already, no manual import needed",
            batchProgress: "This batch {0}/{1}",
            toastEnd: "Scan finished: {0} added, {1} failed",
            toastBatch: "Batch finished: {0} added",
            toastAbortUser: "Stopped: user request", toastAbortAuth: "Stopped: session expired",
            toast401: "Session expired, reload the page",
            toastRisk: "Site risk control suspected (try a smaller CONFIG.concurrency)",
            toastError: "Error: {0}",
            toastManualDone: "Manual import finished: {0} added",
            toastNoQueue: "Queue is empty — scan first",
            toastCsrf: "Missing CSRF token, reload the page and confirm you are signed in",
            unnamed: "(untitled asset)"
        },
        "zh-CN": {
            logCheckoutNoScan: "结账页不扫描，请回到搜索页开始",
            cartEmptyNow: "购物车是空的，已清除失效的待结账记录",
            btnClearCart: "清空购物车",
            clearCartAsk: "确定清空 fab.com 购物车里的全部条目吗？清空后需要重新加购。",
            clearCartDone: "购物车已清空。",
            clearCartFailed: "清空购物车失败。",
            logCartFull: "购物车已有 {0} 条待结账，请先结账再继续。",
            miniStats: "已扫描 {0} · 新增 {1} · 跳过 {2} · 失败 {3} · 用时 {4}",
            tipCollapse: "折叠面板",
            tipExpand: "展开面板",
            logCartReconciled: "购物车核对：{0} 条待结账记录已不在购物车，已清除",
            cartMiss: "购物车已空，但库里没有新增资产",
            cartBtn: "结账（{0}）",
            cartAsk: "已把 {0} 个免费合集加入购物车，请在打开的结账页完成验证", cartWait: "等待结账 · 购物车 {0} 件", cartDone: "结账完成 · 入库 {0} 件",
            loginOn: "已登录：{0}", loginOff: "未登录",
            bundleNote: "{0} 条合集需在页面加入购物车（FAB 限制）", doneAll: "全部完成 · 共入库 {0} 条",

            navFree: "免费资产", navFreeTip: "虚幻引擎频道 · 免费资产",
            name: "FAB 批量入库",
            batch: "批量", batchReset: "恢复默认批量 {0}",
            swScroll: "跟随卡片滚动", swFx: "入库特效", onSuffix: "（开）", offSuffix: "（关）",
            start: "开始入库", pause: "暂停", resume: "继续", importBtn: "入库({0})", stop: "停止", clear: "清空记录",
            ready: "就绪", idle: "空闲",
            statusRunning: "入库中 · 已入库 {0} · 队列 {1} · 第 {2} 页",
            statusScanning: "扫描并批量入库…",
            statusAbortedUser: "已停止", statusAbortedAuth: "登录态失效",
            statusEnd: "已扫到末尾 · 新增 {0} · 失败 {1}",
            statusBatchEnd: "本批结束 · 新增 {0}",
            status401: "登录态失效（401），请刷新页面后重试",
            statusRisk: "疑似触发站点风控，请稍后再试",
            statusError: "出错：{0}",
            statusManual: "手动入库 {0} 条",
            statusManualDone: "手动入库完成 · 新增 {0} · 失败 {1}",
            statusPaused: "已暂停 · 待入库 {0} 条，可点「入库」",
            statusResume: "继续…", statusStopped: "已停止 · 待入库 {0} 条",
            counters: "已扫描 {0} / 队列 {1} / 新增 {2} / 跳过 {3} / 失败 {4}",
            meta: "并发 {0} · 批量 {1} · {2} 条/s · 第 {3} 页 · 已用 {4}",
            metaNoPage: "并发 {0} · 批量 {1} · {2} 条/s",
            ownerOn: "归属检查：开启",
            ownerSkipped: "归属检查：已跳过（站点已隐藏库内资产）",
            scopePrefix: "扫描条件：{0}",
            scopeKeyword: "关键词", scopeSeller: "发行商", scopeCategory: "分类",
            scopeTag: "标签", scopeFormat: "格式", scopeLicense: "许可",
            scopeFreeOnly: "仅免费", scopeSort: "排序 {0}", scopeChannel: "频道",
            scopeAll: "全站免费目录（最新优先）", scopeNone: "免费资产",
            logRestored: "恢复本地记录：游标第 {0} 页 · 已入库 {1} 条",
            logStoreFail: "本地记录写入失败：{0}",
            logThrottled: "被限速（status={0}），并发降到 {1}",
            logMaxPages: "达到单次扫描上限 {0} 页，本次到此为止",
            logIndexFail: "索引页请求失败 status={0}，稍后重试",
            logIndexFatal: "首页索引失败 status={0}",
            logEmptyPage: "索引页返回空结果（第 {0} 次），限速嫌疑，冷却后再取",
            logEmptyFatal: "搜索接口返回空结果，疑似风控，请稍后再试",
            logDupPages: "连续 {0} 页无新资产，索引在重复返回同一批结果，判定到达可用上限",
            logNoCursor: "索引页未返回下一页游标（第 {0} 次），按限速处理，降并发后重取",
            logOwnedFail: "归属查询失败：{0}",
            logOwnedShort: "归属查询未返回完整结果（{0} 条），本批按未拥有处理",
            logHiddenOn: "检测到「不显示库内资产」已开启：跳过归属检查",
            logHiddenSearch: "检测到搜索结果已排除库内资产：跳过归属检查",
            logKeepCheck: "搜索仍包含已拥有资产：保留归属检查",
            logDetectFail: "归属检测失败，默认保留归属检查：{0}",
            logAddFail: "入库异常：{0}",
            logCooldown: "已入库 {0} 条，短暂冷却",
            logAlreadyRunning: "已在运行",
            logNoCsrf: "缺少 CSRF 令牌，请刷新页面并确认已登录",
            logNoCsrfShort: "缺少 CSRF 令牌，请刷新页面",
            logNeedScanFirst: "队列里没有待入库资产，请先扫描",
            logNoManual: "运行中，无需手动入库",
            batchProgress: "本批入库 {0}/{1}",
            toastEnd: "扫描结束：新增 {0} 条，失败 {1} 条",
            toastBatch: "本批结束：新增 {0} 条",
            toastAbortUser: "已中止：用户停止", toastAbortAuth: "已中止：登录态失效",
            toast401: "登录态失效，请刷新页面",
            toastRisk: "疑似触发站点风控（可把 CONFIG.concurrency 调小）",
            toastError: "出错：{0}",
            toastManualDone: "手动入库完成：新增 {0} 条",
            toastNoQueue: "队列里没有待入库资产，请先扫描",
            toastCsrf: "缺少 CSRF 令牌，请刷新页面并确认已登录",
            unnamed: "(未命名资产)"
        },
        "zh-TW": {
            logCheckoutNoScan: "結帳頁不掃描，請回到搜尋頁開始",
            cartEmptyNow: "購物車是空的，已清除失效的待結帳紀錄",
            btnClearCart: "清空購物車",
            clearCartAsk: "確定清空 fab.com 購物車中的全部項目嗎？清空後需重新加入。",
            clearCartDone: "購物車已清空。",
            clearCartFailed: "清空購物車失敗。",
            logCartFull: "購物車已有 {0} 條待結帳，請先結帳再繼續。",
            miniStats: "已掃描 {0} · 新增 {1} · 跳過 {2} · 失敗 {3} · 已用 {4}",
            tipCollapse: "收合面板",
            tipExpand: "展開面板",
            logCartReconciled: "購物車核對：{0} 筆待結帳紀錄已不在購物車，已清除",
            cartMiss: "購物車已空，但庫中沒有新增資產",
            cartBtn: "結帳（{0}）",
            cartAsk: "已把 {0} 個免費合集加入購物車，請在開啟的結帳頁完成驗證", cartWait: "等待結帳 · 購物車 {0} 件", cartDone: "結帳完成 · 入庫 {0} 件",
            loginOn: "已登入：{0}", loginOff: "未登入",
            bundleNote: "{0} 個合集需在頁面加入購物車（FAB 限制）", doneAll: "全部完成 · 共入庫 {0} 項",

            navFree: "免費資產", navFreeTip: "虛幻引擎頻道 · 免費資產",
            name: "FAB 批次入庫",
            batch: "批次", batchReset: "恢復預設批次 {0}",
            swScroll: "跟隨卡片捲動", swFx: "入庫特效", onSuffix: "（開）", offSuffix: "（關）",
            start: "開始入庫", pause: "暫停", resume: "繼續", importBtn: "入庫({0})", stop: "停止", clear: "清除紀錄",
            ready: "就緒", idle: "閒置",
            statusRunning: "入庫中 · 已入庫 {0} · 佇列 {1} · 第 {2} 頁",
            statusScanning: "掃描並批次入庫…",
            statusAbortedUser: "已停止", statusAbortedAuth: "登入狀態失效",
            statusEnd: "已掃到結尾 · 新增 {0} · 失敗 {1}",
            statusBatchEnd: "本批次結束 · 新增 {0}",
            status401: "登入狀態失效（401），請重新整理頁面",
            statusRisk: "疑似觸發站點風控，請稍後再試",
            statusError: "發生錯誤：{0}",
            statusManual: "手動入庫 {0} 筆",
            statusManualDone: "手動入庫完成 · 新增 {0} · 失敗 {1}",
            statusPaused: "已暫停 · 待入庫 {0} 筆，可點「入庫」",
            statusResume: "繼續…", statusStopped: "已停止 · 待入庫 {0} 筆",
            counters: "已掃描 {0} / 佇列 {1} / 新增 {2} / 跳過 {3} / 失敗 {4}",
            meta: "併發 {0} · 批次 {1} · {2} 筆/秒 · 第 {3} 頁 · 已用 {4}",
            metaNoPage: "併發 {0} · 批次 {1} · {2} 筆/秒",
            ownerOn: "歸屬檢查：開啟",
            ownerSkipped: "歸屬檢查：已跳過（站點已隱藏庫內資產）",
            scopePrefix: "掃描條件：{0}",
            scopeKeyword: "關鍵字", scopeSeller: "發行商", scopeCategory: "分類",
            scopeTag: "標籤", scopeFormat: "格式", scopeLicense: "授權",
            scopeFreeOnly: "僅免費", scopeSort: "排序 {0}", scopeChannel: "頻道",
            scopeAll: "全站免費目錄（最新優先）", scopeNone: "免費資產",
            logRestored: "恢復本機紀錄：游標第 {0} 頁 · 已入庫 {1} 筆",
            logStoreFail: "本機紀錄寫入失敗：{0}",
            logThrottled: "被限速（status={0}），併發降到 {1}",
            logMaxPages: "達到單次掃描上限 {0} 頁，本次到此為止",
            logIndexFail: "索引頁請求失敗 status={0}，稍後重試",
            logIndexFatal: "首頁索引失敗 status={0}",
            logEmptyPage: "索引頁回傳空結果（第 {0} 次），疑似限速，冷卻後再取",
            logEmptyFatal: "搜尋介面回傳空結果，疑似風控，請稍後再試",
            logDupPages: "連續 {0} 頁無新資產，索引重複回傳同一批結果，判定到達可用上限",
            logNoCursor: "索引頁未回傳下一頁游標（第 {0} 次），依限速處理，降併發後重取",
            logOwnedFail: "歸屬查詢失敗：{0}",
            logOwnedShort: "歸屬查詢未回傳完整結果（{0} 筆），本批視為未擁有",
            logHiddenOn: "偵測到「不顯示庫內資產」已開啟：跳過歸屬檢查",
            logHiddenSearch: "偵測到搜尋結果已排除庫內資產：跳過歸屬檢查",
            logKeepCheck: "搜尋仍包含已擁有資產：保留歸屬檢查",
            logDetectFail: "歸屬偵測失敗，預設保留歸屬檢查：{0}",
            logAddFail: "入庫異常：{0}",
            logCooldown: "已入庫 {0} 筆，短暫冷卻",
            logAlreadyRunning: "已在執行",
            logNoCsrf: "缺少 CSRF 權杖，請重新整理頁面並確認已登入",
            logNoCsrfShort: "缺少 CSRF 權杖，請重新整理頁面",
            logNeedScanFirst: "佇列沒有待入庫資產，請先掃描",
            logNoManual: "執行中，無需手動入庫",
            batchProgress: "本批入庫 {0}/{1}",
            toastEnd: "掃描結束：新增 {0} 筆，失敗 {1} 筆",
            toastBatch: "本批次結束：新增 {0} 筆",
            toastAbortUser: "已中止：使用者停止", toastAbortAuth: "已中止：登入狀態失效",
            toast401: "登入狀態失效，請重新整理頁面",
            toastRisk: "疑似觸發站點風控（可調小 CONFIG.concurrency）",
            toastError: "發生錯誤：{0}",
            toastManualDone: "手動入庫完成：新增 {0} 筆",
            toastNoQueue: "佇列沒有待入庫資產，請先掃描",
            toastCsrf: "缺少 CSRF 權杖，請重新整理頁面並確認已登入",
            unnamed: "(未命名資產)"
        },
        "ja": {
            logCheckoutNoScan: "決済ページではスキャンしません。検索ページから開始してください",
            cartEmptyNow: "カートは空です — 無効な決済記録を削除しました",
            btnClearCart: "カートを空にする",
            clearCartAsk: "fab.com のカートをすべて空にしますか？再度追加が必要になります。",
            clearCartDone: "カートを空にしました。",
            clearCartFailed: "カートを空にできませんでした。",
            logCartFull: "カートに {0} 件あります。先に購入手続きをしてください。",
            miniStats: "走査 {0} · 追加 {1} · スキップ {2} · 失敗 {3} · {4}",
            tipCollapse: "パネルを折りたたむ",
            tipExpand: "パネルを展開",
            logCartReconciled: "カート確認：{0} 件の保留記録がカートにないため削除しました",
            cartMiss: "カートは空ですが、ライブラリに追加されたものはありません",
            cartBtn: "決済（{0}）",
            cartAsk: "無料の商品 {0} 件をカートに入れました。開いた決済ページで確認を完了してください", cartWait: "決済待ち · カート {0} 件", cartDone: "決済完了 · {0} 件追加",
            loginOn: "{0} でログイン中", loginOff: "未ログイン",
            bundleNote: "{0} 件のバンドルはカートでの取得が必要（FAB の仕様）", doneAll: "すべて完了 · {0} 件追加",

            navFree: "無料アセット", navFreeTip: "Unreal Engine チャンネルの無料アセット",
            name: "FAB 一括インポート",
            batch: "バッチ", batchReset: "バッチを既定値 {0} に戻す",
            swScroll: "カード追従", swFx: "演出効果", onSuffix: "（オン）", offSuffix: "（オフ）",
            start: "開始", pause: "一時停止", resume: "再開", importBtn: "インポート({0})", stop: "停止", clear: "記録を消去",
            ready: "準備完了", idle: "待機",
            statusRunning: "取り込み中 · {0} 件追加 · キュー {1} · {2} ページ",
            statusScanning: "スキャンして取り込み中…",
            statusAbortedUser: "停止しました", statusAbortedAuth: "ログイン切れ",
            statusEnd: "末尾まで到達 · 追加 {0} · 失敗 {1}",
            statusBatchEnd: "このバッチ完了 · 追加 {0}",
            status401: "ログインが切れました（401）。再読み込みしてください",
            statusRisk: "サイト側の制限の可能性があります。時間をおいて再試行してください",
            statusError: "エラー：{0}",
            statusManual: "手動インポート {0} 件",
            statusManualDone: "手動インポート完了 · 追加 {0} · 失敗 {1}",
            statusPaused: "一時停止 · {0} 件待ち。「インポート」を押せます",
            statusResume: "再開中…", statusStopped: "停止 · {0} 件待ち",
            counters: "走査 {0} / キュー {1} / 追加 {2} / スキップ {3} / 失敗 {4}",
            meta: "並列 {0} · バッチ {1} · {2} 件/秒 · {3} ページ · 経過 {4}",
            metaNoPage: "並列 {0} · バッチ {1} · {2} 件/秒",
            ownerOn: "所有チェック：オン",
            ownerSkipped: "所有チェック：省略（ライブラリ内を非表示に設定済み）",
            scopePrefix: "走査条件：{0}",
            scopeKeyword: "キーワード", scopeSeller: "販売者", scopeCategory: "カテゴリ",
            scopeTag: "タグ", scopeFormat: "形式", scopeLicense: "ライセンス",
            scopeFreeOnly: "無料のみ", scopeSort: "並び {0}", scopeChannel: "チャンネル",
            scopeAll: "無料カタログ全体（新しい順）", scopeNone: "無料アセット",
            logRestored: "ローカル記録を復元：カーソル {0} ページ · {1} 件取り込み済み",
            logStoreFail: "ローカル記録の保存に失敗：{0}",
            logThrottled: "制限されています（status={0}）。並列を {1} に下げました",
            logMaxPages: "1 回の走査上限 {0} ページに達しました",
            logIndexFail: "検索リクエスト失敗 status={0}。後で再試行します",
            logIndexFatal: "最初の索引ページが失敗 status={0}",
            logEmptyPage: "索引が空でした（{0} 回目）。制限の可能性があるため冷却します",
            logEmptyFatal: "検索が空を返しました。サイト側の制限の可能性があります",
            logDupPages: "{0} ページ連続で新規なし。索引が同じ結果を繰り返しているため上限と判断します",
            logNoCursor: "次ページのカーソルがありません（{0} 回目）。制限とみなし冷却します",
            logOwnedFail: "所有確認に失敗：{0}",
            logOwnedShort: "所有確認の結果が不足（{0} 件）。未所有として扱います",
            logHiddenOn: "「ライブラリ内を非表示」を検出：所有チェックを省略します",
            logHiddenSearch: "検索結果からライブラリ内が除外済み：所有チェックを省略します",
            logKeepCheck: "検索に所有済みが含まれています：所有チェックを継続します",
            logDetectFail: "所有判定に失敗。既定でチェックを継続します：{0}",
            logAddFail: "インポート失敗：{0}",
            logCooldown: "{0} 件取り込み。少し冷却します",
            logAlreadyRunning: "実行中です",
            logNoCsrf: "CSRF トークンがありません。再読み込みしてログインを確認してください",
            logNoCsrfShort: "CSRF トークンがありません。再読み込みしてください",
            logNeedScanFirst: "キューが空です。先に走査してください",
            logNoManual: "実行中のため手動インポートは不要です",
            batchProgress: "このバッチ {0}/{1}",
            toastEnd: "走査終了：追加 {0} 件、失敗 {1} 件",
            toastBatch: "バッチ終了：追加 {0} 件",
            toastAbortUser: "中止：ユーザーによる停止", toastAbortAuth: "中止：ログイン切れ",
            toast401: "ログインが切れました。再読み込みしてください",
            toastRisk: "サイト側の制限の可能性（CONFIG.concurrency を下げてみてください）",
            toastError: "エラー：{0}",
            toastManualDone: "手動インポート完了：追加 {0} 件",
            toastNoQueue: "キューが空です。先に走査してください",
            toastCsrf: "CSRF トークンがありません。再読み込みしてログインを確認してください",
            unnamed: "（名称未設定のアセット）"
        },
        "ko": {
            logCheckoutNoScan: "결제 페이지에서는 스캔하지 않습니다. 검색 페이지에서 시작하세요",
            cartEmptyNow: "장바구니가 비어 있습니다 — 만료된 결제 기록을 정리했습니다",
            btnClearCart: "장바구니 비우기",
            clearCartAsk: "fab.com 장바구니를 모두 비우시겠습니까? 다시 추가해야 합니다.",
            clearCartDone: "장바구니를 비웠습니다.",
            clearCartFailed: "장바구니를 비우지 못했습니다.",
            logCartFull: "장바구니에 {0}개가 있습니다. 먼저 결제를 완료하세요.",
            miniStats: "스캔 {0} · 추가 {1} · 건너뜀 {2} · 실패 {3} · {4}",
            tipCollapse: "패널 접기",
            tipExpand: "패널 펼치기",
            logCartReconciled: "장바구니 확인: {0}건의 대기 기록이 장바구니에 없어 삭제했습니다",
            cartMiss: "장바구니는 비었지만 라이브러리에 추가된 항목이 없습니다",
            cartBtn: "결제 ({0})",
            cartAsk: "무료 항목 {0}개를 장바구니에 담았습니다. 열린 결제 페이지에서 인증을 완료하세요", cartWait: "결제 대기 · 장바구니 {0}개", cartDone: "결제 완료 · {0}개 추가",
            loginOn: "{0} 로 로그인됨", loginOff: "로그인되지 않음",
            bundleNote: "{0}개 번들은 장바구니가 필요합니다(FAB 규칙)", doneAll: "모두 완료 · {0}개 추가",

            navFree: "무료 에셋", navFreeTip: "언리얼 엔진 채널의 무료 에셋",
            name: "FAB 일괄 가져오기",
            batch: "배치", batchReset: "배치를 기본값 {0}으로 복원",
            swScroll: "카드 따라가기", swFx: "가져오기 효과", onSuffix: " (켜짐)", offSuffix: " (꺼짐)",
            start: "시작", pause: "일시정지", resume: "계속", importBtn: "가져오기({0})", stop: "중지", clear: "기록 지우기",
            ready: "준비됨", idle: "대기",
            statusRunning: "가져오는 중 · 추가 {0} · 대기열 {1} · {2} 페이지",
            statusScanning: "스캔하며 가져오는 중…",
            statusAbortedUser: "중지됨", statusAbortedAuth: "로그인 만료",
            statusEnd: "마지막까지 도달 · 추가 {0} · 실패 {1}",
            statusBatchEnd: "이번 배치 완료 · 추가 {0}",
            status401: "로그인이 만료되었습니다(401). 페이지를 새로고침하세요",
            statusRisk: "사이트 제한이 의심됩니다. 잠시 후 다시 시도하세요",
            statusError: "오류: {0}",
            statusManual: "수동 가져오기 {0}개",
            statusManualDone: "수동 가져오기 완료 · 추가 {0} · 실패 {1}",
            statusPaused: "일시정지 · {0}개 대기, ‘가져오기’를 누르세요",
            statusResume: "계속 중…", statusStopped: "중지됨 · {0}개 대기",
            counters: "스캔 {0} / 대기열 {1} / 추가 {2} / 건너뜀 {3} / 실패 {4}",
            meta: "동시 {0} · 배치 {1} · {2}개/초 · {3} 페이지 · 경과 {4}",
            metaNoPage: "동시 {0} · 배치 {1} · {2}개/초",
            ownerOn: "보유 확인: 켜짐",
            ownerSkipped: "보유 확인: 건너뜀 (라이브러리 항목 숨김 설정됨)",
            scopePrefix: "스캔 조건: {0}",
            scopeKeyword: "키워드", scopeSeller: "판매자", scopeCategory: "카테고리",
            scopeTag: "태그", scopeFormat: "형식", scopeLicense: "라이선스",
            scopeFreeOnly: "무료만", scopeSort: "정렬 {0}", scopeChannel: "채널",
            scopeAll: "무료 카탈로그 전체(최신순)", scopeNone: "무료 자산",
            logRestored: "로컬 기록 복원: 커서 {0} 페이지 · {1}개 가져옴",
            logStoreFail: "로컬 기록 저장 실패: {0}",
            logThrottled: "속도 제한(status={0}), 동시를 {1}로 낮춤",
            logMaxPages: "1회 스캔 상한 {0} 페이지 도달, 여기서 종료",
            logIndexFail: "검색 요청 실패 status={0}, 잠시 후 재시도",
            logIndexFatal: "첫 인덱스 페이지 실패 status={0}",
            logEmptyPage: "인덱스가 빈 결과({0}회차), 제한 의심되어 냉각합니다",
            logEmptyFatal: "검색이 빈 결과를 반환했습니다. 사이트 제한일 수 있습니다",
            logDupPages: "{0} 페이지 연속 새 자산 없음. 인덱스가 같은 결과를 반복해 상한으로 판단",
            logNoCursor: "다음 페이지 커서 없음({0}회차). 제한으로 보고 동시를 낮춰 재시도",
            logOwnedFail: "보유 조회 실패: {0}",
            logOwnedShort: "보유 조회 결과 부족({0}개). 미보유로 처리",
            logHiddenOn: "‘라이브러리 항목 숨김’ 감지: 보유 확인 생략",
            logHiddenSearch: "검색에서 라이브러리 항목이 이미 제외됨: 보유 확인 생략",
            logKeepCheck: "검색에 보유 자산이 남아 있음: 보유 확인 유지",
            logDetectFail: "보유 판별 실패, 기본값으로 확인 유지: {0}",
            logAddFail: "가져오기 오류: {0}",
            logCooldown: "{0}개 가져옴, 잠시 냉각",
            logAlreadyRunning: "이미 실행 중",
            logNoCsrf: "CSRF 토큰이 없습니다. 새로고침 후 로그인을 확인하세요",
            logNoCsrfShort: "CSRF 토큰이 없습니다. 페이지를 새로고침하세요",
            logNeedScanFirst: "대기열이 비었습니다. 먼저 스캔하세요",
            logNoManual: "실행 중이라 수동 가져오기가 필요 없습니다",
            batchProgress: "이번 배치 {0}/{1}",
            toastEnd: "스캔 종료: 추가 {0}개, 실패 {1}개",
            toastBatch: "배치 종료: 추가 {0}개",
            toastAbortUser: "중단: 사용자 중지", toastAbortAuth: "중단: 로그인 만료",
            toast401: "로그인이 만료되었습니다. 페이지를 새로고침하세요",
            toastRisk: "사이트 제한이 의심됩니다 (CONFIG.concurrency를 낮춰보세요)",
            toastError: "오류: {0}",
            toastManualDone: "수동 가져오기 완료: 추가 {0}개",
            toastNoQueue: "대기열이 비었습니다. 먼저 스캔하세요",
            toastCsrf: "CSRF 토큰이 없습니다. 새로고침 후 로그인을 확인하세요",
            unnamed: "(이름 없는 자산)"
        },
        "de": {
            logCheckoutNoScan: "Bezahlseite wird nicht gescannt, bitte auf einer Suchseite starten",
            cartEmptyNow: "Warenkorb ist leer — veraltete Checkout-Einträge entfernt",
            btnClearCart: "Warenkorb leeren",
            clearCartAsk: "Alle Artikel im Warenkorb von fab.com entfernen? Sie müssen erneut hinzugefügt werden.",
            clearCartDone: "Warenkorb geleert.",
            clearCartFailed: "Warenkorb konnte nicht geleert werden.",
            logCartFull: "Im Warenkorb liegen bereits {0} Artikel. Bitte zuerst zur Kasse gehen.",
            miniStats: "Gescannt {0} · Hinzugefügt {1} · Übersprungen {2} · Fehler {3} · {4}",
            tipCollapse: "Panel einklappen",
            tipExpand: "Panel ausklappen",
            logCartReconciled: "Warenkorb-Prüfung: {0} offene Einträge sind nicht mehr im Warenkorb, entfernt",
            cartMiss: "Warenkorb leer, aber nichts Neues in der Bibliothek",
            cartBtn: "Bezahlen ({0})",
            cartAsk: "{0} kostenlose Artikel in den Warenkorb gelegt — schließe die Bestellung auf der geöffneten Seite ab", cartWait: "Warte auf die Bestellung · Warenkorb {0}", cartDone: "Bestellung abgeschlossen · {0} hinzugefügt",
            loginOn: "Angemeldet als {0}", loginOff: "Nicht angemeldet",
            bundleNote: "{0} Bundles erfordern den Warenkorb (FAB-Regel)", doneAll: "Alles erledigt · {0} hinzugefügt",

            navFree: "Gratis-Assets", navFreeTip: "Kostenlose Assets im Unreal-Engine-Kanal",
            name: "FAB Massenimport",
            batch: "Stapel", batchReset: "Stapel auf {0} zurücksetzen",
            swScroll: "Karten folgen", swFx: "Import-Effekt", onSuffix: " (an)", offSuffix: " (aus)",
            start: "Start", pause: "Pause", resume: "Weiter", importBtn: "Import({0})", stop: "Stopp", clear: "Löschen",
            ready: "Bereit", idle: "Leerlauf",
            statusRunning: "Import läuft · {0} hinzugefügt · Warteschlange {1} · Seite {2}",
            statusScanning: "Scannen und importieren…",
            statusAbortedUser: "Angehalten", statusAbortedAuth: "Sitzung abgelaufen",
            statusEnd: "Ende erreicht · {0} hinzugefügt · {1} fehlgeschlagen",
            statusBatchEnd: "Stapel fertig · {0} hinzugefügt",
            status401: "Sitzung abgelaufen (401), bitte neu laden",
            statusRisk: "Mögliche Ratenbegrenzung der Seite, später erneut versuchen",
            statusError: "Fehler: {0}",
            statusManual: "Manueller Import {0} Objekte",
            statusManualDone: "Manueller Import fertig · {0} hinzugefügt · {1} fehlgeschlagen",
            statusPaused: "Pausiert · {0} in der Warteschlange, „Import“ drücken",
            statusResume: "Weiter…", statusStopped: "Angehalten · {0} in der Warteschlange",
            counters: "Gescannt {0} / Warteschlange {1} / Hinzugefügt {2} / Übersprungen {3} / Fehler {4}",
            meta: "Parallel {0} · Stapel {1} · {2}/s · Seite {3} · {4} vergangen",
            metaNoPage: "Parallel {0} · Stapel {1} · {2}/s",
            ownerOn: "Besitzprüfung: an",
            ownerSkipped: "Besitzprüfung: übersprungen (Bibliothek ausgeblendet)",
            scopePrefix: "Bereich: {0}",
            scopeKeyword: "Stichwort", scopeSeller: "Anbieter", scopeCategory: "Kategorie",
            scopeTag: "Tags", scopeFormat: "Format", scopeLicense: "Lizenz",
            scopeFreeOnly: "nur kostenlos", scopeSort: "Sortierung {0}", scopeChannel: "Kanal",
            scopeAll: "gesamter kostenloser Katalog (neueste zuerst)", scopeNone: "kostenlose Assets",
            logRestored: "Lokaler Stand wiederhergestellt: Cursor Seite {0} · {1} importiert",
            logStoreFail: "Lokaler Stand nicht speicherbar: {0}",
            logThrottled: "Gedrosselt (status={0}), Parallelität auf {1} gesenkt",
            logMaxPages: "Seitenlimit pro Lauf ({0}) erreicht, hier beendet",
            logIndexFail: "Suchanfrage fehlgeschlagen status={0}, später erneut",
            logIndexFatal: "Erste Indexseite fehlgeschlagen status={0}",
            logEmptyPage: "Index lieferte kein Ergebnis (Versuch {0}), abkühlen",
            logEmptyFatal: "Suche lieferte nichts, evtl. blockiert die Seite — später erneut",
            logDupPages: "{0} Seiten ohne neues Asset — der Index wiederholt sich, gilt als Obergrenze",
            logNoCursor: "Kein Cursor für die nächste Seite (Versuch {0}), abkühlen und Parallelität senken",
            logOwnedFail: "Besitzabfrage fehlgeschlagen: {0}",
            logOwnedShort: "Besitzabfrage unvollständig ({0} Objekte), gilt als nicht besessen",
            logHiddenOn: "„Bibliothek ausblenden“ erkannt: Besitzprüfung wird übersprungen",
            logHiddenSearch: "Suche schließt Bibliothek schon aus: Besitzprüfung wird übersprungen",
            logKeepCheck: "Suche enthält noch besessene Assets: Besitzprüfung bleibt aktiv",
            logDetectFail: "Besitzprüfung fehlgeschlagen, bleibt aktiv: {0}",
            logAddFail: "Import fehlgeschlagen: {0}",
            logCooldown: "{0} importiert, kurze Pause",
            logAlreadyRunning: "Läuft bereits",
            logNoCsrf: "CSRF-Token fehlt — Seite neu laden und Anmeldung prüfen",
            logNoCsrfShort: "CSRF-Token fehlt, Seite neu laden",
            logNeedScanFirst: "Warteschlange leer — zuerst scannen",
            logNoManual: "Läuft bereits, kein manueller Import nötig",
            batchProgress: "Dieser Stapel {0}/{1}",
            toastEnd: "Scan fertig: {0} hinzugefügt, {1} fehlgeschlagen",
            toastBatch: "Stapel fertig: {0} hinzugefügt",
            toastAbortUser: "Abgebrochen: Benutzer-Stopp", toastAbortAuth: "Abgebrochen: Sitzung abgelaufen",
            toast401: "Sitzung abgelaufen, Seite neu laden",
            toastRisk: "Ratenbegrenzung vermutet (CONFIG.concurrency verkleinern)",
            toastError: "Fehler: {0}",
            toastManualDone: "Manueller Import fertig: {0} hinzugefügt",
            toastNoQueue: "Warteschlange leer — zuerst scannen",
            toastCsrf: "CSRF-Token fehlt, Seite neu laden und Anmeldung prüfen",
            unnamed: "(unbenanntes Asset)"
        },
        "fr": {
            logCheckoutNoScan: "La page de paiement n'est pas analysée, lancez depuis une page de recherche",
            cartEmptyNow: "Panier vide — les entrées de paiement obsolètes ont été supprimées",
            btnClearCart: "Vider le panier",
            clearCartAsk: "Retirer tous les articles du panier fab.com ? Ils devront être ajoutés à nouveau.",
            clearCartDone: "Panier vidé.",
            clearCartFailed: "Impossible de vider le panier.",
            logCartFull: "Le panier contient déjà {0} articles. Passez d'abord à la caisse.",
            miniStats: "Analysés {0} · Ajoutés {1} · Ignorés {2} · Échecs {3} · {4}",
            tipCollapse: "Replier le panneau",
            tipExpand: "Déplier le panneau",
            logCartReconciled: "Vérification du panier : {0} entrées en attente ne sont plus dans le panier, supprimées",
            cartMiss: "Panier vide, mais rien de nouveau dans la bibliothèque",
            cartBtn: "Commander ({0})",
            cartAsk: "{0} articles gratuits ajoutés au panier — termine la commande sur la page ouverte", cartWait: "En attente de la commande · panier {0}", cartDone: "Commande terminée · {0} ajoutés",
            loginOn: "Connecté en tant que {0}", loginOff: "Non connecté",
            bundleNote: "{0} bundles passent par le panier (règle FAB)", doneAll: "Terminé · {0} ajoutés",

            navFree: "Gratuit", navFreeTip: "Ressources gratuites du canal Unreal Engine",
            name: "Import groupé FAB",
            batch: "Lot", batchReset: "Réinitialiser le lot à {0}",
            swScroll: "Suivre les cartes", swFx: "Effet d'import", onSuffix: " (activé)", offSuffix: " (désactivé)",
            start: "Démarrer", pause: "Pause", resume: "Reprendre", importBtn: "Importer({0})", stop: "Arrêter", clear: "Effacer",
            ready: "Prêt", idle: "inactif",
            statusRunning: "Import en cours · {0} ajoutés · file {1} · page {2}",
            statusScanning: "Analyse et import…",
            statusAbortedUser: "Arrêté", statusAbortedAuth: "Session expirée",
            statusEnd: "Fin atteinte · {0} ajoutés · {1} échecs",
            statusBatchEnd: "Lot terminé · {0} ajoutés",
            status401: "Session expirée (401), rechargez la page",
            statusRisk: "Limitation du site probable, réessayez plus tard",
            statusError: "Erreur : {0}",
            statusManual: "Import manuel {0} éléments",
            statusManualDone: "Import manuel terminé · {0} ajoutés · {1} échecs",
            statusPaused: "En pause · {0} en file, cliquez sur Importer",
            statusResume: "Reprise…", statusStopped: "Arrêté · {0} en file",
            counters: "Analysés {0} / File {1} / Ajoutés {2} / Ignorés {3} / Échecs {4}",
            meta: "Parallélisme {0} · Lot {1} · {2}/s · page {3} · {4} écoulé",
            metaNoPage: "Parallélisme {0} · Lot {1} · {2}/s",
            ownerOn: "Vérification de possession : activée",
            ownerSkipped: "Vérification de possession : ignorée (bibliothèque masquée)",
            scopePrefix: "Périmètre : {0}",
            scopeKeyword: "mot-clé", scopeSeller: "vendeur", scopeCategory: "catégorie",
            scopeTag: "tags", scopeFormat: "format", scopeLicense: "licence",
            scopeFreeOnly: "gratuit uniquement", scopeSort: "tri {0}", scopeChannel: "canal",
            scopeAll: "tout le catalogue gratuit (plus récents d'abord)", scopeNone: "assets gratuits",
            logRestored: "État local restauré : curseur page {0} · {1} importés",
            logStoreFail: "Échec d'enregistrement local : {0}",
            logThrottled: "Limité (status={0}), parallélisme réduit à {1}",
            logMaxPages: "Limite de pages par exécution ({0}) atteinte, arrêt ici",
            logIndexFail: "Requête de recherche échouée status={0}, nouvelle tentative",
            logIndexFatal: "Première page d'index échouée status={0}",
            logEmptyPage: "Index vide (tentative {0}), pause de refroidissement",
            logEmptyFatal: "La recherche ne renvoie rien, le site bloque peut-être — réessayez plus tard",
            logDupPages: "{0} pages sans nouvel asset — l'index se répète, plafond atteint",
            logNoCursor: "Pas de curseur suivant (tentative {0}), refroidissement et baisse du parallélisme",
            logOwnedFail: "Échec de la vérification de possession : {0}",
            logOwnedShort: "Vérification incomplète ({0} éléments), traités comme non possédés",
            logHiddenOn: "« Masquer la bibliothèque » détecté : vérification ignorée",
            logHiddenSearch: "La recherche exclut déjà la bibliothèque : vérification ignorée",
            logKeepCheck: "La recherche inclut encore des assets possédés : vérification maintenue",
            logDetectFail: "Détection échouée, vérification maintenue : {0}",
            logAddFail: "Échec d'import : {0}",
            logCooldown: "{0} importés, courte pause",
            logAlreadyRunning: "Déjà en cours",
            logNoCsrf: "Jeton CSRF manquant — rechargez la page et vérifiez la connexion",
            logNoCsrfShort: "Jeton CSRF manquant, rechargez la page",
            logNeedScanFirst: "File vide — analysez d'abord",
            logNoManual: "Déjà en cours, aucun import manuel nécessaire",
            batchProgress: "Ce lot {0}/{1}",
            toastEnd: "Analyse terminée : {0} ajoutés, {1} échecs",
            toastBatch: "Lot terminé : {0} ajoutés",
            toastAbortUser: "Interrompu : arrêt utilisateur", toastAbortAuth: "Interrompu : session expirée",
            toast401: "Session expirée, rechargez la page",
            toastRisk: "Limitation probable (réduisez CONFIG.concurrency)",
            toastError: "Erreur : {0}",
            toastManualDone: "Import manuel terminé : {0} ajoutés",
            toastNoQueue: "File vide — analysez d'abord",
            toastCsrf: "Jeton CSRF manquant, rechargez la page et vérifiez la connexion",
            unnamed: "(asset sans nom)"
        },
        "es-ES": {
            logCheckoutNoScan: "La página de pago no se escanea, inicia desde una página de búsqueda",
            cartEmptyNow: "El carrito está vacío — se borraron los registros de pago obsoletos",
            btnClearCart: "Vaciar carrito",
            clearCartAsk: "¿Vaciar todos los artículos del carrito de fab.com? Habrá que volver a añadirlos.",
            clearCartDone: "Carrito vaciado.",
            clearCartFailed: "No se pudo vaciar el carrito.",
            logCartFull: "El carrito ya tiene {0} artículos. Finaliza la compra antes de continuar.",
            miniStats: "Analizados {0} · Añadidos {1} · Omitidos {2} · Fallos {3} · {4}",
            tipCollapse: "Contraer el panel",
            tipExpand: "Expandir el panel",
            logCartReconciled: "Comprobación del carrito: {0} registros pendientes ya no están en el carrito, borrados",
            cartMiss: "Carrito vacío, pero nada nuevo en la biblioteca",
            cartBtn: "Pagar ({0})",
            cartAsk: "{0} artículos gratuitos añadidos al carrito: completa la compra en la página abierta", cartWait: "Esperando la compra · carrito {0}", cartDone: "Compra completada · {0} añadidos",
            loginOn: "Sesión de {0}", loginOff: "Sin sesión",
            bundleNote: "{0} paquetes requieren el carrito (regla de FAB)", doneAll: "Todo listo · {0} añadidos",

            navFree: "Gratis", navFreeTip: "Recursos gratis del canal Unreal Engine",
            name: "Importación masiva FAB",
            batch: "Lote", batchReset: "Restablecer lote a {0}",
            swScroll: "Seguir tarjetas", swFx: "Efecto de importación", onSuffix: " (sí)", offSuffix: " (no)",
            start: "Iniciar", pause: "Pausar", resume: "Continuar", importBtn: "Importar({0})", stop: "Detener", clear: "Borrar",
            ready: "Listo", idle: "inactivo",
            statusRunning: "Importando · {0} añadidos · cola {1} · página {2}",
            statusScanning: "Analizando e importando…",
            statusAbortedUser: "Detenido", statusAbortedAuth: "Sesión caducada",
            statusEnd: "Fin alcanzado · {0} añadidos · {1} fallos",
            statusBatchEnd: "Lote terminado · {0} añadidos",
            status401: "Sesión caducada (401), recarga la página",
            statusRisk: "Posible limitación del sitio, inténtalo más tarde",
            statusError: "Error: {0}",
            statusManual: "Importación manual {0} elementos",
            statusManualDone: "Importación manual terminada · {0} añadidos · {1} fallos",
            statusPaused: "En pausa · {0} en cola, pulsa Importar",
            statusResume: "Continuando…", statusStopped: "Detenido · {0} en cola",
            counters: "Analizados {0} / Cola {1} / Añadidos {2} / Omitidos {3} / Fallos {4}",
            meta: "Concurrencia {0} · Lote {1} · {2}/s · página {3} · {4} transcurrido",
            metaNoPage: "Concurrencia {0} · Lote {1} · {2}/s",
            ownerOn: "Comprobación de propiedad: activada",
            ownerSkipped: "Comprobación de propiedad: omitida (biblioteca oculta)",
            scopePrefix: "Ámbito: {0}",
            scopeKeyword: "palabra clave", scopeSeller: "vendedor", scopeCategory: "categoría",
            scopeTag: "etiquetas", scopeFormat: "formato", scopeLicense: "licencia",
            scopeFreeOnly: "solo gratis", scopeSort: "orden {0}", scopeChannel: "canal",
            scopeAll: "todo el catálogo gratuito (más recientes primero)", scopeNone: "assets gratuitos",
            logRestored: "Estado local restaurado: cursor página {0} · {1} importados",
            logStoreFail: "No se pudo guardar el estado local: {0}",
            logThrottled: "Limitado (status={0}), concurrencia reducida a {1}",
            logMaxPages: "Límite de páginas por ejecución ({0}) alcanzado, se detiene aquí",
            logIndexFail: "Búsqueda falló status={0}, reintentando",
            logIndexFatal: "Primera página del índice falló status={0}",
            logEmptyPage: "Índice sin resultados (intento {0}), enfriando",
            logEmptyFatal: "La búsqueda no devuelve nada, puede que el sitio esté bloqueando — inténtalo más tarde",
            logDupPages: "{0} páginas sin ningún asset nuevo — el índice se repite, se toma como tope",
            logNoCursor: "Sin cursor de página siguiente (intento {0}), enfriando y bajando concurrencia",
            logOwnedFail: "Consulta de propiedad falló: {0}",
            logOwnedShort: "Consulta de propiedad incompleta ({0} elementos), se tratan como no poseídos",
            logHiddenOn: "«Ocultar elementos de la biblioteca» detectado: se omite la comprobación",
            logHiddenSearch: "La búsqueda ya excluye la biblioteca: se omite la comprobación",
            logKeepCheck: "La búsqueda aún incluye assets poseídos: se mantiene la comprobación",
            logDetectFail: "Detección falló, se mantiene la comprobación: {0}",
            logAddFail: "Fallo al importar: {0}",
            logCooldown: "{0} importados, breve pausa",
            logAlreadyRunning: "Ya está en marcha",
            logNoCsrf: "Falta el token CSRF — recarga la página y comprueba la sesión",
            logNoCsrfShort: "Falta el token CSRF, recarga la página",
            logNeedScanFirst: "Cola vacía — analiza primero",
            logNoManual: "Ya está en marcha, no hace falta importar a mano",
            batchProgress: "Este lote {0}/{1}",
            toastEnd: "Análisis terminado: {0} añadidos, {1} fallos",
            toastBatch: "Lote terminado: {0} añadidos",
            toastAbortUser: "Interrumpido: detenido por el usuario", toastAbortAuth: "Interrumpido: sesión caducada",
            toast401: "Sesión caducada, recarga la página",
            toastRisk: "Posible limitación (reduce CONFIG.concurrency)",
            toastError: "Error: {0}",
            toastManualDone: "Importación manual terminada: {0} añadidos",
            toastNoQueue: "Cola vacía — analiza primero",
            toastCsrf: "Falta el token CSRF, recarga la página y comprueba la sesión",
            unnamed: "(asset sin nombre)"
        },
        "es-LA": {
            logCheckoutNoScan: "La página de pago no se escanea, inicia desde una página de búsqueda",
            cartEmptyNow: "El carrito está vacío — se eliminaron los registros de pago obsoletos",
            btnClearCart: "Vaciar carrito",
            clearCartAsk: "¿Vaciar todos los artículos del carrito de fab.com? Habrá que volver a agregarlos.",
            clearCartDone: "Carrito vaciado.",
            clearCartFailed: "No se pudo vaciar el carrito.",
            logCartFull: "El carrito ya tiene {0} artículos. Finaliza la compra antes de continuar.",
            miniStats: "Analizados {0} · Agregados {1} · Omitidos {2} · Fallos {3} · {4}",
            tipCollapse: "Contraer el panel",
            tipExpand: "Expandir el panel",
            logCartReconciled: "Revisión del carrito: {0} registros pendientes ya no están en el carrito, eliminados",
            cartMiss: "Carrito vacío, pero nada nuevo en la biblioteca",
            cartBtn: "Pagar ({0})",
            cartAsk: "{0} artículos gratuitos añadidos al carrito: completa la compra en la página abierta", cartWait: "Esperando la compra · carrito {0}", cartDone: "Compra completada · {0} añadidos",
            loginOn: "Sesión de {0}", loginOff: "Sin sesión",
            bundleNote: "{0} paquetes requieren el carrito (regla de FAB)", doneAll: "Todo listo · {0} añadidos",

            navFree: "Gratis", navFreeTip: "Recursos gratis del canal Unreal Engine",
            name: "Importación masiva FAB",
            batch: "Lote", batchReset: "Restablecer lote a {0}",
            swScroll: "Seguir tarjetas", swFx: "Efecto de importación", onSuffix: " (sí)", offSuffix: " (no)",
            start: "Iniciar", pause: "Pausar", resume: "Continuar", importBtn: "Importar({0})", stop: "Detener", clear: "Borrar",
            ready: "Listo", idle: "inactivo",
            statusRunning: "Importando · {0} agregados · cola {1} · página {2}",
            statusScanning: "Analizando e importando…",
            statusAbortedUser: "Detenido", statusAbortedAuth: "Sesión expirada",
            statusEnd: "Fin alcanzado · {0} agregados · {1} fallos",
            statusBatchEnd: "Lote terminado · {0} agregados",
            status401: "Sesión expirada (401), recarga la página",
            statusRisk: "Posible limitación del sitio, intenta más tarde",
            statusError: "Error: {0}",
            statusManual: "Importación manual {0} elementos",
            statusManualDone: "Importación manual terminada · {0} agregados · {1} fallos",
            statusPaused: "En pausa · {0} en cola, pulsa Importar",
            statusResume: "Continuando…", statusStopped: "Detenido · {0} en cola",
            counters: "Analizados {0} / Cola {1} / Agregados {2} / Omitidos {3} / Fallos {4}",
            meta: "Concurrencia {0} · Lote {1} · {2}/s · página {3} · {4} transcurrido",
            metaNoPage: "Concurrencia {0} · Lote {1} · {2}/s",
            ownerOn: "Comprobación de propiedad: activada",
            ownerSkipped: "Comprobación de propiedad: omitida (biblioteca oculta)",
            scopePrefix: "Ámbito: {0}",
            scopeKeyword: "palabra clave", scopeSeller: "vendedor", scopeCategory: "categoría",
            scopeTag: "etiquetas", scopeFormat: "formato", scopeLicense: "licencia",
            scopeFreeOnly: "solo gratis", scopeSort: "orden {0}", scopeChannel: "canal",
            scopeAll: "todo el catálogo gratuito (más recientes primero)", scopeNone: "assets gratuitos",
            logRestored: "Estado local restaurado: cursor página {0} · {1} importados",
            logStoreFail: "No se pudo guardar el estado local: {0}",
            logThrottled: "Limitado (status={0}), concurrencia reducida a {1}",
            logMaxPages: "Límite de páginas por ejecución ({0}) alcanzado, se detiene aquí",
            logIndexFail: "Búsqueda falló status={0}, reintentando",
            logIndexFatal: "Primera página del índice falló status={0}",
            logEmptyPage: "Índice sin resultados (intento {0}), enfriando",
            logEmptyFatal: "La búsqueda no devuelve nada, puede que el sitio esté bloqueando — intenta más tarde",
            logDupPages: "{0} páginas sin ningún asset nuevo — el índice se repite, se toma como tope",
            logNoCursor: "Sin cursor de página siguiente (intento {0}), enfriando y bajando concurrencia",
            logOwnedFail: "Consulta de propiedad falló: {0}",
            logOwnedShort: "Consulta de propiedad incompleta ({0} elementos), se tratan como no poseídos",
            logHiddenOn: "«Ocultar elementos de la biblioteca» detectado: se omite la comprobación",
            logHiddenSearch: "La búsqueda ya excluye la biblioteca: se omite la comprobación",
            logKeepCheck: "La búsqueda aún incluye assets poseídos: se mantiene la comprobación",
            logDetectFail: "Detección falló, se mantiene la comprobación: {0}",
            logAddFail: "Fallo al importar: {0}",
            logCooldown: "{0} importados, breve pausa",
            logAlreadyRunning: "Ya está en marcha",
            logNoCsrf: "Falta el token CSRF — recarga la página y verifica la sesión",
            logNoCsrfShort: "Falta el token CSRF, recarga la página",
            logNeedScanFirst: "Cola vacía — analiza primero",
            logNoManual: "Ya está en marcha, no hace falta importar a mano",
            batchProgress: "Este lote {0}/{1}",
            toastEnd: "Análisis terminado: {0} agregados, {1} fallos",
            toastBatch: "Lote terminado: {0} agregados",
            toastAbortUser: "Interrumpido: detenido por el usuario", toastAbortAuth: "Interrumpido: sesión expirada",
            toast401: "Sesión expirada, recarga la página",
            toastRisk: "Posible limitación (reduce CONFIG.concurrency)",
            toastError: "Error: {0}",
            toastManualDone: "Importación manual terminada: {0} agregados",
            toastNoQueue: "Cola vacía — analiza primero",
            toastCsrf: "Falta el token CSRF, recarga la página y verifica la sesión",
            unnamed: "(asset sin nombre)"
        },
        "it": {
            logCheckoutNoScan: "La pagina di pagamento non viene analizzata, avvia da una pagina di ricerca",
            cartEmptyNow: "Carrello vuoto — voci di checkout obsolete rimosse",
            btnClearCart: "Svuota carrello",
            clearCartAsk: "Rimuovere tutti gli articoli dal carrello di fab.com? Andranno aggiunti di nuovo.",
            clearCartDone: "Carrello svuotato.",
            clearCartFailed: "Impossibile svuotare il carrello.",
            logCartFull: "Il carrello contiene già {0} articoli. Concludi prima l'acquisto.",
            miniStats: "Scansionati {0} · Aggiunti {1} · Saltati {2} · Errori {3} · {4}",
            tipCollapse: "Comprimi pannello",
            tipExpand: "Espandi pannello",
            logCartReconciled: "Controllo carrello: {0} voci in sospeso non sono più nel carrello, rimosse",
            cartMiss: "Carrello vuoto, ma nulla di nuovo nella libreria",
            cartBtn: "Paga ({0})",
            cartAsk: "{0} articoli gratuiti aggiunti al carrello: completa l'ordine nella pagina aperta", cartWait: "In attesa dell'ordine · carrello {0}", cartDone: "Ordine completato · {0} aggiunti",
            loginOn: "Connesso come {0}", loginOff: "Non connesso",
            bundleNote: "{0} bundle richiedono il carrello (regola FAB)", doneAll: "Tutto fatto · {0} aggiunti",

            navFree: "Gratis", navFreeTip: "Asset gratuiti del canale Unreal Engine",
            name: "Importazione massiva FAB",
            batch: "Lotto", batchReset: "Ripristina lotto a {0}",
            swScroll: "Segui le schede", swFx: "Effetto import", onSuffix: " (on)", offSuffix: " (off)",
            start: "Avvia", pause: "Pausa", resume: "Riprendi", importBtn: "Importa({0})", stop: "Ferma", clear: "Cancella",
            ready: "Pronto", idle: "inattivo",
            statusRunning: "Importazione · {0} aggiunti · coda {1} · pagina {2}",
            statusScanning: "Scansione e importazione…",
            statusAbortedUser: "Fermato", statusAbortedAuth: "Sessione scaduta",
            statusEnd: "Fine raggiunta · {0} aggiunti · {1} errori",
            statusBatchEnd: "Lotto completato · {0} aggiunti",
            status401: "Sessione scaduta (401), ricarica la pagina",
            statusRisk: "Possibile limite del sito, riprova più tardi",
            statusError: "Errore: {0}",
            statusManual: "Importazione manuale {0} elementi",
            statusManualDone: "Importazione manuale completata · {0} aggiunti · {1} errori",
            statusPaused: "In pausa · {0} in coda, premi Importa",
            statusResume: "Riprendo…", statusStopped: "Fermato · {0} in coda",
            counters: "Scansionati {0} / Coda {1} / Aggiunti {2} / Saltati {3} / Errori {4}",
            meta: "Concorrenza {0} · Lotto {1} · {2}/s · pagina {3} · {4} trascorso",
            metaNoPage: "Concorrenza {0} · Lotto {1} · {2}/s",
            ownerOn: "Verifica di possesso: attiva",
            ownerSkipped: "Verifica di possesso: saltata (libreria nascosta)",
            scopePrefix: "Ambito: {0}",
            scopeKeyword: "parola chiave", scopeSeller: "venditore", scopeCategory: "categoria",
            scopeTag: "tag", scopeFormat: "formato", scopeLicense: "licenza",
            scopeFreeOnly: "solo gratis", scopeSort: "ordina {0}", scopeChannel: "canale",
            scopeAll: "intero catalogo gratuito (più recenti prima)", scopeNone: "asset gratuiti",
            logRestored: "Stato locale ripristinato: cursore pagina {0} · {1} importati",
            logStoreFail: "Impossibile salvare lo stato locale: {0}",
            logThrottled: "Limitato (status={0}), concorrenza ridotta a {1}",
            logMaxPages: "Limite pagine per esecuzione ({0}) raggiunto, mi fermo qui",
            logIndexFail: "Richiesta di ricerca fallita status={0}, riprovo",
            logIndexFatal: "Prima pagina indice fallita status={0}",
            logEmptyPage: "Indice senza risultati (tentativo {0}), raffreddo",
            logEmptyFatal: "La ricerca non restituisce nulla, forse il sito blocca — riprova più tardi",
            logDupPages: "{0} pagine senza nuovi asset — l'indice si ripete, considerato il tetto",
            logNoCursor: "Nessun cursore successivo (tentativo {0}), raffreddo e abbasso la concorrenza",
            logOwnedFail: "Verifica di possesso fallita: {0}",
            logOwnedShort: "Verifica di possesso incompleta ({0} elementi), trattati come non posseduti",
            logHiddenOn: "«Nascondi elementi della libreria» rilevato: verifica saltata",
            logHiddenSearch: "La ricerca esclude già la libreria: verifica saltata",
            logKeepCheck: "La ricerca include ancora asset posseduti: verifica mantenuta",
            logDetectFail: "Rilevamento fallito, verifica mantenuta: {0}",
            logAddFail: "Errore import: {0}",
            logCooldown: "{0} importati, breve pausa",
            logAlreadyRunning: "Già in esecuzione",
            logNoCsrf: "Token CSRF mancante — ricarica la pagina e verifica l'accesso",
            logNoCsrfShort: "Token CSRF mancante, ricarica la pagina",
            logNeedScanFirst: "Coda vuota — prima scansiona",
            logNoManual: "Già in esecuzione, nessun import manuale necessario",
            batchProgress: "Questo lotto {0}/{1}",
            toastEnd: "Scansione terminata: {0} aggiunti, {1} errori",
            toastBatch: "Lotto terminato: {0} aggiunti",
            toastAbortUser: "Interrotto: stop utente", toastAbortAuth: "Interrotto: sessione scaduta",
            toast401: "Sessione scaduta, ricarica la pagina",
            toastRisk: "Possibile limite (riduci CONFIG.concurrency)",
            toastError: "Errore: {0}",
            toastManualDone: "Importazione manuale completata: {0} aggiunti",
            toastNoQueue: "Coda vuota — prima scansiona",
            toastCsrf: "Token CSRF mancante, ricarica la pagina e verifica l'accesso",
            unnamed: "(asset senza nome)"
        },
        "pl": {
            logCheckoutNoScan: "Strona płatności nie jest skanowana, rozpocznij na stronie wyszukiwania",
            cartEmptyNow: "Koszyk jest pusty — usunięto nieaktualne wpisy zamówienia",
            btnClearCart: "Wyczyść koszyk",
            clearCartAsk: "Usunąć wszystkie pozycje z koszyka fab.com? Trzeba będzie dodać je ponownie.",
            clearCartDone: "Koszyk wyczyszczony.",
            clearCartFailed: "Nie udało się wyczyścić koszyka.",
            logCartFull: "W koszyku jest już {0} pozycji. Najpierw dokończ zakup.",
            miniStats: "Zeskanowano {0} · Dodano {1} · Pominięto {2} · Błędy {3} · {4}",
            tipCollapse: "Zwiń panel",
            tipExpand: "Rozwiń panel",
            logCartReconciled: "Sprawdzenie koszyka: {0} oczekujących wpisów nie ma już w koszyku, usunięto",
            cartMiss: "Koszyk pusty, ale w bibliotece nic nie przybyło",
            cartBtn: "Zapłać ({0})",
            cartAsk: "Dodano {0} darmowych pozycji do koszyka — dokończ zamówienie na otwartej stronie", cartWait: "Oczekiwanie na zamówienie · koszyk {0}", cartDone: "Zamówienie złożone · dodano {0}",
            loginOn: "Zalogowany jako {0}", loginOff: "Nie zalogowano",
            bundleNote: "{0} paczek wymaga koszyka (zasada FAB)", doneAll: "Wszystko gotowe · dodano {0}",

            navFree: "Darmowe", navFreeTip: "Darmowe zasoby kanału Unreal Engine",
            name: "Import zbiorczy FAB",
            batch: "Partia", batchReset: "Przywróć partię {0}",
            swScroll: "Śledź karty", swFx: "Efekt importu", onSuffix: " (wł.)", offSuffix: " (wył.)",
            start: "Start", pause: "Pauza", resume: "Wznów", importBtn: "Importuj({0})", stop: "Stop", clear: "Wyczyść",
            ready: "Gotowe", idle: "bezczynny",
            statusRunning: "Importowanie · dodano {0} · kolejka {1} · strona {2}",
            statusScanning: "Skanowanie i importowanie…",
            statusAbortedUser: "Zatrzymano", statusAbortedAuth: "Sesja wygasła",
            statusEnd: "Koniec osiągnięty · dodano {0} · błędy {1}",
            statusBatchEnd: "Partia zakończona · dodano {0}",
            status401: "Sesja wygasła (401), odśwież stronę",
            statusRisk: "Możliwe limity witryny, spróbuj później",
            statusError: "Błąd: {0}",
            statusManual: "Import ręczny {0} pozycji",
            statusManualDone: "Import ręczny zakończony · dodano {0} · błędy {1}",
            statusPaused: "Wstrzymano · {0} w kolejce, naciśnij Importuj",
            statusResume: "Wznawianie…", statusStopped: "Zatrzymano · {0} w kolejce",
            counters: "Zeskanowano {0} / Kolejka {1} / Dodano {2} / Pominięto {3} / Błędy {4}",
            meta: "Równoległość {0} · Partia {1} · {2}/s · strona {3} · minęło {4}",
            metaNoPage: "Równoległość {0} · Partia {1} · {2}/s",
            ownerOn: "Sprawdzanie posiadania: włączone",
            ownerSkipped: "Sprawdzanie posiadania: pominięte (biblioteka ukryta)",
            scopePrefix: "Zakres: {0}",
            scopeKeyword: "słowo kluczowe", scopeSeller: "sprzedawca", scopeCategory: "kategoria",
            scopeTag: "tagi", scopeFormat: "format", scopeLicense: "licencja",
            scopeFreeOnly: "tylko darmowe", scopeSort: "sortowanie {0}", scopeChannel: "kanał",
            scopeAll: "cały darmowy katalog (najnowsze pierwsze)", scopeNone: "darmowe zasoby",
            logRestored: "Przywrócono stan lokalny: kursor strona {0} · zaimportowano {1}",
            logStoreFail: "Nie udało się zapisać stanu lokalnego: {0}",
            logThrottled: "Limitowanie (status={0}), równoległość obniżona do {1}",
            logMaxPages: "Osiągnięto limit stron na uruchomienie ({0}), kończę",
            logIndexFail: "Zapytanie wyszukiwania nieudane status={0}, ponawiam",
            logIndexFatal: "Pierwsza strona indeksu nieudana status={0}",
            logEmptyPage: "Indeks bez wyników (próba {0}), schładzam",
            logEmptyFatal: "Wyszukiwanie nic nie zwraca, witryna może blokować — spróbuj później",
            logDupPages: "{0} stron bez nowych zasobów — indeks się powtarza, uznaję limit",
            logNoCursor: "Brak kursora następnej strony (próba {0}), schładzam i obniżam równoległość",
            logOwnedFail: "Sprawdzenie posiadania nieudane: {0}",
            logOwnedShort: "Niepełny wynik sprawdzania ({0} pozycji), traktuję jako nieposiadane",
            logHiddenOn: "Wykryto „Ukryj pozycje biblioteki”: pomijam sprawdzanie",
            logHiddenSearch: "Wyszukiwanie już wyklucza bibliotekę: pomijam sprawdzanie",
            logKeepCheck: "Wyszukiwanie zawiera posiadane zasoby: zostawiam sprawdzanie",
            logDetectFail: "Wykrywanie nieudane, zostawiam sprawdzanie: {0}",
            logAddFail: "Błąd importu: {0}",
            logCooldown: "Zaimportowano {0}, krótka przerwa",
            logAlreadyRunning: "Już działa",
            logNoCsrf: "Brak tokenu CSRF — odśwież stronę i sprawdź logowanie",
            logNoCsrfShort: "Brak tokenu CSRF, odśwież stronę",
            logNeedScanFirst: "Kolejka pusta — najpierw skanuj",
            logNoManual: "Już działa, import ręczny niepotrzebny",
            batchProgress: "Ta partia {0}/{1}",
            toastEnd: "Skanowanie zakończone: dodano {0}, błędy {1}",
            toastBatch: "Partia zakończona: dodano {0}",
            toastAbortUser: "Przerwano: stop użytkownika", toastAbortAuth: "Przerwano: sesja wygasła",
            toast401: "Sesja wygasła, odśwież stronę",
            toastRisk: "Możliwe limity (zmniejsz CONFIG.concurrency)",
            toastError: "Błąd: {0}",
            toastManualDone: "Import ręczny zakończony: dodano {0}",
            toastNoQueue: "Kolejka pusta — najpierw skanuj",
            toastCsrf: "Brak tokenu CSRF, odśwież stronę i sprawdź logowanie",
            unnamed: "(zasób bez nazwy)"
        },
        "pt-BR": {
            logCheckoutNoScan: "A página de pagamento não é analisada, comece em uma página de busca",
            cartEmptyNow: "O carrinho está vazio — registros de checkout obsoletos foram removidos",
            btnClearCart: "Esvaziar carrinho",
            clearCartAsk: "Remover todos os itens do carrinho do fab.com? Será preciso adicioná-los de novo.",
            clearCartDone: "Carrinho esvaziado.",
            clearCartFailed: "Não foi possível esvaziar o carrinho.",
            logCartFull: "O carrinho já tem {0} itens. Finalize a compra antes de continuar.",
            miniStats: "Analisados {0} · Adicionados {1} · Ignorados {2} · Falhas {3} · {4}",
            tipCollapse: "Recolher o painel",
            tipExpand: "Expandir o painel",
            logCartReconciled: "Verificação do carrinho: {0} registros pendentes não estão mais no carrinho, removidos",
            cartMiss: "Carrinho vazio, mas nada novo na biblioteca",
            cartBtn: "Finalizar ({0})",
            cartAsk: "{0} itens gratuitos adicionados ao carrinho — conclua o pedido na página aberta", cartWait: "Aguardando o pedido · carrinho {0}", cartDone: "Pedido concluído · {0} adicionados",
            loginOn: "Conectado como {0}", loginOff: "Não conectado",
            bundleNote: "{0} pacotes exigem o carrinho (regra do FAB)", doneAll: "Tudo pronto · {0} adicionados",

            navFree: "Grátis", navFreeTip: "Assets gratuitos do canal Unreal Engine",
            name: "Importação em massa FAB",
            batch: "Lote", batchReset: "Restaurar lote para {0}",
            swScroll: "Seguir cartões", swFx: "Efeito de importação", onSuffix: " (ligado)", offSuffix: " (desligado)",
            start: "Iniciar", pause: "Pausar", resume: "Continuar", importBtn: "Importar({0})", stop: "Parar", clear: "Limpar",
            ready: "Pronto", idle: "ocioso",
            statusRunning: "Importando · {0} adicionados · fila {1} · página {2}",
            statusScanning: "Analisando e importando…",
            statusAbortedUser: "Parado", statusAbortedAuth: "Sessão expirada",
            statusEnd: "Fim alcançado · {0} adicionados · {1} falhas",
            statusBatchEnd: "Lote concluído · {0} adicionados",
            status401: "Sessão expirada (401), recarregue a página",
            statusRisk: "Possível limite do site, tente mais tarde",
            statusError: "Erro: {0}",
            statusManual: "Importação manual {0} itens",
            statusManualDone: "Importação manual concluída · {0} adicionados · {1} falhas",
            statusPaused: "Pausado · {0} na fila, clique em Importar",
            statusResume: "Retomando…", statusStopped: "Parado · {0} na fila",
            counters: "Analisados {0} / Fila {1} / Adicionados {2} / Ignorados {3} / Falhas {4}",
            meta: "Concorrência {0} · Lote {1} · {2}/s · página {3} · {4} decorrido",
            metaNoPage: "Concorrência {0} · Lote {1} · {2}/s",
            ownerOn: "Verificação de posse: ativada",
            ownerSkipped: "Verificação de posse: ignorada (biblioteca oculta)",
            scopePrefix: "Escopo: {0}",
            scopeKeyword: "palavra-chave", scopeSeller: "vendedor", scopeCategory: "categoria",
            scopeTag: "tags", scopeFormat: "formato", scopeLicense: "licença",
            scopeFreeOnly: "somente grátis", scopeSort: "ordem {0}", scopeChannel: "canal",
            scopeAll: "todo o catálogo gratuito (mais recentes primeiro)", scopeNone: "assets gratuitos",
            logRestored: "Estado local restaurado: cursor página {0} · {1} importados",
            logStoreFail: "Falha ao salvar o estado local: {0}",
            logThrottled: "Limitado (status={0}), concorrência reduzida para {1}",
            logMaxPages: "Limite de páginas por execução ({0}) atingido, parando aqui",
            logIndexFail: "Pesquisa falhou status={0}, tentando de novo",
            logIndexFatal: "Primeira página do índice falhou status={0}",
            logEmptyPage: "Índice sem resultados (tentativa {0}), resfriando",
            logEmptyFatal: "A pesquisa não retorna nada, o site pode estar bloqueando — tente mais tarde",
            logDupPages: "{0} páginas sem nenhum asset novo — o índice está se repetindo, tratado como limite",
            logNoCursor: "Sem cursor da próxima página (tentativa {0}), resfriando e reduzindo concorrência",
            logOwnedFail: "Consulta de posse falhou: {0}",
            logOwnedShort: "Consulta de posse incompleta ({0} itens), tratados como não possuídos",
            logHiddenOn: "“Ocultar itens da biblioteca” detectado: pulando a verificação",
            logHiddenSearch: "A pesquisa já exclui a biblioteca: pulando a verificação",
            logKeepCheck: "A pesquisa ainda inclui assets possuídos: mantendo a verificação",
            logDetectFail: "Detecção falhou, mantendo a verificação: {0}",
            logAddFail: "Falha ao importar: {0}",
            logCooldown: "{0} importados, breve pausa",
            logAlreadyRunning: "Já está rodando",
            logNoCsrf: "Token CSRF ausente — recarregue a página e confirme o login",
            logNoCsrfShort: "Token CSRF ausente, recarregue a página",
            logNeedScanFirst: "Fila vazia — analise primeiro",
            logNoManual: "Já está rodando, sem necessidade de importação manual",
            batchProgress: "Este lote {0}/{1}",
            toastEnd: "Análise concluída: {0} adicionados, {1} falhas",
            toastBatch: "Lote concluído: {0} adicionados",
            toastAbortUser: "Interrompido: parado pelo usuário", toastAbortAuth: "Interrompido: sessão expirada",
            toast401: "Sessão expirada, recarregue a página",
            toastRisk: "Possível limite (reduza CONFIG.concurrency)",
            toastError: "Erro: {0}",
            toastManualDone: "Importação manual concluída: {0} adicionados",
            toastNoQueue: "Fila vazia — analise primeiro",
            toastCsrf: "Token CSRF ausente, recarregue a página e confirme o login",
            unnamed: "(asset sem nome)"
        },
        "ru": {
            logCheckoutNoScan: "Страница оплаты не сканируется, начните со страницы поиска",
            cartEmptyNow: "Корзина пуста — устаревшие записи оформления удалены",
            btnClearCart: "Очистить корзину",
            clearCartAsk: "Удалить все товары из корзины fab.com? Их придётся добавить заново.",
            clearCartDone: "Корзина очищена.",
            clearCartFailed: "Не удалось очистить корзину.",
            logCartFull: "В корзине уже {0} позиций. Сначала оформление заказа.",
            miniStats: "Просканировано {0} · Добавлено {1} · Пропущено {2} · Ошибок {3} · {4}",
            tipCollapse: "Свернуть панель",
            tipExpand: "Развернуть панель",
            logCartReconciled: "Проверка корзины: {0} записей ожидания больше нет в корзине, удалены",
            cartMiss: "Корзина пуста, но в библиотеке ничего не появилось",
            cartBtn: "Оплатить ({0})",
            cartAsk: "В корзину добавлено бесплатных товаров: {0} — завершите оформление на открытой странице", cartWait: "Ожидание оформления · корзина {0}", cartDone: "Оформление завершено · добавлено {0}",
            loginOn: "Вы вошли как {0}", loginOff: "Вход не выполнен",
            bundleNote: "{0} наборов требуют корзину (правило FAB)", doneAll: "Готово · добавлено {0}",

            navFree: "Бесплатно", navFreeTip: "Бесплатные ассеты канала Unreal Engine",
            name: "Массовый импорт FAB",
            batch: "Пакет", batchReset: "Сбросить пакет до {0}",
            swScroll: "Следить за карточками", swFx: "Эффект импорта", onSuffix: " (вкл.)", offSuffix: " (выкл.)",
            start: "Старт", pause: "Пауза", resume: "Продолжить", importBtn: "Импорт({0})", stop: "Стоп", clear: "Очистить",
            ready: "Готово", idle: "ожидание",
            statusRunning: "Импорт · добавлено {0} · очередь {1} · страница {2}",
            statusScanning: "Сканирую и импортирую…",
            statusAbortedUser: "Остановлено", statusAbortedAuth: "Сессия истекла",
            statusEnd: "Конец достигнут · добавлено {0} · ошибок {1}",
            statusBatchEnd: "Пакет завершён · добавлено {0}",
            status401: "Сессия истекла (401), перезагрузите страницу",
            statusRisk: "Возможен лимит сайта, попробуйте позже",
            statusError: "Ошибка: {0}",
            statusManual: "Ручной импорт {0} объектов",
            statusManualDone: "Ручной импорт завершён · добавлено {0} · ошибок {1}",
            statusPaused: "Пауза · {0} в очереди, нажмите «Импорт»",
            statusResume: "Продолжаю…", statusStopped: "Остановлено · {0} в очереди",
            counters: "Просканировано {0} / Очередь {1} / Добавлено {2} / Пропущено {3} / Ошибок {4}",
            meta: "Потоки {0} · Пакет {1} · {2}/с · страница {3} · прошло {4}",
            metaNoPage: "Потоки {0} · Пакет {1} · {2}/с",
            ownerOn: "Проверка владения: вкл.",
            ownerSkipped: "Проверка владения: пропущена (библиотека скрыта)",
            scopePrefix: "Область: {0}",
            scopeKeyword: "ключевое слово", scopeSeller: "продавец", scopeCategory: "категория",
            scopeTag: "теги", scopeFormat: "формат", scopeLicense: "лицензия",
            scopeFreeOnly: "только бесплатные", scopeSort: "сортировка {0}", scopeChannel: "канал",
            scopeAll: "весь бесплатный каталог (сначала новые)", scopeNone: "бесплатные ассеты",
            logRestored: "Локальное состояние восстановлено: курсор страница {0} · импортировано {1}",
            logStoreFail: "Не удалось сохранить локальное состояние: {0}",
            logThrottled: "Ограничение (status={0}), потоки снижены до {1}",
            logMaxPages: "Достигнут лимит страниц за запуск ({0}), останавливаюсь",
            logIndexFail: "Запрос поиска не удался status={0}, повторяю",
            logIndexFatal: "Первая страница индекса не удалась status={0}",
            logEmptyPage: "Индекс без результатов (попытка {0}), остываю",
            logEmptyFatal: "Поиск ничего не вернул, возможно сайт блокирует — попробуйте позже",
            logDupPages: "{0} страниц без новых ассетов — индекс повторяется, считаю это пределом",
            logNoCursor: "Нет курсора следующей страницы (попытка {0}), остываю и снижаю потоки",
            logOwnedFail: "Проверка владения не удалась: {0}",
            logOwnedShort: "Проверка владения неполная ({0} объектов), считаю как невостребованные",
            logHiddenOn: "Обнаружено «Скрыть объекты библиотеки»: проверка пропущена",
            logHiddenSearch: "Поиск уже исключает библиотеку: проверка пропущена",
            logKeepCheck: "Поиск ещё содержит свои ассеты: проверка остаётся",
            logDetectFail: "Определение не удалось, проверка остаётся: {0}",
            logAddFail: "Ошибка импорта: {0}",
            logCooldown: "Импортировано {0}, короткая пауза",
            logAlreadyRunning: "Уже работает",
            logNoCsrf: "Нет токена CSRF — перезагрузите страницу и проверьте вход",
            logNoCsrfShort: "Нет токена CSRF, перезагрузите страницу",
            logNeedScanFirst: "Очередь пуста — сначала сканируйте",
            logNoManual: "Уже работает, ручной импорт не нужен",
            batchProgress: "Этот пакет {0}/{1}",
            toastEnd: "Сканирование завершено: добавлено {0}, ошибок {1}",
            toastBatch: "Пакет завершён: добавлено {0}",
            toastAbortUser: "Прервано: остановка пользователем", toastAbortAuth: "Прервано: сессия истекла",
            toast401: "Сессия истекла, перезагрузите страницу",
            toastRisk: "Возможен лимит (уменьшите CONFIG.concurrency)",
            toastError: "Ошибка: {0}",
            toastManualDone: "Ручной импорт завершён: добавлено {0}",
            toastNoQueue: "Очередь пуста — сначала сканируйте",
            toastCsrf: "Нет токена CSRF, перезагрузите страницу и проверьте вход",
            unnamed: "(ассет без имени)"
        },
        "tr": {
            logCheckoutNoScan: "Ödeme sayfası taranmaz, arama sayfasından başlayın",
            cartEmptyNow: "Sepet boş — eski ödeme kayıtları temizlendi",
            btnClearCart: "Sepeti temizle",
            clearCartAsk: "fab.com sepetindeki tüm ürünler kaldırılsın mı? Yeniden eklemeniz gerekir.",
            clearCartDone: "Sepet temizlendi.",
            clearCartFailed: "Sepet temizlenemedi.",
            logCartFull: "Sepette zaten {0} ürün var. Önce ödemeyi tamamlayın.",
            miniStats: "Tarandı {0} · Eklendi {1} · Atlandı {2} · Hata {3} · {4}",
            tipCollapse: "Paneli daralt",
            tipExpand: "Paneli genişlet",
            logCartReconciled: "Sepet kontrolü: {0} bekleyen kayıt artık sepette değil, silindi",
            cartMiss: "Sepet boş ama kütüphaneye yeni bir şey eklenmedi",
            cartBtn: "Öde ({0})",
            cartAsk: "{0} ücretsiz öğe sepete eklendi — açılan sayfada siparişi tamamla", cartWait: "Sipariş bekleniyor · sepet {0}", cartDone: "Sipariş tamamlandı · {0} eklendi",
            loginOn: "{0} olarak giriş yapıldı", loginOff: "Giriş yapılmadı",
            bundleNote: "{0} paket sepet gerektirir (FAB kuralı)", doneAll: "Tamamlandı · {0} eklendi",

            navFree: "Ücretsiz", navFreeTip: "Unreal Engine kanalındaki ücretsiz varlıklar",
            name: "FAB Toplu İçe Aktarma",
            batch: "Toplu", batchReset: "Topluyu {0} değerine sıfırla",
            swScroll: "Kartları izle", swFx: "Aktarma efekti", onSuffix: " (açık)", offSuffix: " (kapalı)",
            start: "Başlat", pause: "Duraklat", resume: "Devam", importBtn: "Aktar({0})", stop: "Durdur", clear: "Temizle",
            ready: "Hazır", idle: "boşta",
            statusRunning: "Aktarılıyor · {0} eklendi · kuyruk {1} · sayfa {2}",
            statusScanning: "Taranıyor ve aktarılıyor…",
            statusAbortedUser: "Durduruldu", statusAbortedAuth: "Oturum sona erdi",
            statusEnd: "Sona ulaşıldı · {0} eklendi · {1} hata",
            statusBatchEnd: "Toplu iş bitti · {0} eklendi",
            status401: "Oturum sona erdi (401), sayfayı yenileyin",
            statusRisk: "Site sınırı olabilir, sonra tekrar deneyin",
            statusError: "Hata: {0}",
            statusManual: "Elle aktarma {0} öğe",
            statusManualDone: "Elle aktarma bitti · {0} eklendi · {1} hata",
            statusPaused: "Duraklatıldı · {0} kuyrukta, Aktar'a basın",
            statusResume: "Devam ediyor…", statusStopped: "Durduruldu · {0} kuyrukta",
            counters: "Tarandı {0} / Kuyruk {1} / Eklendi {2} / Atlandı {3} / Hata {4}",
            meta: "Eşzamanlı {0} · Toplu {1} · {2}/s · sayfa {3} · {4} geçti",
            metaNoPage: "Eşzamanlı {0} · Toplu {1} · {2}/s",
            ownerOn: "Sahiplik denetimi: açık",
            ownerSkipped: "Sahiplik denetimi: atlandı (kitaplık gizli)",
            scopePrefix: "Kapsam: {0}",
            scopeKeyword: "anahtar sözcük", scopeSeller: "satıcı", scopeCategory: "kategori",
            scopeTag: "etiketler", scopeFormat: "biçim", scopeLicense: "lisans",
            scopeFreeOnly: "yalnızca ücretsiz", scopeSort: "sıralama {0}", scopeChannel: "kanal",
            scopeAll: "tüm ücretsiz katalog (önce en yeni)", scopeNone: "ücretsiz varlıklar",
            logRestored: "Yerel kayıt geri yüklendi: imleç {0}. sayfa · {1} aktarıldı",
            logStoreFail: "Yerel kayıt yazılamadı: {0}",
            logThrottled: "Sınırlandırıldı (status={0}), eşzamanlılık {1} değerine düştü",
            logMaxPages: "Çalıştırma başına sayfa sınırı ({0}) aşıldı, burada duruyorum",
            logIndexFail: "Arama isteği başarısız status={0}, yeniden deniyorum",
            logIndexFatal: "İlk dizin sayfası başarısız status={0}",
            logEmptyPage: "Dizin sonuçsuz ({0}. deneme), soğutuyorum",
            logEmptyFatal: "Arama bir şey döndürmüyor, site engelliyor olabilir — sonra deneyin",
            logDupPages: "{0} sayfa yeni varlık yok — dizin kendini tekrarlıyor, üst sınır sayıyorum",
            logNoCursor: "Sonraki sayfa imleci yok ({0}. deneme), soğutup eşzamanlılığı düşürüyorum",
            logOwnedFail: "Sahiplik sorgusu başarısız: {0}",
            logOwnedShort: "Sahiplik sorgusu eksik ({0} öğe), sahip değil kabul ediliyor",
            logHiddenOn: "«Kitaplık öğelerini gizle» algılandı: denetim atlanıyor",
            logHiddenSearch: "Arama kitaplığı zaten dışlıyor: denetim atlanıyor",
            logKeepCheck: "Arama hâlâ sahip olunanları içeriyor: denetim sürüyor",
            logDetectFail: "Algılama başarısız, denetim sürüyor: {0}",
            logAddFail: "Aktarma hatası: {0}",
            logCooldown: "{0} aktarıldı, kısa mola",
            logAlreadyRunning: "Zaten çalışıyor",
            logNoCsrf: "CSRF belirteci yok — sayfayı yenileyip oturumu doğrulayın",
            logNoCsrfShort: "CSRF belirteci yok, sayfayı yenileyin",
            logNeedScanFirst: "Kuyruk boş — önce tarayın",
            logNoManual: "Zaten çalışıyor, elle aktarmaya gerek yok",
            batchProgress: "Bu toplu iş {0}/{1}",
            toastEnd: "Tarama bitti: {0} eklendi, {1} hata",
            toastBatch: "Toplu iş bitti: {0} eklendi",
            toastAbortUser: "Durduruldu: kullanıcı isteği", toastAbortAuth: "Durduruldu: oturum sona erdi",
            toast401: "Oturum sona erdi, sayfayı yenileyin",
            toastRisk: "Site sınırı olabilir (CONFIG.concurrency değerini düşürün)",
            toastError: "Hata: {0}",
            toastManualDone: "Elle aktarma bitti: {0} eklendi",
            toastNoQueue: "Kuyruk boş — önce tarayın",
            toastCsrf: "CSRF belirteci yok, sayfayı yenileyip oturumu doğrulayın",
            unnamed: "(adsız varlık)"
        },
        "ar": {
            logCheckoutNoScan: "صفحة الدفع لا يتم فحصها، ابدأ من صفحة البحث",
            cartEmptyNow: "السلة فارغة — تم مسح سجلات الدفع القديمة",
            btnClearCart: "إفراغ السلة",
            clearCartAsk: "هل تريد إزالة كل العناصر من سلة fab.com؟ سيلزم إضافتها مرة أخرى.",
            clearCartDone: "تم إفراغ السلة.",
            clearCartFailed: "تعذّر إفراغ السلة.",
            logCartFull: "تحتوي السلة على {0} عناصر. أكمل الشراء أولًا.",
            miniStats: "تم الفحص {0} · أُضيف {1} · تم التخطي {2} · فشل {3} · {4}",
            tipCollapse: "طيّ اللوحة",
            tipExpand: "توسيع اللوحة",
            logCartReconciled: "فحص السلة: {0} سجلات معلّقة لم تعد في السلة، تم حذفها",
            cartMiss: "السلة فارغة لكن لم يصل شيء جديد إلى مكتبتك",
            cartBtn: "إتمام الشراء ({0})",
            cartAsk: "تمت إضافة {0} من العناصر المجانية إلى السلة — أكمل الطلب في الصفحة المفتوحة", cartWait: "بانتظار إتمام الطلب · السلة {0}", cartDone: "تم إتمام الطلب · أضيف {0}",

            loginOn: "تم تسجيل الدخول باسم {0}", loginOff: "لم تسجل الدخول",
            bundleNote: "{0} حزم تتطلب السلة (قاعدة Fab)", doneAll: "اكتمل كل شيء · أضيف {0}",

            navFree: "أصول مجانية", navFreeTip: "أصول مجانية في قناة Unreal Engine",
            name: "استيراد FAB بالجملة",
            batch: "الدفعة", batchReset: "إعادة الدفعة إلى {0}",
            swScroll: "متابعة البطاقات", swFx: "تأثير الاستيراد", onSuffix: " (مفعّل)", offSuffix: " (متوقف)",
            start: "ابدأ", pause: "إيقاف مؤقت", resume: "متابعة", importBtn: "استيراد({0})", stop: "إيقاف", clear: "مسح السجلات",
            ready: "جاهز", idle: "خامل",
            statusRunning: "جارٍ الاستيراد · أُضيف {0} · الطابور {1} · الصفحة {2}",
            statusScanning: "جارٍ الفحص والاستيراد…",
            statusAbortedUser: "أُوقف", statusAbortedAuth: "انتهت الجلسة",
            statusEnd: "بلغنا النهاية · أُضيف {0} · فشل {1}",
            statusBatchEnd: "انتهت الدفعة · أُضيف {0}",
            status401: "انتهت الجلسة (401)، أعد تحميل الصفحة",
            statusRisk: "يُحتمل وجود حد للموقع، حاول لاحقًا",
            statusError: "خطأ: {0}",
            statusManual: "استيراد يدوي {0} عنصرًا",
            statusManualDone: "انتهى الاستيراد اليدوي · أُضيف {0} · فشل {1}",
            statusPaused: "متوقف مؤقتًا · {0} في الطابور، اضغط استيراد",
            statusResume: "جارٍ المتابعة…", statusStopped: "أُوقف · {0} في الطابور",
            counters: "تم الفحص {0} / الطابور {1} / أُضيف {2} / تم التخطي {3} / فشل {4}",
            meta: "التوازي {0} · الدفعة {1} · {2}/ث · الصفحة {3} · مرّ {4}",
            metaNoPage: "التوازي {0} · الدفعة {1} · {2}/ث",
            ownerOn: "فحص الملكية: مفعّل",
            ownerSkipped: "فحص الملكية: تم تخطيه (المكتبة مخفية)",
            scopePrefix: "النطاق: {0}",
            scopeKeyword: "كلمة مفتاحية", scopeSeller: "البائع", scopeCategory: "الفئة",
            scopeTag: "الوسوم", scopeFormat: "التنسيق", scopeLicense: "الترخيص",
            scopeFreeOnly: "المجاني فقط", scopeSort: "الترتيب {0}", scopeChannel: "القناة",
            scopeAll: "كل الفهرس المجاني (الأحدث أولًا)", scopeNone: "أصول مجانية",
            logRestored: "تم استعادة الحالة المحلية: المؤشر الصفحة {0} · أُضيف {1}",
            logStoreFail: "تعذّر حفظ الحالة المحلية: {0}",
            logThrottled: "تقييد (status={0})، خُفّض التوازي إلى {1}",
            logMaxPages: "بلغنا حد الصفحات لكل تشغيل ({0})، توقف هنا",
            logIndexFail: "فشل طلب البحث status={0}، أعيد المحاولة",
            logIndexFatal: "فشلت صفحة الفهرس الأولى status={0}",
            logEmptyPage: "الفهرس بلا نتائج (المحاولة {0})، تبريد",
            logEmptyFatal: "البحث لا يعيد شيئًا، قد يكون الموقع يحجب — حاول لاحقًا",
            logDupPages: "{0} صفحات بلا أي أصل جديد — الفهرس يكرر نفسه، يُعدّ حدًا أعلى",
            logNoCursor: "لا مؤشر للصفحة التالية (المحاولة {0})، تبريد وخفض التوازي",
            logOwnedFail: "فشل استعلام الملكية: {0}",
            logOwnedShort: "استعلام الملكية غير مكتمل ({0} عنصرًا)، يُعامل كغير مملوك",
            logHiddenOn: "تم اكتشاف «إخفاء عناصر المكتبة»: تخطي فحص الملكية",
            logHiddenSearch: "البحث يستبعد المكتبة مسبقًا: تخطي فحص الملكية",
            logKeepCheck: "البحث لا يزال يضم أصولًا مملوكة: الإبقاء على الفحص",
            logDetectFail: "فشل الكشف، الإبقاء على الفحص: {0}",
            logAddFail: "فشل الاستيراد: {0}",
            logCooldown: "أُضيف {0}، تبريد قصير",
            logAlreadyRunning: "قيد التشغيل بالفعل",
            logNoCsrf: "لا يوجد رمز CSRF — أعد تحميل الصفحة وتأكد من تسجيل الدخول",
            logNoCsrfShort: "لا يوجد رمز CSRF، أعد تحميل الصفحة",
            logNeedScanFirst: "الطابور فارغ — افحص أولًا",
            logNoManual: "قيد التشغيل، لا حاجة لاستيراد يدوي",
            batchProgress: "هذه الدفعة {0}/{1}",
            toastEnd: "انتهى الفحص: أُضيف {0}، فشل {1}",
            toastBatch: "انتهت الدفعة: أُضيف {0}",
            toastAbortUser: "أُوقف: بطلب المستخدم", toastAbortAuth: "أُوقف: انتهت الجلسة",
            toast401: "انتهت الجلسة، أعد تحميل الصفحة",
            toastRisk: "يُحتمل وجود حد للموقع (قلّل CONFIG.concurrency)",
            toastError: "خطأ: {0}",
            toastManualDone: "انتهى الاستيراد اليدوي: أُضيف {0}",
            toastNoQueue: "الطابور فارغ — افحص أولًا",
            toastCsrf: "لا يوجد رمز CSRF، أعد تحميل الصفحة وتأكد من تسجيل الدخول",
            unnamed: "(أصل بلا اسم)"
        }
    };

    function detectLocale() {
        let raw = (document.documentElement.lang || "").toLowerCase().trim();
        if (!raw) {
            const m = document.cookie.match(/(?:^|;\s*)EPIC_LOCALE=([^;]+)/);
            raw = (m ? m[1] : (navigator.language || "en")).toLowerCase().trim();
        }
        if (raw === "zh" || raw.indexOf("zh-cn") === 0 || raw.indexOf("zh-hans") === 0 || raw === "zh-sg") return "zh-CN";
        if (raw.indexOf("zh") === 0) return "zh-TW";                       // zh-tw / zh-hant / zh-hk
        if (raw.indexOf("es-419") === 0 || raw.indexOf("es-la") === 0 || raw.indexOf("es-mx") === 0 ||
            raw.indexOf("es-ar") === 0 || raw.indexOf("es-cl") === 0 || raw.indexOf("es-co") === 0) return "es-LA";
        if (raw.indexOf("es") === 0) return "es-ES";
        if (raw.indexOf("pt") === 0) return "pt-BR";
        const two = raw.split("-")[0];
        const map = { ar: "ar", de: "de", en: "en", fr: "fr", it: "it", ja: "ja", ko: "ko", pl: "pl", ru: "ru", tr: "tr" };
        return map[two] || "en";
    }

    const LOCALE = detectLocale();
    const L = I18N[LOCALE] || I18N.en;

    // Phase chip words, kept apart from the big table because they are single tokens.
    const PHASE_I18N = {
        "en": { idle: "idle", scan: "scan", import: "import", done: "done", error: "error" },
        "zh-CN": { idle: "空闲", scan: "扫描", import: "入库", done: "完成", error: "出错" },
        "zh-TW": { idle: "閒置", scan: "掃描", import: "入庫", done: "完成", error: "出錯" },
        "ja": { idle: "待機", scan: "走査", import: "取込", done: "完了", error: "エラー" },
        "ko": { idle: "대기", scan: "스캔", import: "가져오기", done: "완료", error: "오류" },
        "de": { idle: "Leerlauf", scan: "Scan", import: "Import", done: "fertig", error: "Fehler" },
        "fr": { idle: "inactif", scan: "analyse", import: "import", done: "terminé", error: "erreur" },
        "es-ES": { idle: "inactivo", scan: "análisis", import: "importar", done: "hecho", error: "error" },
        "es-LA": { idle: "inactivo", scan: "análisis", import: "importar", done: "listo", error: "error" },
        "it": { idle: "inattivo", scan: "scansione", import: "import", done: "fatto", error: "errore" },
        "pl": { idle: "bezczynny", scan: "skan", import: "import", done: "gotowe", error: "błąd" },
        "pt-BR": { idle: "ocioso", scan: "análise", import: "importação", done: "pronto", error: "erro" },
        "ru": { idle: "ожидание", scan: "скан", import: "импорт", done: "готово", error: "ошибка" },
        "tr": { idle: "boşta", scan: "tarama", import: "aktarma", done: "bitti", error: "hata" },
        "ar": { idle: "خامل", scan: "فحص", import: "استيراد", done: "تم", error: "خطأ" }
    };
    function phaseLabel(p) { return (PHASE_I18N[LOCALE] && PHASE_I18N[LOCALE][p]) || p; }

    // Tiny {0}/{1} formatter — every translated string is a plain template.
    function t(key) {
        const tpl = L[key] || I18N.en[key] || key;
        const args = arguments;
        return String(tpl).replace(/\{(\d+)\}/g, function (m, i) {
            const v = args[Number(i) + 1];
            return v === undefined ? m : String(v);
        });
    }


    const runtime = {
        running: false,
        paused: false,
        aborted: false,
        phase: "idle",                 // idle | scan | import | done | error
        concurrency: CONFIG.concurrency,
        successStreak: 0,
        lastError: "",
        cursor: null,
        pages: 0,
        endReached: false,
        hiddenLibrary: null,           // true => search already excludes owned
        manual: false,                 // manual import is allowed to run while paused
        autoScroll: true,              // follow the imported cards on the page
        effects: true,                 // play the flip animation on the card
        maxItems: 0,                   // 0 = unlimited, otherwise a per-run cap
        batchSize: CONFIG.batchSize,
        queue: [],                     // scanned, not yet imported
        stats: {
            indexed: 0, added: 0, skipped: 0, failed: 0,
            bundles: 0,
            pending: 0, startedAt: 0, finishedAt: 0
        },
        userName: "",                  // signed-in account shown in the status row
        userChecked: false,
        carted: [],                    // parked in the cart, waiting for one checkout
        cartTimer: null,
    };

    // Persisted between reloads: cursor + what we already handled.
    let store = { key: "", cursor: null, pages: 0, done: {}, failed: {}, carted: {}, added: 0 };

    /* ---------------------------------------------------------------- *
     * utils
     * ---------------------------------------------------------------- */

    function log() {
        const args = Array.prototype.slice.call(arguments);
        console.log.apply(console, ["[FAB-BFG]"].concat(args));
        setLogLine(args.join(" "));
    }

    function sleep(ms) {
        return new Promise(function (r) { setTimeout(r, ms); });
    }

    function getCSRFToken() {
        const cookies = document.cookie.split(";");
        for (let i = 0; i < cookies.length; i++) {
            const cookie = cookies[i].trim();
            if (cookie.startsWith("fab_csrftoken=")) {
                const v = cookie.split("=").slice(1).join("=");
                if (v) {
                    try { return decodeURIComponent(v); } catch (e) { return v; }
                }
            }
        }
        const meta = document.querySelector('meta[name="csrf-token"], meta[name="xsrf-token"]');
        return meta ? meta.getAttribute("content") : "";
    }

    function apiHeaders(extra) {
        const h = {
            "X-CsrfToken": getCSRFToken(),
            "X-Requested-With": "XMLHttpRequest",
            "Accept": "application/json"
        };
        if (extra) Object.assign(h, extra);
        return h;
    }

    // Turn the current page URL into the API query we paginate over.
    function baseParams() {
        const src = new URLSearchParams(location.search);
        const q = new URLSearchParams();
        const drop = { cursor: 1, count: 1, offset: 1, aggregate_on: 1 };
        // append() and not set(): FAB keeps multi-select facets in the URL as
        // repeated keys (asset_formats=fbx&asset_formats=obj, sellers=a&
        // sellers=b, …). set() would keep only the last value, so the scan
        // would quietly narrow to one facet and no longer match the page.
        const seen = {};
        src.forEach(function (v, k) {
            if (drop[k] || !v) return;
            const sig = k + "=" + v;
            if (seen[sig]) return;
            seen[sig] = 1;
            q.append(k, v);
        });
        // Path segments carry filters that never show up in location.search:
        // /search/channels/<slug> (and /search/categories/<...>) are the same
        // filters the API expects as query params. Without this a run started
        // on a channel page silently scans the whole free catalogue instead.
        const ch = location.pathname.match(/\/search\/channels\/([^\/]+)/);
        if (ch) q.append("channels", decodeURIComponent(ch[1]));
        const cat = location.pathname.match(/\/search\/categories\/(.+)$/);
        if (cat) q.append("categories", decodeURIComponent(cat[1].replace(/\/$/, "").replace(/\//g, "--")));
        if (CONFIG.forceFree && !q.has("is_free")) q.append("is_free", "1");
        // Ordering: always follow the page. An absent sort_by means the site's
        // own default (relevance), so we must not invent one — otherwise
        // following the page's order turns into a -createdAt sweep.
        q.set("count", String(CONFIG.pageSize));
        return q;
    }

    // The scan always reads the catalogue with the user's own session.
    // Anonymous reads are not the same index: on a filtered view the anonymous
    // answer carries extra hits the page never shows (/search/channels/uefn plus
    // one seller: 12 rows logged in, 24 anonymously, with a next cursor on top),
    // so asking anonymously is what made a run scan something other than the
    // page on screen. It is also the only index that can agree with the library
    // add that follows, which has to use the session anyway.
    function scanCredentials() {
        return "same-origin";
    }

    // Human-readable summary of the filters this run will actually send.
    function describeScope() {
        const q = baseParams();
        const parts = [];
        const keys = {
            q: t("scopeKeyword"), sellers: t("scopeSeller"), categories: t("scopeCategory"),
            tags: t("scopeTag"), asset_formats: t("scopeFormat"), licenses: t("scopeLicense"),
            channels: t("scopeChannel")
        };
        // Group repeated keys so a multi-select facet reads "格式=fbx,obj" and
        // not "格式=fbx · 格式=obj". Anything the site added that we have no
        // label for is still shown raw, instead of being silently dropped.
        const groups = {};
        const order = [];
        q.forEach(function (v, k) {
            if (k === "count") return;
            if (!groups[k]) { groups[k] = []; order.push(k); }
            groups[k].push(v);
        });
        order.forEach(function (k) {
            const vals = groups[k];
            if (k === "is_free") parts.push(t("scopeFreeOnly"));
            else if (k === "sort_by") parts.push(t("scopeSort", vals.join(", ")));
            else parts.push((keys[k] || k) + "=" + vals.join(","));
        });
        if (!parts.length) return t("scopeAll");
        return parts.join(" · ");
    }

    function scopeKey() {
        const q = baseParams();
        q.delete("count");
        q.delete("cursor");
        return q.toString() || "all-free";
    }

    function loadStore() {
        const key = scopeKey();
        try {
            const raw = localStorage.getItem(STORE_PREFIX + key);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && parsed.key === key) {
                    store = parsed;
                    if (!store.done) store.done = {};
                    if (!store.failed) store.failed = {};
                    if (!store.carted) store.carted = {};
                    runtime.cursor = store.cursor || null;
                    runtime.pages = store.pages || 0;
                    log(t("logRestored", runtime.pages, Object.keys(store.done).length));
                    return;
                }
            }
        } catch (e) { /* broken cache */ }
        store = { key: key, cursor: null, pages: 0, done: {}, failed: {}, carted: {}, added: 0 };
        runtime.cursor = null;
        runtime.pages = 0;
    }

    function saveStore() {
        store.cursor = runtime.cursor;
        store.pages = runtime.pages;
        try {
            localStorage.setItem(STORE_PREFIX + store.key, JSON.stringify(store));
        } catch (e) {
            log(t("logStoreFail", e.message));
        }
    }

    // The cart is account-wide, not page-wide: what is parked in it has to be
    // visible from any page, so this list lives under one global key.
    const CART_KEY = "fab_bfg_cart_pending";

    function loadCartPending() {
        try {
            const raw = localStorage.getItem(CART_KEY);
            const v = raw ? JSON.parse(raw) : [];
            return Array.isArray(v) ? v : [];
        } catch (e) { return []; }
    }

    function saveCartPending() {
        try { localStorage.setItem(CART_KEY, JSON.stringify(runtime.carted || [])); } catch (e) { /* ignore */ }
    }

    function clearStore() {
        try { localStorage.removeItem(STORE_PREFIX + store.key); } catch (e) { /* ignore */ }
        // The pending-cart list is part of the local state this button resets;
        // leaving it behind is what kept "checkout (N)" alive after a clear.
        try { localStorage.removeItem(CART_KEY); } catch (e) { /* ignore */ }
        if (runtime.cartTimer) { clearInterval(runtime.cartTimer); runtime.cartTimer = null; }
        runtime.carted = [];
        store = { key: scopeKey(), cursor: null, pages: 0, done: {}, failed: {}, carted: {}, added: 0 };
        runtime.cursor = null;
        runtime.pages = 0;
        runtime.queue = [];
        runtime.endReached = false;
        runtime.stats.indexed = 0;
        runtime.stats.added = 0;
        runtime.stats.skipped = 0;
        runtime.stats.failed = 0;
        runtime.stats.pending = 0;
        render();
    }

    /* ---------------------------------------------------------------- *
     * adaptive request layer
     * ---------------------------------------------------------------- */

    function noteThrottled(status) {
        runtime.successStreak = 0;
        runtime.concurrency = Math.max(CONFIG.minConcurrency, runtime.concurrency - 2);
        log(t("logThrottled", status, runtime.concurrency));
        render();
    }

    function noteSuccess() {
        runtime.successStreak++;
        if (runtime.successStreak >= 30 && runtime.concurrency < CONFIG.maxConcurrency) {
            runtime.concurrency++;
            runtime.successStreak = 0;
            render();
        }
    }

    // Every request gets a hard ceiling: one connection that never answers
    // would otherwise freeze a worker for the rest of the run.
    async function fetchWithTimeout(url, opts, ms) {
        const ac = new AbortController();
        const timer = setTimeout(function () { try { ac.abort(); } catch (e) { /* ignore */ } }, ms || 20000);
        try {
            return await fetch(url, Object.assign({}, opts || {}, { signal: ac.signal }));
        } finally {
            clearTimeout(timer);
        }
    }

    async function requestJson(url, retries, credentials) {
        retries = retries == null ? CONFIG.retries : retries;
        credentials = credentials || "same-origin";
        let status = -1;
        for (let attempt = 0; attempt <= retries; attempt++) {
            if (runtime.aborted) return { ok: false, aborted: true, status: -2 };
            try {
                const r = await fetchWithTimeout(url, { headers: apiHeaders(), credentials: credentials });
                const ct = (r.headers.get("content-type") || "").toLowerCase();
                if (r.status === 401) return { ok: false, status: 401, auth: true };

                let data = null;
                if (ct.indexOf("json") >= 0) {
                    try { data = await r.json(); } catch (e) { data = null; }
                }
                if (r.ok && data !== null) { noteSuccess(); return { ok: true, status: r.status, data: data }; }

                status = r.status;
                if (r.status === 429 || r.status >= 500 || ct.indexOf("json") < 0) {
                    noteThrottled(r.status);
                    await sleep(1500 + attempt * 2500 + Math.random() * 800);
                    continue;
                }
                return { ok: false, status: r.status, data: data };
            } catch (e) {
                status = -1;
                await sleep(800 * (attempt + 1));
            }
        }
        return { ok: false, status: status };
    }

    const LICENSE_PRIORITY = { professional: 0, personal: 1, "uefn-reference-only": 2 };

    function normalizeFreeOfferId(lic) {
        return lic.offerId || lic.uid || lic.listingLicenseId || null;
    }

    // Does this asset offer a professional tier at all? Read from the search
    // payload, which carries licence names but not their offer ids.
    function hasProfessionalTier(licenses) {
        if (!Array.isArray(licenses)) return false;
        for (let i = 0; i < licenses.length; i++) {
            const lic = licenses[i] || {};
            const slug = (lic.slug || "").toLowerCase();
            const name = ((lic.name || "") + " " + (lic.slug || "")).toLowerCase();
            if (slug === "professional" || name.indexOf("professional") >= 0 || name.indexOf("专业") >= 0) return true;
        }
        return false;
    }

    function findFreeOffer(licenses) {
        if (!Array.isArray(licenses) || licenses.length === 0) return null;
        let best = null;
        let bestPriority = Infinity;
        for (let i = 0; i < licenses.length; i++) {
            const lic = licenses[i] || {};
            const pt = lic.priceTier || {};
            const isFree = pt.price === 0 || pt.price === "0" ||
                pt.discountedPrice === 0 || pt.discountedPrice === "0";
            if (!isFree) continue;
            const slug = (lic.slug || "").toLowerCase();
            const name = (lic.name || "").toLowerCase();
            let priority = 2;
            if (Object.prototype.hasOwnProperty.call(LICENSE_PRIORITY, slug)) priority = LICENSE_PRIORITY[slug];
            else if (name.indexOf("professional") >= 0 || name.indexOf("专业") >= 0) priority = 0;
            else if (name.indexOf("personal") >= 0 || name.indexOf("个人") >= 0) priority = 1;
            if (priority < bestPriority) { bestPriority = priority; best = lic; }
        }
        return best ? normalizeFreeOfferId(best) : null;
    }

    // Bundles (and a few other free listings) refuse add-to-library outright:
    // FAB answers 400 {"detail":["Listing is a bundle."]} and only sells them
    // through the cart. So the script puts them in the cart instead, and one
    // checkout at the end collects the whole batch.
    //
    // The checkout page itself sits behind Epic's hCaptcha/talon check — that
    // step stays with the person, by design. Everything up to it is automated,
    // and the finish effect waits for the order instead of firing early.
    async function resolveCartLicense(item) {
        // A bundle answers on /i/bundles/<uid>, a normal listing on
        // /i/listings/<uid>; try the bundle route first and fall back, so the
        // caller never has to know which one it is holding.
        let data = null;
        const routes = ["/i/bundles/" + item.uid, "/i/listings/" + item.uid];
        for (let i = 0; i < routes.length; i++) {
            const r = await requestJson(routes[i], 1);
            if (r.auth) throw { fatal: "auth" };
            if (r.ok && r.data) { data = r.data; break; }
        }
        if (!data) return null;
        const list = data.licenses || [];
        // Only a licence that is actually free may be parked in the cart: a
        // professional tier can cost money even when the personal one is free,
        // and the cart would then wait for a payment. Among the free tiers the
        // professional one still wins, because it grants more.
        const free = list.filter(function (lic) {
            const pt = (lic && lic.priceTier) || {};
            return pt.price === 0 || pt.price === "0" ||
                pt.discountedPrice === 0 || pt.discountedPrice === "0";
        });
        let pick = null;
        for (let i = 0; i < free.length; i++) {
            const slug = (free[i].slug || "").toLowerCase();
            if (slug === "professional") { pick = free[i]; break; }
            if (slug === "personal" && !pick) pick = free[i];
        }
        if (!pick) pick = free[0] || null;
        if (!pick) {
            // Nothing free: fall back to a tier that at least carries an id, but
            // only when the listing itself claims a zero price.
            const zeroish = list.filter(function (lic) {
                const pt = (lic && lic.priceTier) || {};
                return !pt.price && !pt.discountedPrice;
            });
            pick = zeroish[0] || null;
        }
        return pick && pick.listingLicenseId ? pick.listingLicenseId : null;
    }

    // POST /i/cart/clear is the only whole-cart call the site accepts: DELETE
    // /i/cart answers 405, and a stuck cart cannot be enumerated item by item
    // because GET /i/cart is the very request that stops responding.
    async function postClearCart() {
        try {
            const r = await fetchWithTimeout("/i/cart/clear", {
                method: "POST",
                headers: apiHeaders({ "Accept": "application/json", "Content-Type": "application/json" }),
                body: "{}",
                credentials: "same-origin"
            });
            return r.status === 204 || r.ok;
        } catch (e) {
            return false;
        }
    }

    async function postCartItem(listingLicenseId) {
        for (let attempt = 0; attempt <= CONFIG.retries; attempt++) {
            if (runtime.aborted) return { ok: false, aborted: true };
            try {
                const r = await fetchWithTimeout("/i/cart/items", {
                    method: "POST",
                    headers: apiHeaders({ "Accept": "application/json", "Content-Type": "application/json" }),
                    body: JSON.stringify({ listingLicense: listingLicenseId }),
                    credentials: "same-origin"
                });
                if (r.status === 200 || r.status === 201) { noteSuccess(); return { ok: true }; }
                if (r.status === 401) return { ok: false, status: 401, auth: true };
                const txt = await r.text().catch(function () { return ""; });
                if (/already|exists|已在|重复/i.test(txt)) return { ok: true, already: true };
                if (r.status === 429 || r.status >= 500) {
                    noteThrottled(r.status);
                    await sleep(1000 + attempt * 1500);
                    continue;
                }
                return { ok: false, status: r.status, body: txt };
            } catch (e) {
                await sleep(700 * (attempt + 1));
            }
        }
        return { ok: false, status: -1 };
    }

    // Park one listing in the cart; returns true when it landed there.
    // A bundle reports "acquired" as soon as one child is owned, so the state
    // list cannot answer "do I already own this whole bundle". The bundle detail
    // does: ownsBundledListing is true only when every child is accounted for,
    // and adding a bundle the account already owns only clutters the cart and
    // makes the checkout reject the order.
    async function bundleAlreadyOwned(uid) {
        try {
            const r = await requestJson("/i/bundles/" + uid, 1);
            if (r.auth) throw { fatal: "auth" };
            return !!(r.ok && r.data && r.data.ownsBundledListing === true);
        } catch (e) {
            if (e && e.fatal) throw e;
            return false;
        }
    }

    async function addToCart(item) {
        if (CONFIG.cartMax && runtime.carted.length >= CONFIG.cartMax) {
            runtime.cartFull = true;
            return false;
        }
        try {
            if (!item.isBundle) item.isBundle = false;
            const licId = await resolveCartLicense({
                uid: item.uid,
                type: item.listingType || (item.isBundle ? "bundle" : "")
            });
            if (!licId) return false;
            const r = await postCartItem(licId);
            if (r.auth) throw { fatal: "auth" };
            return !!r.ok;
        } catch (e) {
            if (e && e.fatal) throw e;
            return false;
        }
    }

    // The panel counts what this browser thinks is parked in the cart, and that
    // list outlives the cart itself: FAB empties the cart after an order, a
    // person can clear it by hand, and a run can end without the order ever
    // being placed. So the local list is checked against the real cart before
    // it is shown as "checkout (N)" or used to re-add anything.
    async function reconcileCart() {
        if (!runtime.carted || !runtime.carted.length) return;
        let r = null;
        try { r = await requestJson("/i/cart", 0); } catch (e) { return; }
        if (!r || !r.ok || !r.data) return;
        const items = Array.isArray(r.data.items) ? r.data.items : [];
        const present = items.map(function (i) { return i && i.listingUid; }).filter(Boolean);
        // A non-empty cart that matches none of the recorded uids means the two
        // sides name the same thing differently: trusting that result would wipe
        // a valid list, so nothing is changed in that case.
        if (present.length && !present.some(function (u) { return runtime.carted.indexOf(u) >= 0; })) return;
        const keep = runtime.carted.filter(function (u) { return present.indexOf(u) >= 0; });
        if (keep.length === runtime.carted.length) return;
        const dropped = runtime.carted.length - keep.length;
        runtime.carted = keep;
        if (store.carted) {
            Object.keys(store.carted).forEach(function (u) {
                if (present.indexOf(u) < 0) delete store.carted[u];
            });
        }
        saveCartPending();
        saveStore();
        log(t("logCartReconciled", dropped));
    }

    // After the run: open the cart, keep the panel honest about what it is
    // waiting for, and watch the cart until the order goes through.
    async function checkoutCarted() {
        // Anything already in the library is not ours to check out again: this
        // is what produced a cart full of owned items and an order that added
        // nothing.
        runtime.carted = (runtime.carted || []).filter(function (u) { return !store.done[u]; });
        // Anything the cart itself no longer holds is not payable either.
        await reconcileCart();
        const n = runtime.carted.length;
        if (!n) { saveCartPending(); return; }
        // One last look at the cart: a request that reported success can still
        // have been dropped, and a half-filled cart would be a silent loss.
        const cartNow = await requestJson("/i/cart", 1);
        if (cartNow.ok && cartNow.data) {
            const present = (cartNow.data.items || []).map(function (i) { return i.listingUid; });
            const missing = runtime.carted.filter(function (u) { return present.indexOf(u) < 0; });
            for (let i = 0; i < missing.length; i++) {
                const ok = await addToCart({ uid: missing[i] });
                if (!ok && runtime.carted.indexOf(missing[i]) >= 0) runtime.carted.splice(runtime.carted.indexOf(missing[i]), 1);
            }
            saveCartPending();
        }
        setStatus(t("cartAsk", n));
        toast(t("cartAsk", n), "info", 8000);
        log(t("cartAsk", n));
        // No window.open here: a blocked popup would navigate this tab and kill
        // the poller. The person opens the cart with the panel button instead,
        // so this page stays alive to catch the order.

        if (runtime.cartTimer) clearInterval(runtime.cartTimer);
        const deadline = Date.now() + 15 * 60 * 1000;
        runtime.cartTimer = setInterval(async function () {
            if (Date.now() > deadline) { clearInterval(runtime.cartTimer); runtime.cartTimer = null; return; }
            const r = await requestJson("/i/cart", 0);
            if (!r.ok || !r.data) return;
            const items = r.data.items || [];
            setStatus(t("cartWait", items.length));
            if (items.length) return;
            // Empty cart: the order went through. Confirm each uid really is
            // acquired before claiming this as a success.
            clearInterval(runtime.cartTimer);
            runtime.cartTimer = null;
            const uids = runtime.carted.slice(0);
            const q = uids.map(function (u) { return "listing_ids=" + encodeURIComponent(u); }).join("&");
            const st = await requestJson("/i/users/me/listings-states?" + q, 1);
            let got = 0;
            if (st.ok && Array.isArray(st.data)) {
                for (let i = 0; i < st.data.length; i++) if (st.data[i] && st.data[i].acquired) got++;
            }
            if (!got) {
                // The cart is empty but nothing is actually owned: do not
                // celebrate a purchase that did not happen.
                runtime.carted.length = 0;
                uids.forEach(function (u) { if (store.carted) delete store.carted[u]; });
                saveCartPending();
                saveStore();
                setStatus(t("cartMiss"));
                toast(t("cartMiss"), "warning", 6000);
                render();
                return;
            }
            runtime.stats.added += got;
            for (let i = 0; i < uids.length; i++) {
                store.done[uids[i]] = 1;
                markSavedOnPage(uids[i]);
                // The library owns them now, so they must never come back as
                // pending cart items on the next run.
                if (store.carted) delete store.carted[uids[i]];
            }
            runtime.carted.length = 0;
            saveCartPending();
            setStatus(t("cartDone", got));
            toast(t("cartDone", got), "success", 6000);
            saveStore();
            render();
            playDoneFx(runtime.stats.added);
        }, 4000);
    }

    async function postAddToLibrary(uid, offerId) {
        // A transport failure is not an answer: the claim may still go through on
        // the next attempt, so it gets two extra tries on a slower ladder than a
        // real HTTP refusal.
        const attempts = CONFIG.retries + 2;
        let lastHttp = null;
        for (let attempt = 0; attempt <= attempts; attempt++) {
            if (runtime.aborted) return { ok: false, aborted: true };
            try {
                const fd = new FormData();
                fd.append("offer_id", offerId);
                const r = await fetchWithTimeout("/i/listings/" + uid + "/add-to-library", {
                    method: "POST",
                    headers: apiHeaders({ "Accept": "*/*" }),
                    body: fd,
                    credentials: "same-origin"
                });
                if (r.status === 200 || r.status === 201 || r.status === 204) {
                    noteSuccess();
                    return { ok: true };
                }
                if (r.status === 401) return { ok: false, status: 401, auth: true };
                const txt = await r.text().catch(function () { return ""; });
                if (/already|exists|已在|已保存|已添加|已拥有|重复/i.test(txt)) {
                    return { ok: true, already: true };
                }
                if (r.status === 429 || r.status >= 500) {
                    noteThrottled(r.status);
                    lastHttp = { status: r.status, body: txt.slice(0, 200) };
                    await sleep(1500 + attempt * 2500 + Math.random() * 800);
                    continue;
                }
                return { ok: false, status: r.status, body: txt.slice(0, 200) };
            } catch (e) {
                await sleep(1200 * (attempt + 1));
            }
        }
        // Every attempt was a transport failure only then -1; a server answer
        // that repeated is reported with its own status so it can be told apart
        // from a lost connection.
        if (lastHttp) return { ok: false, status: lastHttp.status, body: lastHttp.body };
        return { ok: false, status: -1, body: "network" };
    }

    /* ---------------------------------------------------------------- *
     * scan one page (anonymous catalogue read)
     * ---------------------------------------------------------------- */

    async function scanNextPage() {
        if (runtime.endReached || runtime.aborted) return false;
        if (runtime.pages >= CONFIG.maxPages) {
            runtime.endReached = true;
            log(t("logMaxPages", CONFIG.maxPages));
            return false;
        }

        const q = baseParams();
        // While re-reading the head, always ask for the newest first: the page
        // itself may be sorted by relevance or price, and then the newest
        // listings are not at the top at all.
        if (!runtime.headDone) q.set("sort_by", "-firstPublishedAt");
        if (runtime.cursor) q.set("cursor", runtime.cursor);

        const r = await requestJson("/i/listings/search?" + q.toString(), CONFIG.retries, scanCredentials());
        if (r.auth) throw { fatal: "auth" };
        if (!r.ok) {
            if (runtime.pages === 0) throw { fatal: "index", message: t("logIndexFatal", r.status) };
            log(t("logIndexFail", r.status));
            await sleep(1500);
            return false;
        }

        const results = (r.data && r.data.results) || [];
        // 200 + zero results + no cursor: either FAB's soft block or the true end.
        // A throttled page looks exactly like the end, so retry before believing it.
        if (results.length === 0 && !(r.data && r.data.cursors && r.data.cursors.next)) {
            if (runtime.pages === 0) throw { fatal: "blocked", message: t("logEmptyFatal") };
            runtime.emptyStreak = (runtime.emptyStreak || 0) + 1;
            if (runtime.emptyStreak <= 6) {
                log(t("logEmptyPage", runtime.emptyStreak));
                runtime.concurrency = Math.max(CONFIG.minConcurrency, runtime.concurrency - 1);
                await sleep(2000 + runtime.emptyStreak * 1200);
                return false;
            }
            runtime.endReached = true;
            return false;
        }
        runtime.emptyStreak = 0;

        let candidates = [];
        for (let i = 0; i < results.length; i++) {
            const it = results[i];
            if (!it || !it.uid) continue;
            if (store.done[it.uid]) continue;
            const sp = it.startingPrice || {};
            const price = (typeof sp.price === "number") ? sp.price : null;
            if (CONFIG.forceFree && price !== null && price > 0) continue; // is_free can slip past
            if (runtime.queue.some(function (x) { return x.uid === it.uid; })) continue;
            candidates.push({
                uid: it.uid,
                title: (it.title || "").replace(/[\n\r]+/g, " ").trim() || ("Asset " + it.uid.slice(0, 8)),
                offerId: sp.offerId || "",
                price: price,
                // The search payload already lists the licence tiers by name (no
                // offer id, though). Knowing a professional tier exists is enough
                // to decide that this item needs the detail lookup, so single-tier
                // assets keep the one-request fast path.
                hasPro: hasProfessionalTier(it.licenses),
                // A bundle is sold through the cart only; the type is carried
                // here so the import step knows which detail route to read.
                listingType: it.listingType || ""
            });
        }

        // Ownership is verified in the background so the next page request can
        // start immediately; verified items drop into the queue as they clear.
        const fresh = candidates.length;
        queueCandidates(candidates);

        runtime.pages++;
        if (runtime.headLeft > 0) runtime.headLeft--;
        // Head pages done: jump back to where the previous run stopped.
        if (!runtime.headDone && runtime.headLeft <= 0 && runtime.resumeCursor) {
            runtime.headDone = true;
            runtime.cursor = runtime.resumeCursor;
            runtime.resumeCursor = null;
            delete store.resumeCursor;
            saveStore();
        }
        runtime.stats.indexed += fresh;
        runtime.stats.pending = runtime.queue.length;

        // Cursor keeps moving but the page yields nothing new: the index has been
        // cycling back to the same slice, so this is a real ceiling, not a throttle.
        if (fresh === 0) {
            // The head pages are usually all owned already on a big account.
            // That proves nothing, and treating it as the end would stop before
            // the jump back to the real break point.
            if (!runtime.headDone) runtime.dupStreak = 0;
            else runtime.dupStreak = (runtime.dupStreak || 0) + 1;
            // A big account can walk through slices that are entirely owned, or
            // a page the server repeats while throttling; 12 pages stopped such a
            // scan far too early, 25 is a ceiling worth trusting.
            if (runtime.headDone && runtime.dupStreak >= 25) {
                log(t("logDupPages", runtime.dupStreak));
                runtime.endReached = true;
            }
        } else {
            runtime.dupStreak = 0;
        }

        // A throttled page can come back with results but no next cursor, which is
        // indistinguishable from the last page. Treat that as the throttle it is:
        // back off, narrow the window, and only give up after several attempts.
        const nextCursor = (r.data.cursors && r.data.cursors.next) || null;
        if (nextCursor) {
            runtime.noNextStreak = 0;
            runtime.cursor = nextCursor;
        } else if (results.length > 0 && results.length < CONFIG.pageSize && !runtime.headDone && runtime.resumeCursor) {
            // The newest slice ran out while re-reading the head: that is not the
            // end of the catalogue the saved cursor points into, so jump back now.
            runtime.headDone = true;
            runtime.headLeft = 0;
            runtime.cursor = runtime.resumeCursor;
            runtime.resumeCursor = null;
            delete store.resumeCursor;
        } else if (results.length > 0 && results.length < CONFIG.pageSize) {
            // A short page is proof the index ran out: a throttled answer still
            // fills the window it was asked for, it only withholds the cursor.
            // Believing this straight away ends a single-page view (a channel
            // page with a dozen hits) in one request instead of six retries.
            runtime.noNextStreak = 0;
            runtime.endReached = true;
        } else {
            runtime.noNextStreak = (runtime.noNextStreak || 0) + 1;
            if (runtime.noNextStreak <= 6) {
                runtime.concurrency = Math.max(CONFIG.minConcurrency, runtime.concurrency - 1);
                saveStore();
                render();
                log(t("logNoCursor", runtime.noNextStreak));
                await sleep(2000 + runtime.noNextStreak * 1200);
                return true;
            }
            runtime.cursor = null;
            runtime.endReached = true;
        }
        saveStore();
        render();
        return true;
    }

    /* ---------------------------------------------------------------- *
     * ownership check (only when the account does not hide library items)
     * ---------------------------------------------------------------- */

    // Fire-and-forget ownership verification: the scan loop keeps moving while
    // these run in parallel, and each page's survivors appear in the queue.
    function queueCandidates(list) {
        if (!list.length) return;
        if (runtime.hiddenLibrary) {
            list.forEach(function (it) {
                if (!runtime.queue.some(function (x) { return x.uid === it.uid; })) runtime.queue.push(it);
            });
            return;
        }
        runtime.checkJobs = runtime.checkJobs || [];
        runtime.checkJobs.push((async function () {
            try {
                const res = await fetchOwned(list.map(function (x) { return x.uid; }));
                const owned = res.owned;
                const entitled = res.entitled;
                let pushed = 0;
                list.forEach(function (it) {
                    // A bundle reports acquired=true as soon as the account owns
                    // any single listing inside it, so that flag cannot be read as
                    // "you already own this bundle": only a real entitlement
                    // counts, otherwise the bundle still needs the cart.
                    const bundle = /bundle/i.test(it.listingType || "");
                    let mine;
                    if (!bundle) mine = owned.has(it.uid);
                    else if (CONFIG.bundleOwnedCheck === "off") mine = false;
                    else if (CONFIG.bundleOwnedCheck === "on") mine = owned.has(it.uid);
                    else mine = entitled.has(it.uid);
                    if (mine) { runtime.stats.skipped++; return; }
                    if (runtime.queue.some(function (x) { return x.uid === it.uid; })) return;
                    runtime.queue.push(it);
                    pushed++;
                });
                runtime.stats.indexed += pushed;
                render();
            } catch (e) {
                if (e && e.fatal === "auth") { runtime.lastError = "auth"; runtime.aborted = true; }
                else log(t("logOwnedFail", (e && e.message ? e.message : e)));
            }
        })());
    }


    async function fetchOwned(uids) {
        const owned = new Set();
        // acquired alone is not ownership for a bundle; an entitlement id is.
        const entitled = new Set();
        const chunks = [];
        for (let i = 0; i < uids.length; i += CONFIG.stateChunkSize) chunks.push(uids.slice(i, i + CONFIG.stateChunkSize));

        let idx = 0;
        const workers = [];
        async function worker() {
            while (idx < chunks.length && !runtime.aborted) {
                const chunk = chunks[idx++];
                const q = chunk.map(function (id) { return "listing_ids=" + encodeURIComponent(id); }).join("&");
                // One row per requested id. A short answer means throttling,
                // not "user owns nothing" — retry instead of inventing misses.
                let rows = null;
                for (let attempt = 0; attempt < 4; attempt++) {
                    const r = await requestJson("/i/users/me/listings-states?" + q);
                    if (r.auth) throw { fatal: "auth" };
                    if (r.ok && Array.isArray(r.data) && r.data.length >= chunk.length) { rows = r.data; break; }
                    if (r.aborted) break;
                    await sleep(1200 * (attempt + 1));
                }
                if (rows) {
                    for (let i = 0; i < rows.length; i++) {
                        const row = rows[i];
                        if (!row || row.acquired !== true || !row.uid) continue;
                        owned.add(row.uid);
                        if (row.entitlementId) entitled.add(row.uid);
                    }
                } else {
                    log(t("logOwnedShort", chunk.length));
                }
            }
        }
        for (let i = 0; i < Math.min(CONFIG.indexConcurrency, chunks.length); i++) workers.push(worker());
        await Promise.all(workers);
        return { owned: owned, entitled: entitled };
    }

    // Who is signed in? The panel shows it next to the phase, because every
    // request this script makes is sent as that account — and a sculpture of
    // "why did nothing land in my library" usually starts with being signed out
    // or being on a different account than expected.
    async function loadMe() {
        if (runtime.userChecked) return;
        try {
            const r = await requestJson("/i/users/me", 0);
            runtime.userName = (r.ok && r.data && (r.data.displayName || r.data.name)) || "";
        } catch (e) {
            runtime.userName = "";
        }
        runtime.userChecked = true;
        render();
    }

    // Is Fab hiding assets that are already in the library? When it is,
    // search results are already "not owned", so checking is wasted work.
    async function detectHiddenLibrary() {
        if (CONFIG.ownedCheck === "on") { runtime.hiddenLibrary = false; return false; }
        if (CONFIG.ownedCheck === "off") { runtime.hiddenLibrary = true; return true; }
        try {
            const probe = baseParams();
            probe.delete("cursor");
            const sess = await requestJson("/i/listings/search?" + probe.toString(), 0, scanCredentials());
            const sessRows = (sess.ok && sess.data && sess.data.results) ? sess.data.results : [];
            if (sessRows.length === 0) {                   // everything filtered out
                runtime.hiddenLibrary = true;
                log(t("logHiddenOn"));
                return true;
            }
            const ids = sessRows.slice(0, CONFIG.stateChunkSize).map(function (x) { return x.uid; });
            const res = await fetchOwned(ids);
            runtime.hiddenLibrary = res.owned.size === 0;
            log(runtime.hiddenLibrary
                ? t("logHiddenSearch")
                : t("logKeepCheck"));
            return runtime.hiddenLibrary;
        } catch (e) {
            log(t("logDetectFail", (e && e.message ? e.message : e)));
            return false;
        }
    }

    /* ---------------------------------------------------------------- *
     * import one batch
     * ---------------------------------------------------------------- */

    // Detail lookup: only used as a fallback, so the happy path stays one request
    // per asset (the search payload already carries the free offer id).
    async function resolveOfferId(item) {
        const d = await requestJson("/i/listings/" + item.uid);
        if (d.auth) return { auth: true };
        if (d.ok && d.data) {
            const offer = findFreeOffer(d.data.licenses);
            if (offer) return { offerId: offer };
            if (d.data.licenses && d.data.licenses.length) return { notFree: true };
        }
        if (item.offerId) return { offerId: item.offerId };
        return { none: true };
    }

    // One notice per run: the cart is full, the rest of the queue would only
    // pile up until the cart page stops rendering.
    function noteCartFull() {
        if (runtime.cartFullReported) return;
        runtime.cartFullReported = true;
        runtime.stats.skipped++;
        toast(t("logCartFull", runtime.carted.length), "warning", 6000);
        log(t("logCartFull", runtime.carted.length));
        pause();
    }

    // Park one item in the cart and record it in every place that tracks it.
    function markCarted(item) {
        if (runtime.carted.indexOf(item.uid) >= 0) return;
        runtime.stats.carted = (runtime.stats.carted || 0) + 1;
        runtime.carted.push(item.uid);
        if (!store.carted) store.carted = {};
        store.carted[item.uid] = 1;
        saveCartPending();
        assetBubble(item.title, runtime.stats.carted);   // the bubble marks it as queued
        render();
    }

    async function addOne(item) {
        if (runtime.aborted) return;
        if (store.done[item.uid]) { runtime.stats.skipped++; return; }
        // Parked in the cart by an earlier run: a second add leaves a duplicate
        // row, and the empty order that follows then looks like a failure.
        if (store.carted && store.carted[item.uid]) { runtime.stats.skipped++; return; }

        // A bundle can never be claimed through add-to-library: that endpoint
        // always answers 400 "Listing is a bundle.". Going straight to the cart
        // saves the round trip that would only be thrown away.
        if (/bundle/i.test(item.listingType || "")) {
            if (await bundleAlreadyOwned(item.uid)) {
                store.done[item.uid] = 1;
                runtime.stats.skipped++;
                return;
            }
            if (await addToCart(item)) { markCarted(item); return; }
            if (runtime.cartFull) { noteCartFull(); return; }
            runtime.stats.failed++; runtime.failStreak = (runtime.failStreak || 0) + 1; store.failed[item.uid] = "cart";
            return;
        }

        let offerId = item.offerId || "";

        // A dual-licensed free asset must be claimed on the professional tier:
        // the offer id the search returns is the personal one, so asking the
        // detail endpoint first is the only way to get the professional id.
        // One extra request, only for items that actually have that tier.
        if (CONFIG.preferProfessional && item.hasPro) {
            const pro = await resolveOfferId(item);
            if (pro.auth) throw { fatal: "auth" };
            if (pro.offerId) offerId = pro.offerId;
            else if (pro.notFree) { store.done[item.uid] = 1; runtime.stats.skipped++; return; }
        }

        if (!offerId) {
            const res = await resolveOfferId(item);
            if (res.auth) throw { fatal: "auth" };
            if (res.notFree) { store.done[item.uid] = 1; runtime.stats.skipped++; return; }
            if (!res.offerId) {
                runtime.stats.failed++;
                store.failed[item.uid] = "no-free-offer";
                return;
            }
            offerId = res.offerId;
        }

        let added = await postAddToLibrary(item.uid, offerId);

        // The professional tier can be refused (bundle edge case, licence not
        // actually free). Then the personal offer is the one still worth trying,
        // so the retry walks the other candidate rather than re-sending the same
        // offer that just failed.
        if (!added.ok && !added.auth && !/bundle/i.test(added.body || "")) {
            const alt = await resolveOfferId(item);
            if (alt.auth) throw { fatal: "auth" };
            const others = [alt.offerId, item.offerId].filter(Boolean);
            for (let i = 0; i < others.length; i++) {
                if (others[i] === offerId) continue;
                added = await postAddToLibrary(item.uid, others[i]);
                if (added.ok) break;
                if (added.auth) throw { fatal: "auth" };
                if (/bundle/i.test(added.body || "")) break;
            }
        }

        if (added.auth) throw { fatal: "auth" };
        if (added.ok) {
            store.done[item.uid] = 1;
            if (store.failed[item.uid]) delete store.failed[item.uid];
            if (!added.already) {
                store.added = (store.added || 0) + 1;
                runtime.stats.added++;
                assetBubble(item.title, runtime.stats.added);
                markSavedOnPage(item.uid);
            }
            runtime.successStreak = (runtime.successStreak || 0) + 1;
            runtime.failStreak = 0;
        } else {
            // Bundles (and any other free type the claim endpoint refuses) go
            // into the cart instead of being written off as a skip: one
            // checkout at the end collects them all.
            let carted = false;
            // 400/403 means the claim endpoint refuses this kind of listing; a
            // repeating 5xx means it is broken for this listing alone. Both end
            // in the cart: a free licence there still reaches the account at the
            // next checkout, which is better than a silent "failed" entry.
            const isRefusal = added.status === 400 || added.status === 403;
            const isServerError = added.status >= 500;
            if ((isRefusal || isServerError) && !added.auth) {
                carted = await addToCart(item);
            }
            if (carted) {
                markCarted(item);
            } else {
                runtime.stats.failed++;
                runtime.failStreak = (runtime.failStreak || 0) + 1;
                // Only a real answer is remembered. A transport failure is left
                // out so the next run tries the asset again instead of treating
                // a lost connection as a permanent rejection.
                if (added.status !== -1) store.failed[item.uid] = "status " + added.status + (added.body ? " " + added.body : "");
            }
        }
    }

    // Import `items` with a continuous worker pool: every worker keeps taking the
    // next asset instead of waiting for a whole wave to finish, which is what
    // makes the run feel like a stream rather than a series of slow bursts.
    async function importBatch(items) {
        // Queue items were already ownership-checked while scanning, so there is
        // no second pass here — that extra round trip per batch is what made
        // importing feel sluggish.
        // Items already parked in the cart must not be added twice.
        let batch = items.filter(function (i) {
            return !store.done[i.uid] && !(store.carted && store.carted[i.uid]) &&
                runtime.carted.indexOf(i.uid) < 0;
        });

        const total = batch.length;
        let next = 0;
        let done = 0;

        async function worker() {
            while (!runtime.aborted) {
                while (runtime.paused && !runtime.manual && !runtime.aborted) await sleep(150);
                if (runtime.aborted) return;
                const i = next++;
                if (i >= total) return;
                const it = batch[i];
                try {
                    await addOne(it);
                } catch (e) {
                    if (e && e.fatal) { runtime.lastError = e.fatal; runtime.aborted = true; return; }
                    runtime.stats.failed++;
                    log(t("logAddFail", (e && e.message ? e.message : e)));
                }
                done++;
                setProgress(done / Math.max(1, total), t("batchProgress", done, total));
                render();
                if (done % 20 === 0) saveStore();
                if (!runtime.aborted && done < total) {
                    if (CONFIG.cooldownEvery && done % CONFIG.cooldownEvery === 0) {
                        log(t("logCooldown", done));
                        await sleep(CONFIG.cooldownMs);
                    } else {
                        const rest = CONFIG.waveDelay + Math.random() * CONFIG.waveJitter;
                        if (rest > 0) await sleep(rest);
                    }
                }
                // noteSuccess / noteThrottled widen or narrow the window globally.
            }
        }

        const n = Math.max(1, Math.min(runtime.concurrency, total));
        const workers = [];
        for (let w = 0; w < n; w++) workers.push(worker());
        await Promise.all(workers);
        setProgress(1, t("batchProgress", done, total));
        saveStore();
    }

    /* ---------------------------------------------------------------- *
     * orchestration: one producer keeps scanning, a worker pool keeps
     * importing — no batch barrier, so assets land as they are found.
     * ---------------------------------------------------------------- */

    async function run() {
        let feedDone = false;
        let imported = 0;

        async function consumer() {
            while (true) {
                if (runtime.aborted) return;
                while (runtime.paused && !runtime.manual && !runtime.aborted) await sleep(150);
                if (runtime.aborted) return;
                const it = runtime.queue.shift();
                if (!it) {
                    if (feedDone) return;
                    await sleep(25);
                    continue;
                }
                runtime.stats.pending = runtime.queue.length;
                try {
                    await addOne(it);
                } catch (e) {
                    if (e && e.fatal) { runtime.lastError = e.fatal; runtime.aborted = true; return; }
                    runtime.stats.failed++;
                    log(t("logAddFail", (e && e.message ? e.message : e)));
                }
                imported++;
                runtime.stats.pending = runtime.queue.length;
                if (runtime.batchSize) setProgress((imported % runtime.batchSize) / runtime.batchSize, t("batchProgress", imported % runtime.batchSize, runtime.batchSize));
                render();
                if (imported % 20 === 0) saveStore();
                if (CONFIG.cooldownEvery && imported % CONFIG.cooldownEvery === 0) {
                    log(t("logCooldown", imported));
                    await sleep(CONFIG.cooldownMs);
                } else {
                    const rest = CONFIG.waveDelay + Math.random() * CONFIG.waveJitter;
                    if (rest > 0) await sleep(rest);
                }
            }
        }

        const n = Math.max(1, runtime.concurrency);
        const workers = [];
        for (let w = 0; w < n; w++) workers.push(consumer());

        while (!runtime.aborted) {
            if (runtime.paused) { await sleep(200); continue; }
            if (runtime.endReached) break;
            if (runtime.maxItems && runtime.stats.indexed >= runtime.maxItems) { runtime.endReached = true; break; }
            runtime.phase = "scan";
            const more = await scanNextPage();
            if (runtime.aborted) break;
            if (!more && (runtime.endReached || runtime.emptyStreak > 2 || runtime.noNextStreak > 2)) break;
            setStatus(t("statusRunning", runtime.stats.added, runtime.queue.length, runtime.pages));
        }

        feedDone = true;
        // let every pending ownership check land before the consumers wind down
        await Promise.all((runtime.checkJobs || []).map(function (p) { return p.catch(function () { }); }));
        await Promise.all(workers);
        // A page can queue its tail after the workers already saw an empty
        // queue; drain whatever is left so "finished" really means finished.
        if (!runtime.aborted && runtime.queue.length) {
            const tail = runtime.queue.splice(0, runtime.queue.length);
            await importBatch(tail);
        }
        runtime.stats.pending = runtime.queue.length;
        saveStore();
    }

    async function start(opts) {
        opts = opts || {};
        if (isCheckoutPage()) { log(t("logCheckoutNoScan")); return; }
        if (runtime.running) { log(t("logAlreadyRunning")); return; }
        if (!getCSRFToken()) { toast(t("toastCsrf"), "error", 5000); return; }

        loadStore();
        runtime.running = true;
        runtime.aborted = false;
        runtime.paused = false;
        runtime.lastError = "";
        runtime.concurrency = opts.concurrency || CONFIG.concurrency;
        runtime.batchSize = clampBatch(opts.batch || runtime.batchSize || CONFIG.batchSize);
        runtime.endReached = false;
        runtime.stats.indexed = 0;
        runtime.stats.pending = 0;
        runtime.stats.startedAt = Date.now();
        runtime.stats.finishedAt = 0;
        runtime.stats.carted = 0;
        runtime.phase = "scan";
        runtime.queue = [];
        // The saved cursor is where the last run stopped; it is not where the new
        // listings are. Re-read the head of the index on every run, then jump back
        // to that cursor so the rest is not rescanned.
        runtime.resumeCursor = store.resumeCursor || store.cursor || null;
        // Keep it in the store too: saveStore writes store.cursor as the head
        // moves, and without a separate copy the old break point would be lost if
        // this run is interrupted before the jump.
        if (runtime.resumeCursor) store.resumeCursor = runtime.resumeCursor;
        else delete store.resumeCursor;
        runtime.headLeft = runtime.resumeCursor ? (CONFIG.headPages || 0) : 0;
        runtime.headDone = !runtime.headLeft;
        runtime.cursor = null;
        // maxPages is a per-run ceiling, so the page counter starts over; a
        // lifetime counter would eventually lock scanning out for good.
        runtime.pages = 0;
        const pending = loadCartPending();
        runtime.carted = pending.slice(0);
        // A uid that already reached the library must not come back as a
        // pending cart item: that is what made a later order try to buy assets
        // the account already owns.
        Object.keys(store.carted || {}).forEach(function (u) {
            if (store.done[u]) return;
            if (runtime.carted.indexOf(u) < 0) runtime.carted.push(u);
        });
        runtime.carted = runtime.carted.filter(function (u) { return !store.done[u]; });
        setStatus(t("statusScanning"));
        render();

        try {
            runtime.maxItems = opts.limit || 0;   // test hook: cap how many listings this run touches
            runtime.hiddenLibrary = await detectHiddenLibrary();
            await run();
            runtime.phase = "done";
            runtime.stats.finishedAt = Date.now();
            saveStore();
            if (runtime.aborted) {
                setStatus(runtime.lastError === "auth" ? t("statusAbortedAuth") : t("statusAbortedUser"));
                toast(runtime.lastError === "auth" ? t("toastAbortAuth") : t("toastAbortUser"), "warning", 5000);
            } else if (runtime.endReached) {
                setStatus(t("statusEnd", runtime.stats.added, runtime.stats.failed));
                toast(t("toastEnd", runtime.stats.added, runtime.stats.failed), "success", 6000);
                if (runtime.stats.carted) {
                    // Bundles are in the cart: the finish effect waits for the
                    // order, so it does not celebrate a cart that is not paid.
                    await checkoutCarted();
                } else {
                    playDoneFx(runtime.stats.added);
                }
            } else {
                setStatus(t("statusBatchEnd", runtime.stats.added));
                toast(t("toastBatch", runtime.stats.added), "info", 4000);
            }
        } catch (e) {
            runtime.phase = "error";
            if (e && e.fatal === "auth") {
                setStatus(t("status401"));
                toast(t("toast401"), "error", 6000);
            } else if (e && e.fatal === "blocked") {
                setStatus(t("statusRisk"));
                toast((e.message || t("statusRisk")) + " " + t("toastRisk"), "error", 8000);
            } else {
                setStatus(t("statusError", (e && e.message) || e));
                toast(t("toastError", (e && e.message) || e), "error", 6000);
            }
            runtime.lastError = (e && e.fatal) || String((e && e.message) || e);
        } finally {
            runtime.running = false;
            render();
        }
    }

    // Manual import of everything already scanned (used after a pause).
    async function importQueue() {        if (runtime.running && !runtime.paused) { log(t("logNoManual")); return; }
        if (!runtime.queue.length) { toast(t("toastNoQueue"), "warning", 3000); return; }
        if (!getCSRFToken()) { toast(t("logNoCsrfShort"), "error", 4000); return; }

        if (runtime.hiddenLibrary == null) runtime.hiddenLibrary = await detectHiddenLibrary();
        const wasRunning = runtime.running;
        runtime.running = true;
        runtime.aborted = false;
        runtime.phase = "import";
        runtime.stats.startedAt = runtime.stats.startedAt || Date.now();
        const batch = runtime.queue.splice(0, runtime.queue.length);
        runtime.stats.pending = runtime.queue.length;
        setStatus(t("statusManual", batch.length));
        render();
        try {
            runtime.manual = true;
            await importBatch(batch);
            runtime.manual = false;
            setStatus(t("statusManualDone", runtime.stats.added, runtime.stats.failed));
            toast(t("toastManualDone", runtime.stats.added), "success", 4000);
        } catch (e) {
            runtime.manual = false;
            setStatus(t("statusError", (e && e.message) || e));
        } finally {
            runtime.running = wasRunning;
            if (!runtime.queue.length) runtime.phase = wasRunning ? "scan" : "done";
            saveStore();
            render();
        }
    }

    function clampBatch(v) {
        const n = Math.floor(Number(v));
        if (!isFinite(n) || n <= 0) return CONFIG.batchSize;
        return n;                       // manual input is NOT limited to the slider range
    }

    function pause() {
        if (!runtime.running) return;
        runtime.paused = true;
        setStatus(t("statusPaused", runtime.queue.length));
        render();
    }

    function resume() {
        runtime.paused = false;
        setStatus(t("statusResume"));
        render();
    }

    function stop() {
        runtime.aborted = true;
        runtime.running = false;
        saveStore();
        setStatus(t("statusStopped", runtime.queue.length));
        render();
    }

    /* ---------------------------------------------------------------- *
     * UI
     * ---------------------------------------------------------------- */

    let el = {};
    let toastBox = null;
    let feedBox = null;
    const FEED_MAX = 9;          // bubbles kept on screen at once

    // One bubble per imported asset, stacked above the panel and fading out.
    function assetBubble(title, count) {
        if (!feedBox) return;
        const b = document.createElement("div");
        Object.assign(b.style, {
            display: "flex", alignItems: "center", gap: "8px",
            margin: "0 0 6px 0", padding: "7px 11px 7px 9px",
            maxWidth: "320px", borderRadius: "999px",
            background: "rgba(27,29,34,.96)", color: "#e6e6e6",
            border: "1px solid #33373f", borderLeft: "3px solid #45C761",
            boxShadow: "0 6px 18px rgba(0,0,0,.35)",
            fontFamily: "Segoe UI, Roboto, Arial, sans-serif", fontSize: "12px",
            opacity: "0", transform: "translateY(14px) scale(.96)",
            transition: "opacity .28s ease, transform .28s cubic-bezier(.2,.9,.3,1)",
            pointerEvents: "none"
        });

        const dot = document.createElement("span");
        Object.assign(dot.style, {
            width: "7px", height: "7px", borderRadius: "50%", background: "#45C761",
            flex: "0 0 auto", boxShadow: "0 0 6px rgba(69,199,97,.8)"
        });
        b.appendChild(dot);

        const txt = document.createElement("span");
        txt.textContent = title || t("unnamed");
        Object.assign(txt.style, { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
        b.appendChild(txt);

        if (count) {
            const n = document.createElement("span");
            n.textContent = "#" + count;
            Object.assign(n.style, { opacity: ".45", fontSize: "11px", flex: "0 0 auto" });
            b.appendChild(n);
        }

        feedBox.appendChild(b);
        while (feedBox.children.length > FEED_MAX) feedBox.removeChild(feedBox.firstChild);
        requestAnimationFrame(function () {
            b.style.opacity = "1";
            b.style.transform = "translateY(0) scale(1)";
        });
        setTimeout(function () {
            b.style.opacity = "0";
            b.style.transform = "translateY(-10px) scale(.97)";
            setTimeout(function () { if (b.parentNode) b.parentNode.removeChild(b); }, 320);
        }, 6000);
    }

    // The feed sits directly above the panel, so it has to follow its height.
    function syncFeedBottom() {
        if (!feedBox || !el.panel) return;
        // The feed sits directly above the panel, so it has to follow its height
        // and its side, now that the panel can be dragged anywhere on the page.
        const r = el.panel.getBoundingClientRect();
        feedBox.style.right = Math.max(0, Math.round(window.innerWidth - r.right)) + "px";
        feedBox.style.bottom = Math.max(0, Math.round(window.innerHeight - r.top + 8)) + "px";
    }

    /* ---------------------------------------------------------------- *
     * paint the card on the page as "已保存在我的库中"
     * ---------------------------------------------------------------- */

    const importedUids = new Map();   // uid -> timestamp of imports worth repainting
    const IMPORTED_TTL = 30 * 60 * 1000;
    const celebratedAt = new Map();   // uid -> when the sweep already played
    const CELEBRATE_GAP = 10000;      // never replay the animation for the same card
    let savedBadgeTemplate = null;    // cloned from a card the site already marks as owned

    // Fab's own label: success typography + the check-circle icon, so the
    // font, size and icon match the site exactly.
    const BADGE_HTML = '<div class="fabkit-Typography-root fabkit-Typography--align-start ' +
        'fabkit-Typography--intent-success fabkit-Text--sm fabkit-Text--regular ' +
        'fabkit-Stack-root fabkit-Stack--align_center fabkit-scale--gapX-spacing-1 ' +
        'fabkit-scale--gapY-spacing-1">' +
        '<i class="fabkit-Icon-root fabkit-Icon--intent-success fabkit-Icon--xs edsicon ' +
        'edsicon-check-circle-filled" aria-hidden="true"></i>已保存在我的库中</div>';

    // Card root = outermost ancestor that still wraps exactly one listing link.
    // (A text-length heuristic climbs into the grid, whose text holds every card.)
    function cardForUid(uid) {
        const a = document.querySelector('a[href*="/listings/' + uid + '"]');
        if (!a) return null;
        let n = a, root = null;
        for (let i = 0; i < 12 && n.parentElement; i++) {
            n = n.parentElement;
            if (n.querySelectorAll('a[href*="/listings/"]').length >= 2) break;
            root = n;
        }
        return root;
    }

    function captureSavedBadge() {
        if (savedBadgeTemplate) return savedBadgeTemplate;
        const links = document.querySelectorAll('a[href*="/listings/"]');
        for (let i = 0; i < links.length; i++) {
            const uid = ((links[i].getAttribute("href") || "").match(/listings\/([0-9a-f-]{20,})/) || [])[1];
            if (!uid) continue;
            const card = cardForUid(uid);
            if (!card || !/已保存在我的库中/.test(card.innerText || "")) continue;
            const nodes = card.querySelectorAll("div, span");
            let leaf = null;
            for (let j = 0; j < nodes.length; j++) {
                if ((nodes[j].textContent || "").trim() !== "已保存在我的库中") continue;
                if (nodes[j].querySelector("i, svg")) { leaf = nodes[j]; break; }
                if (!leaf) leaf = nodes[j];
            }
            if (leaf) { savedBadgeTemplate = leaf.cloneNode(true); return savedBadgeTemplate; }
        }
        return null;
    }

    function makeBadge() {
        const tpl = captureSavedBadge();
        if (tpl) return tpl.cloneNode(true);
        const wrap = document.createElement("div");
        wrap.innerHTML = BADGE_HTML;
        return wrap.firstChild;
    }

    // Swap the "起始价格 免费 / 免费" row for the saved badge.
    function paintSaved(uid, force) {
        const card = cardForUid(uid);
        if (!card || !card.isConnected) return false;
        if (/已保存在我的库中/.test(card.innerText || "")) {
            // Already flipped: only replay the show when the caller asks for the
            // reveal moment (card finally scrolled into view).
            if (force && runtime.effects) {
                celebratedAt.set(uid, Date.now());
                celebrateCard(card, null);
            }
            return true;
        }
        const nodes = card.querySelectorAll("div, span");
        let row = null;
        for (let i = 0; i < nodes.length; i++) {
            const e = nodes[i];
            const cls = (e.className || "").toString();
            if (cls.indexOf("align_center") < 0) continue;
            const t = (e.textContent || "").trim();
            if (!/^(起始价格\s*)?免费$/.test(t) && !/^起始价格\s*[¥$€]?\s?0/.test(t)) continue;
            row = e;
            break;
        }
        if (!row) return false;
        row.innerHTML = "";
        const badge = makeBadge();
        row.appendChild(badge);

        // Play the celebration once per card, then only keep the state in sync —
        // a repaint (React re-render, scroll tick) must never restart the sweep.
        const now = Date.now();
        const last = celebratedAt.get(uid) || 0;
        if (now - last > CELEBRATE_GAP) {
            celebratedAt.set(uid, now);
            if (runtime.effects) celebrateCard(card, badge);
        }
        return true;
    }

    // The flip: bounce + green glow + a light sweep, drawn on a body-level overlay
    // pinned to the card's rect. The overlay survives React re-rendering the card
    // subtree, so the sweep is never cut off half way.
    function celebrateCard(card, badge) {
        try {
            const GREEN = "69,199,97";
            const r0 = card.getBoundingClientRect();
            if (!r0.width || !r0.height) return;

            const radius = getComputedStyle(card).borderRadius || "10px";
            const layer = document.createElement("div");
            layer.style.cssText = "position:fixed;pointer-events:none;z-index:2147483000;" +
                "overflow:hidden;border-radius:" + radius + ";will-change:transform,box-shadow";
            layer.style.left = r0.left + "px";
            layer.style.top = r0.top + "px";
            layer.style.width = r0.width + "px";
            layer.style.height = r0.height + "px";

            const band = document.createElement("div");
            band.style.cssText = "position:absolute;top:-45%;left:0;width:36%;height:190%;" +
                "transform:rotate(18deg);filter:blur(1px);" +
                "background:linear-gradient(90deg,rgba(" + GREEN + ",0)," +
                "rgba(200,255,220,.9),rgba(" + GREEN + ",0))";
            layer.appendChild(band);
            document.body.appendChild(layer);

            // keep the overlay glued to the card for its whole life
            const t0 = performance.now();
            (function follow() {
                if (!layer.parentNode) return;
                const r = card.getBoundingClientRect();
                layer.style.left = r.left + "px";
                layer.style.top = r.top + "px";
                layer.style.width = r.width + "px";
                layer.style.height = r.height + "px";
                if (performance.now() - t0 < 1500) requestAnimationFrame(follow);
            })();

            // 1. bounce + double glow on the overlay (not on the card, so a re-render can't cut it)
            if (layer.animate) {
                layer.animate([
                    { transform: "scale(1)", boxShadow: "0 0 0 0 rgba(" + GREEN + ",0)" },
                    { transform: "scale(1.035)", boxShadow: "0 0 0 4px rgba(" + GREEN + ",.8), 0 0 38px rgba(" + GREEN + ",.7)" },
                    { transform: "scale(1.015)", boxShadow: "0 0 0 2px rgba(" + GREEN + ",.5), 0 0 20px rgba(" + GREEN + ",.4)" },
                    { transform: "scale(1.03)", boxShadow: "0 0 0 3px rgba(" + GREEN + ",.65), 0 0 30px rgba(" + GREEN + ",.55)" },
                    { transform: "scale(1)", boxShadow: "0 0 0 0 rgba(" + GREEN + ",0)" }
                ], { duration: 1500, easing: "cubic-bezier(.22,1,.36,1)" });
            }

            // 2. light sweep, one clean pass
            if (band.animate) {
                band.animate([
                    { transform: "translateX(-330%) rotate(18deg)", opacity: 0.9 },
                    { transform: "translateX(330%) rotate(18deg)", opacity: 0.9 }
                ], { duration: 1050, easing: "cubic-bezier(.3,.1,.2,1)", fill: "forwards" });
            }

            // 3. badge pops in
            if (badge && badge.animate) {
                badge.style.transformOrigin = "left center";
                badge.animate([
                    { opacity: 0, transform: "scale(.5)" },
                    { opacity: 1, transform: "scale(1.22)" },
                    { opacity: 1, transform: "scale(.96)" },
                    { opacity: 1, transform: "scale(1)" }
                ], { duration: 700, easing: "cubic-bezier(.2,1.3,.3,1)" });
            }

            setTimeout(function () {
                if (layer.parentNode) layer.parentNode.removeChild(layer);
            }, 1500);
        } catch (e) { /* animation is cosmetic only */ }
    }

    // A full-screen finish: the run reached the end and the queue is empty, so
    // the whole page is in the library. Drawn on a body-level overlay so React
    // cannot wipe it mid-animation; it fades itself out after ~3s.
    function playDoneFx(added) {
        if (!runtime.effects) return;
        try {
            const GREEN = "69,199,97";
            const CYAN = "120,220,255";
            const layer = document.createElement("div");
            layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483001;" +
                "display:flex;align-items:center;justify-content:center;overflow:hidden";
            document.body.appendChild(layer);

            const veil = document.createElement("div");
            veil.style.cssText = "position:absolute;inset:0;background:radial-gradient(circle at 50% 45%," +
                "rgba(" + GREEN + ",.22),rgba(10,12,16,.72) 70%)";
            layer.appendChild(veil);

            // three rings expanding out of the centre
            for (let i = 0; i < 3; i++) {
                const ring = document.createElement("div");
                ring.style.cssText = "position:absolute;width:120px;height:120px;border-radius:50%;" +
                    "border:2px solid rgba(" + GREEN + ",.9);box-shadow:0 0 28px rgba(" + GREEN + ",.55)";
                layer.appendChild(ring);
                if (ring.animate) {
                    ring.animate([
                        { transform: "scale(.2)", opacity: 0 },
                        { transform: "scale(1)", opacity: 1, offset: .25 },
                        { transform: "scale(6)", opacity: 0 }
                    ], { duration: 1500, delay: i * 220, easing: "cubic-bezier(.16,.8,.3,1)", fill: "forwards" });
                }
            }

            // sparkles flying outward
            for (let i = 0; i < 26; i++) {
                const dot = document.createElement("div");
                const size = 4 + Math.floor(Math.random() * 5);
                dot.style.cssText = "position:absolute;width:" + size + "px;height:" + size + "px;border-radius:50%;" +
                    "background:rgba(" + (i % 3 === 0 ? CYAN : "235,255,240") + ",.95);" +
                    "box-shadow:0 0 10px rgba(" + GREEN + ",.9)";
                layer.appendChild(dot);
                const ang = Math.random() * Math.PI * 2;
                const dist = 140 + Math.random() * 260;
                if (dot.animate) {
                    dot.animate([
                        { transform: "translate(0,0) scale(.4)", opacity: .9 },
                        { transform: "translate(" + Math.cos(ang) * dist + "px," + Math.sin(ang) * dist + "px) scale(1)", opacity: 0 }
                    ], { duration: 900 + Math.random() * 600, easing: "cubic-bezier(.2,.7,.3,1)", fill: "forwards" });
                }
            }

            const card = document.createElement("div");
            card.style.cssText = "position:relative;display:flex;flex-direction:column;align-items:center;gap:10px;" +
                "padding:26px 34px;border-radius:16px;background:rgba(20,24,30,.92);" +
                "border:1px solid rgba(" + GREEN + ",.55);box-shadow:0 0 40px rgba(" + GREEN + ",.45),0 16px 50px rgba(0,0,0,.55)";
            const mark = document.createElement("div");
            mark.style.cssText = "width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;" +
                "background:rgba(" + GREEN + ",.16);border:2px solid rgba(" + GREEN + ",.9);color:#8ff0a6;font-size:30px;line-height:1";
            mark.textContent = "✓";
            const big = document.createElement("div");
            big.style.cssText = "font-size:17px;font-weight:600;color:#eafff0;letter-spacing:.3px";
            big.textContent = t("doneAll", added);
            const sub = document.createElement("div");
            sub.style.cssText = "font-size:11px;color:#8a929e";
            sub.textContent = t("counters", runtime.stats.indexed, 0, runtime.stats.added, runtime.stats.skipped, runtime.stats.failed);
            card.appendChild(mark); card.appendChild(big); card.appendChild(sub);
            layer.appendChild(card);

            if (card.animate) {
                card.animate([
                    { transform: "scale(.8) translateY(14px)", opacity: 0 },
                    { transform: "scale(1.04) translateY(0)", opacity: 1, offset: .55 },
                    { transform: "scale(1)", opacity: 1 }
                ], { duration: 700, easing: "cubic-bezier(.2,1.25,.3,1)", fill: "forwards" });
            }
            if (veil.animate) {
                veil.animate([{ opacity: 0 }, { opacity: 1, offset: .2 }, { opacity: 1, offset: .75 }, { opacity: 0 }],
                    { duration: 3000, easing: "ease-out", fill: "forwards" });
            }
            if (layer.animate) {
                layer.animate([{ opacity: 1 }, { opacity: 1, offset: .8 }, { opacity: 0 }],
                    { duration: 3000, easing: "ease-out", fill: "forwards" });
            }
            setTimeout(function () {
                if (layer.parentNode) layer.parentNode.removeChild(layer);
            }, 3000);
        } catch (e) { /* cosmetic only */ }
    }

    function markSavedOnPage(uid) {
        if (!uid) return;
        importedUids.set(uid, Date.now());
        if (importedUids.size > 500) {
            const now = Date.now();
            importedUids.forEach(function (ts, k) {
                if (now - ts > IMPORTED_TTL) importedUids.delete(k);
            });
            if (importedUids.size > 500) importedUids.delete(importedUids.keys().next().value);
        }
        const painted = paintSaved(uid);
        // The card is off screen (or not rendered yet): hold it in the reveal
        // queue so it plays its show the moment the page reaches it.
        if (!painted || !isOnScreen(cardForUid(uid))) queueReveal(uid);
    }

    // Cards are virtualised: repaint the imported uids that are on screen now,
    // so a card scrolled into view a moment later still flips to saved — and
    // plays the celebration right then, one after another as you scroll.
    function paintTick() {
        if (!importedUids.size) return;
        const links = document.querySelectorAll('a[href*="/listings/"]');
        const seen = [];
        for (let i = 0; i < links.length; i++) {
            const m = (links[i].getAttribute("href") || "").match(/listings\/([0-9a-f-]{20,})/);
            if (!m || !importedUids.has(m[1]) || seen.indexOf(m[1]) >= 0) continue;
            seen.push(m[1]);
            const uid = m[1];
            const card = cardForUid(uid);
            const pending = revealQueue.indexOf(uid) >= 0;
            const visible = isOnScreen(card);
            paintSaved(uid, pending && visible);
            if (pending && visible) {
                const at = revealQueue.indexOf(uid);
                if (at >= 0) revealQueue.splice(at, 1);
            }
        }
    }

    /* ---------------------------------------------------------------- *
     * follow the imported cards: scroll so the user actually sees the
     * card that just flipped to "已保存在我的库中"
     * ---------------------------------------------------------------- */

    let lastUserScroll = 0;
    ["wheel", "touchmove", "keydown", "mousedown"].forEach(function (ev) {
        window.addEventListener(ev, function () { lastUserScroll = Date.now(); }, { passive: true });
    });

    const revealQueue = [];   // imported uids the user has not seen yet

    function isOnScreen(node) {
        if (!node) return false;
        const r = node.getBoundingClientRect();
        return r.bottom > 8 && r.top < (window.innerHeight - 8);
    }

    function queueReveal(uid) {
        if (revealQueue.indexOf(uid) < 0) revealQueue.push(uid);
        while (revealQueue.length > 200) revealQueue.shift();
    }

    function autoScrollStep() {
        if (!runtime.autoScroll || !runtime.running) return;
        if (Date.now() - lastUserScroll < 2500) return;         // user is scrolling, don't fight
        if (!revealQueue.length) return;

        // forget the ones the user can already see (paintTick shows them off)
        for (let i = revealQueue.length - 1; i >= 0; i--) {
            const c = cardForUid(revealQueue[i]);
            if (c && isOnScreen(c)) revealQueue.splice(i, 1);
        }
        // Only cards that are already rendered can be revealed. A queued entry with
        // no node waits in line — scanning never drags the page down to load more.
        let pick = -1;
        for (let i = 0; i < revealQueue.length; i++) {
            if (cardForUid(revealQueue[i])) { pick = i; break; }
        }
        if (pick < 0) return;
        const uid = revealQueue[pick];
        const card = cardForUid(uid);
        card.scrollIntoView({ block: "center", behavior: "smooth" });
        // flip it as soon as it lands instead of waiting for the tick
        setTimeout(function () {
            if (revealQueue.indexOf(uid) < 0) return;   // already shown by the tick
            paintSaved(uid, true);
            const at = revealQueue.indexOf(uid);
            if (at >= 0) revealQueue.splice(at, 1);
        }, 160);
        revealQueue.splice(pick, 1);
    }

    function toast(message, type, duration) {
        if (!toastBox) return;
        type = type || "success";
        duration = duration || 3000;
        const t = document.createElement("div");
        t.textContent = message;
        Object.assign(t.style, {
            margin: "5px 0", padding: "10px 14px", borderRadius: "6px", fontSize: "13px",
            color: type === "warning" ? "#111" : "#fff",
            background: type === "success" ? "#28a745" : (type === "warning" ? "#ffc107" : (type === "info" ? "#0d6efd" : "#dc3545")),
            boxShadow: "0 4px 12px rgba(0,0,0,.18)", maxWidth: "340px",
            fontFamily: "Segoe UI, Roboto, Arial, sans-serif", opacity: "0",
            transition: "opacity .25s ease"
        });
        toastBox.appendChild(t);
        requestAnimationFrame(function () { t.style.opacity = "1"; });
        setTimeout(function () {
            t.style.opacity = "0";
            setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 260);
        }, duration);
    }

    function setStatus(text) { if (el.status) el.status.textContent = text; }
    function setLogLine(text) { if (el.log) el.log.textContent = String(text).slice(0, 160); }
    function setProgress(frac, label) {
        if (el.bar) el.bar.style.width = Math.max(0, Math.min(100, frac * 100)) + "%";
        if (label && el.barLabel) el.barLabel.textContent = label;
    }

    function fmtDuration(ms) {
        const s = Math.round(ms / 1000);
        if (s < 60) return s + "s";
        const m = Math.floor(s / 60);
        return m + "m" + (s % 60) + "s";
    }

    function render() {
        if (!el.panel) return;
        const st = runtime.stats;
        const elapsed = st.startedAt ? ((st.finishedAt || Date.now()) - st.startedAt) : 0;
        const rate = elapsed > 0 ? (st.added / (elapsed / 1000)) : 0;

        el.phase.textContent = phaseLabel(runtime.phase);
        if (el.user) {
            const signed = !!runtime.userName;
            el.user.textContent = signed ? t("loginOn", runtime.userName) : (runtime.userChecked ? t("loginOff") : "");
            el.user.style.color = signed ? "#7ee08a" : "#f0b357";
            el.user.style.borderColor = signed ? "#2f5b39" : "#5a4620";
            el.user.style.background = signed ? "rgba(69,199,97,.10)" : (runtime.userChecked ? "rgba(240,179,87,.10)" : "transparent");
        }
        // The collapsed view keeps only these numbers, so it is refreshed on
        // every render even while the element is hidden.
        if (el.mini) {
            el.mini.textContent = t("miniStats", st.indexed, st.added, st.skipped, st.failed, fmtDuration(elapsed || 0));
        }
        el.counters.textContent = t("counters", st.indexed, runtime.queue.length, st.added, st.skipped, st.failed);
        el.meta.textContent = runtime.pages
            ? t("meta", runtime.concurrency, runtime.batchSize, rate.toFixed(2), runtime.pages, fmtDuration(elapsed || 0))
            : t("metaNoPage", runtime.concurrency, runtime.batchSize, rate.toFixed(2));
        if (el.owner) {
            el.owner.textContent = runtime.hiddenLibrary === true
                ? t("ownerSkipped")
                : (runtime.hiddenLibrary === false ? t("ownerOn") : "");
        }

        el.btnStart.style.display = runtime.running ? "none" : "inline-block";
        el.btnPause.style.display = runtime.running ? "inline-block" : "none";
        el.btnPause.textContent = runtime.paused ? t("resume") : t("pause");
        el.btnStop.style.display = runtime.running ? "inline-block" : "none";
        const canImport = runtime.queue.length > 0 && (!runtime.running || runtime.paused);
        el.btnImport.style.display = canImport ? "inline-block" : "none";
        el.btnImport.textContent = t("importBtn", runtime.queue.length);
        if (el.scope) {
            let scopeText = describeScope();
            if (scopeText.length > 120) scopeText = scopeText.slice(0, 118) + "…";
            el.scope.textContent = t("scopePrefix", scopeText);
        }
        if (el.btnCart) {
            const n = (runtime.carted || []).length;
            const show = !!(n && !runtime.running);
            el.cartRow.style.display = show ? "flex" : "none";
            el.btnCart.style.display = show ? "flex" : "none";
            el.btnClearCart.style.display = show ? "inline-flex" : "none";
            el.cartLabel.textContent = t("cartBtn", n);
        }
        function paintSwitch(sw, on, label) {
            if (!sw) return;
            sw.track.style.background = on ? "#45C761" : "#3a3f48";
            sw.knob.style.left = on ? "14px" : "2px";
            sw.text.textContent = label + (on ? t("onSuffix") : t("offSuffix"));
        }
        paintSwitch(el.swScroll, !!runtime.autoScroll, t("swScroll"));
        paintSwitch(el.swFx, !!runtime.effects, t("swFx"));
        syncFeedBottom();
    }

    // The cart and the Epic checkout page are not places to scan from: the panel
    // would sit on top of the payment form and its scope line would echo the
    // whole checkout URL. Those pages stay clean, and the run that parked the
    // items keeps watching the cart from its own tab.
    function isCheckoutPage() {
        const p = location.pathname || "";
        return /^\/(cart|payment)(\/|$)/i.test(p) || /\/payment\/web\//i.test(p);
    }

    // Exactly one panel per page: after ours is in the DOM, any other element
    // carrying the same id (an older copy of this script, or a copy injected
    // before the page finished loading) is dropped.
    function keepSinglePanel(panel) {
        function prune() {
            const all = document.querySelectorAll('[id="' + PANEL_ID + '"]');
            if (all.length < 2) return;
            const keep = all[0];
            for (let i = all.length - 1; i >= 1; i--) {
                const el = all[i];
                if (el && el.parentNode) el.parentNode.removeChild(el);
                if (el === panel) panel.__dropped = true;
            }
            if (keep === panel) return;
        }
        prune();
        // A second copy can arrive a moment later (DOMContentLoaded, SPA route
        // change), so check again shortly after.
        setTimeout(prune, 250);
        setTimeout(prune, 1200);
        setTimeout(prune, 4000);
    }

    function buildUI() {
        if (document.getElementById(PANEL_ID)) return;
        if (isCheckoutPage()) return;

        const panel = document.createElement("div");
        panel.id = PANEL_ID;
        if (LOCALE === "ar") panel.dir = "rtl";
        Object.assign(panel.style, {
            position: "fixed", right: "16px", bottom: "16px", width: "350px",
            zIndex: "2147483646", background: "#1b1d22", color: "#e6e6e6",
            border: "1px solid #33373f", borderRadius: "10px", padding: "12px",
            fontFamily: "Segoe UI, Roboto, Arial, sans-serif", fontSize: "12px",
            boxShadow: "0 10px 28px rgba(0,0,0,.45)", lineHeight: "1.5"
        });

        const head = document.createElement("div");
        Object.assign(head.style, {
            display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px",
            cursor: "move", userSelect: "none", touchAction: "none"
        });
        const title = document.createElement("strong");
        title.textContent = t("name") + " v3.8.2";
        title.id = "fab-bfg-title";
        title.style.cssText = "font-size:13px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
        const headRight = document.createElement("span");
        headRight.style.cssText = "display:inline-flex;align-items:center;gap:6px;min-width:0;flex:0 0 auto";
        const user = document.createElement("span");
        user.textContent = "";
        user.style.cssText = "font-size:11px;padding:1px 6px;border-radius:9px;border:1px solid #3a3f48;" +
            "color:#8a929e;max-width:118px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
        const phase = document.createElement("span");
        phase.textContent = t("idle");
        phase.style.cssText = "opacity:.7;font-size:11px";
        headRight.appendChild(user); headRight.appendChild(phase);

        // Collapse toggle: shrinks the panel down to the core numbers. The caret
        // is drawn with borders instead of the "▾" glyph, which sits off-centre
        // inside its own box in most fonts and looks glued to the button edge.
        const btnCollapse = document.createElement("button");
        btnCollapse.type = "button";
        btnCollapse.style.cssText = "flex:0 0 auto;display:flex;align-items:center;justify-content:center;" +
            "width:22px;height:22px;padding:0;margin:0;line-height:0;font-size:0;box-sizing:border-box;" +
            "border:1px solid #3a3f48;border-radius:5px;background:#24272e;color:#c9d1d9;cursor:pointer";
        const caret = document.createElement("span");
        caret.style.cssText = "display:block;width:0;height:0;border-left:4px solid transparent;" +
            "border-right:4px solid transparent;border-top:5px solid #c9d1d9;transition:transform .2s";
        btnCollapse.appendChild(caret);
        headRight.appendChild(btnCollapse);

        head.appendChild(title); head.appendChild(headRight);
        panel.appendChild(head);

        const status = document.createElement("div");
        status.textContent = t("ready");
        status.style.cssText = "margin-bottom:6px;color:#8ab4f8";
        panel.appendChild(status);

        const barWrap = document.createElement("div");
        barWrap.style.cssText = "height:6px;background:#2a2e36;border-radius:3px;overflow:hidden;margin:6px 0 4px";
        const bar = document.createElement("div");
        bar.style.cssText = "height:100%;width:0;background:#45C761;transition:width .2s";
        barWrap.appendChild(bar);
        panel.appendChild(barWrap);

        const barLabel = document.createElement("div");
        barLabel.textContent = "";
        barLabel.style.cssText = "font-size:11px;opacity:.65;margin-bottom:6px";
        panel.appendChild(barLabel);

        // batch size: slider snaps to fixed stops, number box stays free-form
        const BATCH_STOPS = [1, 10, 20, 50, 100, 200, 300, 500, 1000, 2000, 3000, 4000, 5000];
        function stopIndex(v) {
            const n = Number(v) || 0;
            let best = 0, bestD = Infinity;
            for (let i = 0; i < BATCH_STOPS.length; i++) {
                const d = Math.abs(BATCH_STOPS[i] - n);
                if (d < bestD) { bestD = d; best = i; }
            }
            return best;
        }
        const batchRow = document.createElement("div");
        batchRow.style.cssText = "display:flex;align-items:center;gap:6px;margin:4px 0 6px";
        const batchLabel = document.createElement("span");
        batchLabel.textContent = t("batch");
        batchLabel.style.cssText = "font-size:11px;opacity:.75";
        const slider = document.createElement("input");
        slider.type = "range";
        slider.min = "0";
        slider.max = String(BATCH_STOPS.length - 1);
        slider.step = "1";
        slider.value = String(stopIndex(CONFIG.batchSize));
        slider.title = BATCH_STOPS.join(" / ");
        slider.style.cssText = "flex:1;accent-color:#45C761";
        const num = document.createElement("input");
        num.type = "number";
        num.min = "1";
        num.value = String(CONFIG.batchSize);
        num.style.cssText = "width:72px;background:#24272e;color:#e6e6e6;border:1px solid #3a3f48;border-radius:5px;padding:2px 5px;font-size:12px";
        batchRow.appendChild(batchLabel); batchRow.appendChild(slider); batchRow.appendChild(num);

        // Undo: put the slider (and the number box) back to the default 100.
        const DEFAULT_BATCH = 100;
        const batchReset = document.createElement("button");
        batchReset.textContent = "↺";
        batchReset.title = t("batchReset", DEFAULT_BATCH);
        batchReset.style.cssText = "flex:0 0 auto;padding:2px 7px;line-height:1.2;border:1px solid #3a3f48;" +
            "border-radius:5px;background:#24272e;color:#8a929e;cursor:pointer;font-size:12px;transition:color .2s,border-color .2s";
        batchReset.onclick = function () {
            runtime.batchSize = DEFAULT_BATCH;
            CONFIG.batchSize = DEFAULT_BATCH;
            slider.value = String(stopIndex(DEFAULT_BATCH));
            num.value = String(DEFAULT_BATCH);
            render();
        };
        batchRow.appendChild(batchReset);
        panel.appendChild(batchRow);

        function syncBatch(v, fromSlider) {
            const n = clampBatch(v);
            runtime.batchSize = n;
            CONFIG.batchSize = n;
            if (fromSlider) num.value = String(n);
            slider.value = String(stopIndex(n));
        }
        slider.oninput = function () { syncBatch(BATCH_STOPS[Number(slider.value)] || 1, true); render(); };
        num.onchange = function () { syncBatch(num.value, false); render(); };
        num.onkeyup = function () { syncBatch(num.value, false); render(); };

        const counters = document.createElement("div");
        counters.style.cssText = "margin-bottom:2px";
        panel.appendChild(counters);

        // Cart checkout: shown once bundles have been parked in the cart, so the
        // order can still be placed when the browser blocks the popup.
        const meta = document.createElement("div");
        meta.style.cssText = "font-size:11px;opacity:.7;margin-bottom:2px";
        panel.appendChild(meta);

        const owner = document.createElement("div");
        owner.style.cssText = "font-size:11px;opacity:.55;margin-bottom:8px";
        panel.appendChild(owner);

        // Scan scope: always the page's own filters + ordering (shown as text).
        const scopeText = document.createElement("div");
        scopeText.style.cssText = "font-size:11px;opacity:.6;margin-bottom:8px;line-height:1.4;word-break:break-all";
        panel.appendChild(scopeText);

        // Two switches side by side: follow-imported-cards scrolling, and the flip effect.
        const toggleRow = document.createElement("div");
        toggleRow.style.cssText = "display:flex;align-items:center;gap:14px;flex-wrap:wrap;" +
            "font-size:11px;opacity:.8;margin-bottom:8px";

        function mkSwitch(label) {
            const wrap = document.createElement("div");
            wrap.style.cssText = "display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none";
            const track = document.createElement("span");
            track.style.cssText = "position:relative;display:inline-block;width:26px;height:14px;" +
                "border-radius:7px;background:#3a3f48;transition:background .2s;flex:0 0 auto";
            const knob = document.createElement("span");
            knob.style.cssText = "position:absolute;top:2px;left:2px;width:10px;height:10px;" +
                "border-radius:50%;background:#e6e6e6;transition:left .2s";
            track.appendChild(knob);
            const text = document.createElement("span");
            text.textContent = label;
            wrap.appendChild(track);
            wrap.appendChild(text);
            return { wrap: wrap, track: track, knob: knob, text: text };
        }

        const swScroll = mkSwitch(t("swScroll"));
        swScroll.wrap.onclick = function () {
            runtime.autoScroll = !runtime.autoScroll;
            if (!runtime.autoScroll) revealQueue.length = 0;
            render();
        };
        const swFx = mkSwitch(t("swFx"));
        swFx.wrap.onclick = function () { runtime.effects = !runtime.effects; render(); };

        toggleRow.appendChild(swScroll.wrap);
        toggleRow.appendChild(swFx.wrap);
        panel.appendChild(toggleRow);

        const btns = document.createElement("div");
        btns.style.cssText = "display:flex;gap:6px;flex-wrap:wrap";

        function mkBtn(text, bg, onclick) {
            const b = document.createElement("button");
            b.textContent = text;
            Object.assign(b.style, {
                padding: "6px 12px", border: "none", borderRadius: "6px", cursor: "pointer",
                color: "#fff", background: bg, fontSize: "12px", fontWeight: "600"
            });
            b.onclick = onclick;
            return b;
        }

        const btnStart = mkBtn(t("start"), "#45C761", function () { start(); });
        const btnPause = mkBtn(t("pause"), "#ffc107", function () { runtime.paused ? resume() : pause(); });
        const btnImport = mkBtn(t("importBtn", 0), "#0d6efd", function () { importQueue(); });
        btnImport.style.display = "none";
        const btnStop = mkBtn(t("stop"), "#dc3545", function () { stop(); });
        btnStop.style.display = "none";
        const btnClear = mkBtn(t("clear"), "#495057", function () { if (!runtime.running) clearStore(); });
        btnClear.style.color = "#e6e6e6";

        // Quick jump buttons: the Quixel Megascans seller page and the free
        // assets of the Unreal Engine channel. Deliberately coloured apart from
        // the run buttons so they read as navigation, not actions.
        const btnMegascan = mkBtn("", "linear-gradient(135deg,#0e5c57,#0a3d3a)", function () {
            location.href = MEGASCAN_URL;
        });
        btnMegascan.style.display = "inline-flex";
        btnMegascan.style.alignItems = "center";
        btnMegascan.style.gap = "4px";
        btnMegascan.style.padding = "6px 8px";
        btnMegascan.style.fontSize = "11px";
        btnMegascan.title = "Quixel Megascans";
        {
            const icon = document.createElement("img");
            icon.src = QUIXEL_LOGO;
            icon.alt = "Quixel";
            icon.style.cssText = "width:14px;height:14px;display:block";
            btnMegascan.appendChild(icon);
            const label = document.createElement("span");
            label.textContent = "Megascan";
            btnMegascan.appendChild(label);
        }

        const btnFree = mkBtn(t("navFree"), "linear-gradient(135deg,#14396b,#0b2a52)", function () {
            location.href = UE_FREE_URL;
        });
        btnFree.style.padding = "6px 8px";
        btnFree.style.fontSize = "11px";
        btnFree.style.whiteSpace = "nowrap";
        btnFree.title = t("navFreeTip");

        // One single row: run controls first, the two quick jumps right after
        // 清空记录. Everything on this row runs compact so all four fit on one
        // line even with the longer locales.
        btnStart.style.padding = "6px 8px";
        btnClear.style.padding = "6px 8px";
        btnStart.style.fontSize = "11px";
        btnClear.style.fontSize = "11px";
        btns.style.gap = "4px";
        btns.style.flexWrap = "nowrap";
        btns.appendChild(btnStart); btns.appendChild(btnPause);
        btns.appendChild(btnImport); btns.appendChild(btnStop); btns.appendChild(btnClear);
        btns.appendChild(btnMegascan); btns.appendChild(btnFree);
        panel.appendChild(btns);

        // Checkout and "clear cart" share one row: the cart is a server object
        // that has to stay small enough for the site to render, so both ways of
        // dealing with it belong side by side.
        const cartRow = document.createElement("div");
        cartRow.style.cssText = "display:none;gap:6px;margin:4px 0 6px";

        const btnCart = document.createElement("button");
        btnCart.style.cssText = "display:none;flex:1;padding:5px 8px;border-radius:6px;" +
            "border:1px solid #45C761;background:rgba(69,199,97,.14);color:#8ff0a6;cursor:pointer;font-size:12px;" +
            "align-items:center;justify-content:center";
        const cartLabel = document.createElement("span");
        btnCart.appendChild(cartLabel);

        const btnClearCart = document.createElement("button");
        btnClearCart.style.cssText = "display:none;padding:5px 8px;border-radius:6px;" +
            "border:1px solid #8a4b4b;background:rgba(220,53,69,.12);color:#ffb3bb;cursor:pointer;font-size:12px;" +
            "align-items:center;white-space:nowrap";
        const clearCartLabel = document.createElement("span");
        clearCartLabel.textContent = t("btnClearCart");
        btnClearCart.appendChild(clearCartLabel);
        btnClearCart.title = t("clearCartAsk");
        btnClearCart.onclick = function () {
            if (!window.confirm(t("clearCartAsk"))) return;
            postClearCart().then(function (ok) {
                if (!ok) { toast(t("clearCartFailed"), "error", 6000); return; }
                runtime.carted = [];
                runtime.stats.carted = 0;
                store.carted = {};
                saveCartPending();
                render();
                toast(t("clearCartDone"), "success", 4000);
            });
        };
        btnCart.onclick = function () {
            // Open synchronously so the click still counts as a user gesture.
            // The probe is closed again when the cart turns out to be empty;
            // otherwise it navigates to the real cart page.
            const had = (runtime.carted || []).length;
            const probe = window.open("about:blank", "_blank");
            reconcileCart().then(function () {
                render();
                if ((runtime.carted || []).length) {
                    if (probe) probe.location = BASE_HOST + "/cart";
                    else window.open(BASE_HOST + "/cart", "_blank");
                    return;
                }
                if (probe) probe.close();
                if (had) toast(t("cartEmptyNow"), "warning", 5000);
            }).catch(function () {
                if (probe) probe.location = BASE_HOST + "/cart";
            });
        };
        cartRow.appendChild(btnCart);
        cartRow.appendChild(btnClearCart);
        panel.appendChild(cartRow);
        const logLine = document.createElement("div");
        logLine.style.cssText = "margin-top:8px;font-size:11px;opacity:.55;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
        panel.appendChild(logLine);

        // Compact view: the only thing left on screen once the panel is collapsed.
        const mini = document.createElement("div");
        mini.style.cssText = "display:none;font-size:11px;line-height:1.5;color:#9fd8a9;" +
            "white-space:normal;word-break:break-word";
        panel.appendChild(mini);

        toastBox = document.createElement("div");
        Object.assign(toastBox.style, {
            position: "fixed", right: "16px", bottom: "255px", zIndex: "2147483647",
            display: "flex", flexDirection: "column", alignItems: "flex-end", pointerEvents: "none"
        });
        document.body.appendChild(toastBox);

        feedBox = document.createElement("div");
        feedBox.id = "fab-bfg-feed";
        Object.assign(feedBox.style, {
            position: "fixed", right: "16px", bottom: "16px",
            zIndex: "2147483646", display: "flex", flexDirection: "column",
            alignItems: "flex-end", pointerEvents: "none"
        });
        document.body.appendChild(feedBox);

        el = {
            panel: panel, phase: phase, status: status, bar: bar, barLabel: barLabel,
            counters: counters, meta: meta, owner: owner, log: logLine, mini: mini,
            scope: scopeText, scroll: toggleRow, user: user, btnCart: btnCart,
            cartRow: cartRow, cartLabel: cartLabel, btnClearCart: btnClearCart,
            swScroll: swScroll, swFx: swFx,
            btnStart: btnStart, btnPause: btnPause, btnImport: btnImport, btnStop: btnStop
        };
        document.body.appendChild(panel);
        // Two copies of the script can be injected into the same page (the
        // installed userscript plus a manual paste). Both check for the panel
        // before creating one, so they can still race: keep exactly one.
        keepSinglePanel(panel);

        /* ---------------------------------------------------------------- *
         * placement: drag the header to move the panel anywhere, clamped to
         * the viewport, and remembered across reloads
         * ---------------------------------------------------------------- */
        const UI_KEY = "fab_bfg_ui_v1";
        let uiCollapsed = false;
        let uiDock = "right";          // which screen edge the panel is docked to
        let uiAnimTimer = 0;
        // The panel is animated with CSS transitions, so getBoundingClientRect()
        // reports an interpolated position for a few frames. These keep the
        // actual target instead, for docking decisions and for persistence.
        let uiLeft = NaN;
        let uiTop = NaN;

        // Everything but the header and the compact line disappears on collapse.
        // Each entry keeps its own display value: the button rows are flex, and
        // clearing them to "" would silently break their layout on expand.
        const bodyEls = [];
        for (let i = 0; i < panel.children.length; i++) {
            const child = panel.children[i];
            if (child === head || child === mini) continue;
            bodyEls.push({ node: child, display: child.style.display });
        }

        function toLeftTop() {
            const r = panel.getBoundingClientRect();
            uiLeft = Math.round(r.left);
            uiTop = Math.round(r.top);
            panel.style.left = uiLeft + "px";
            panel.style.top = uiTop + "px";
            panel.style.right = "auto";
            panel.style.bottom = "auto";
        }

        function clampPanel() {
            const w = panel.offsetWidth;
            const h = panel.offsetHeight;
            const r = panel.getBoundingClientRect();
            const maxLeft = Math.max(0, window.innerWidth - w);
            const maxTop = Math.max(0, window.innerHeight - h);
            const left = Math.min(Math.max(0, Math.round(isNaN(uiLeft) ? r.left : uiLeft)), maxLeft);
            const top = Math.min(Math.max(0, Math.round(isNaN(uiTop) ? r.top : uiTop)), maxTop);
            uiLeft = left; uiTop = top;
            panel.style.left = left + "px";
            panel.style.top = top + "px";
            panel.style.right = "auto";
            panel.style.bottom = "auto";
        }

        // The stored top is a position, not a promise that the whole panel still
        // fits: a render can make it taller (the cart row appears, a log line
        // wraps, the counters gain a digit), and only the old height was checked.
        // So the edges are re-verified on every size change, and the panel moves
        // only when it would actually hang out of the viewport.
        function keepPanelInView() {
            const w = panel.offsetWidth;
            const h = panel.offsetHeight;
            // A 10px reserve keeps the bottom border and its shadow on screen; it
            // is applied only when the panel would overflow, so a height change
            // never shifts the header unless it genuinely has to.
            const maxLeft = Math.max(0, window.innerWidth - w);
            const maxTop = Math.max(0, window.innerHeight - h - 10);
            const curLeft = panel.style.left ? parseFloat(panel.style.left) : panel.getBoundingClientRect().left;
            const curTop = panel.style.top ? parseFloat(panel.style.top) : panel.getBoundingClientRect().top;
            const left = Math.min(Math.max(0, Math.round(curLeft)), maxLeft);
            const top = Math.min(Math.max(0, Math.round(curTop)), maxTop);
            if (left === uiLeft && top === uiTop) return false;
            uiLeft = left;
            uiTop = top;
            toLeftTop();
            panel.style.left = left + "px";
            panel.style.top = top + "px";
            return true;
        }

        function dockedLeft(width) {
            const margin = 12;
            return uiDock === "right"
                ? Math.max(0, window.innerWidth - width - margin)
                : margin;
        }

        // The caret is kept on the docked edge, so collapsing and expanding never
        // slides it away from the pointer: it sits at the same screen x in both
        // states, which is what makes clicking it twice in a row feel safe.
        function placeCaretForDock(dock) {
            uiDock = dock === "left" ? "left" : "right";
            if (uiDock === "left") {
                if (head.firstElementChild !== btnCollapse) head.insertBefore(btnCollapse, head.firstElementChild);
            } else {
                if (head.lastElementChild !== btnCollapse) head.appendChild(btnCollapse);
            }
        }

        // The caret always faces the nearer screen edge. Judged from the panel's
        // target geometry, never from an animating rectangle, so it also flips
        // live while the panel is being dragged.
        function dockFromPosition() {
            const w = panel.offsetWidth;
            const gapLeft = isNaN(uiLeft) ? panel.getBoundingClientRect().left : uiLeft;
            const gapRight = window.innerWidth - gapLeft - w;
            const want = gapRight <= gapLeft ? "right" : "left";
            if (want !== uiDock) placeCaretForDock(want);
        }

        function saveUi() {
            try {
                localStorage.setItem(UI_KEY, JSON.stringify({
                    left: uiLeft, top: uiTop, collapsed: uiCollapsed, dock: uiDock
                }));
            } catch (e) { /* cosmetic only */ }
        }

        // A ring that flares out of the new outline, so collapse and expand read
        // as one deliberate gesture instead of the panel teleporting.
        function uiHalo() {
            if (typeof document.body.animate !== "function" && !window.requestAnimationFrame) return;
            const r = panel.getBoundingClientRect();
            const halo = document.createElement("div");
            halo.style.cssText = "position:fixed;pointer-events:none;z-index:2147483645;border-radius:12px;" +
                "border:1px solid rgba(69,199,97,.85);transition:opacity .5s ease-out," +
                "transform .5s cubic-bezier(.2,.7,.3,1),box-shadow .5s ease-out";
            halo.style.left = Math.round(r.left) + "px";
            halo.style.top = Math.round(r.top) + "px";
            halo.style.width = Math.round(r.width) + "px";
            halo.style.height = Math.round(r.height) + "px";
            document.body.appendChild(halo);
            requestAnimationFrame(function () {
                halo.style.opacity = "0";
                halo.style.transform = "scale(1.07)";
                halo.style.boxShadow = "0 0 20px 8px rgba(69,199,97,.22)";
            });
            setTimeout(function () {
                if (halo.parentNode) halo.parentNode.removeChild(halo);
            }, 620);
        }

        function applyCollapsed(collapsed, persist, animate) {
            const top0 = panel.style.top ? parseFloat(panel.style.top) : panel.getBoundingClientRect().top;
            uiCollapsed = !!collapsed;

            mini.style.display = uiCollapsed ? "block" : "none";
            for (let i = 0; i < bodyEls.length; i++) {
                bodyEls[i].node.style.display = uiCollapsed ? "none" : bodyEls[i].display;
            }
            panel.style.width = uiCollapsed ? "260px" : "350px";
            head.style.marginBottom = uiCollapsed ? "4px" : "8px";
            // The chip and the phase word would only crowd the compact header.
            user.style.display = uiCollapsed ? "none" : "";
            phase.style.display = uiCollapsed ? "none" : "";
            caret.style.transform = uiCollapsed ? "rotate(180deg)" : "none";
            btnCollapse.title = uiCollapsed ? t("tipExpand") : t("tipCollapse");

            const w = panel.offsetWidth;
            const h1 = panel.offsetHeight;
            dockFromPosition();

            // The panel only moves up when it would actually leave the viewport:
            // a 12px reserve here would nudge the header (and the caret) a few
            // pixels every time the panel changes height.
            const maxTop = Math.max(12, window.innerHeight - h1 - 10);
            const top = Math.round(Math.min(Math.max(12, top0), maxTop));
            const left = Math.round(dockedLeft(w));

            toLeftTop();
            // Placement is set, never transitioned: a stalled animation clock
            // (hidden window, reduced motion) would otherwise leave the panel
            // parked between two positions. The flourish is a glow and a ring
            // instead, which cost nothing if they are dropped.
            uiLeft = left; uiTop = top;
            panel.style.left = left + "px";
            panel.style.top = top + "px";
            panel.style.right = "auto";
            panel.style.bottom = "auto";
            if (animate) {
                panel.style.transition = "box-shadow .3s ease-out";
                panel.style.boxShadow = "0 0 0 1px rgba(69,199,97,.55), 0 10px 30px rgba(69,199,97,.25)";
                uiHalo();
                clearTimeout(uiAnimTimer);
                uiAnimTimer = setTimeout(function () {
                    panel.style.boxShadow = "0 10px 28px rgba(0,0,0,.45)";
                    syncFeedBottom();
                }, 340);
            }
            syncFeedBottom();
            render();
            if (persist) saveUi();
        }

        // The toggle sits inside the drag handle, so the gesture stops there.
        btnCollapse.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
        // Read-only probe for the UI state, so tests can assert on the intent
        // rather than on a rectangle that an animation may still be moving.
        window.__FAB_UI = function () {
            return { collapsed: uiCollapsed, dock: uiDock, left: uiLeft, top: uiTop, width: panel.offsetWidth };
        };

        function toggleCollapsed() { applyCollapsed(!uiCollapsed, true, true); }
        btnCollapse.onclick = function (e) {
            e.stopPropagation();
            toggleCollapsed();
        };
        // Double-clicking the title is handled from the pointer stream further
        // down: the drag handler has to cancel the native default on the header,
        // which also suppresses the compatibility dblclick event, so relying on
        // "dblclick" here would never fire for a real double click.

        let drag = null;
        head.addEventListener("pointerdown", function (e) {
            if (e.button !== undefined && e.button !== 0) return;
            const r = panel.getBoundingClientRect();
            drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY, moved: false };
            // The collapse animation leaves a transition on left/top; dragging
            // has to track the pointer with no easing at all.
            panel.style.transition = "none";
            try { head.setPointerCapture(e.pointerId); } catch (err) { /* older engines */ }
            // No preventDefault here: it would kill the native double-click on
            // the header. Text selection is already off via userSelect.
        });
        head.addEventListener("pointermove", function (e) {
            if (!drag) return;
            if (Math.abs(e.clientX - drag.sx) > 5 || Math.abs(e.clientY - drag.sy) > 5) drag.moved = true;
            const w = panel.offsetWidth;
            const h = panel.offsetHeight;
            const maxLeft = Math.max(0, window.innerWidth - w);
            const maxTop = Math.max(0, window.innerHeight - h);
            const left = Math.min(Math.max(0, e.clientX - drag.dx), maxLeft);
            const top = Math.min(Math.max(0, e.clientY - drag.dy), maxTop);
            uiLeft = Math.round(left); uiTop = Math.round(top);
            panel.style.left = uiLeft + "px";
            panel.style.top = uiTop + "px";
            panel.style.right = "auto";
            panel.style.bottom = "auto";
            dockFromPosition();
            syncFeedBottom();
        });
        // A tap, not a drag, toggles the panel - a double tap anywhere on the
        // header counts, so the title works as a switch without aiming at the
        // 22px caret button.
        let lastTap = null;
        function endDrag(e) {
            if (!drag) return;
            const moved = drag.moved;
            drag = null;
            saveUi();
            syncFeedBottom();
            if (moved || !e || e.type !== "pointerup") { lastTap = null; return; }
            const now = Date.now();
            if (lastTap && now - lastTap.at < 480 && Math.abs(e.clientX - lastTap.x) < 10 && Math.abs(e.clientY - lastTap.y) < 10) {
                lastTap = null;
                toggleCollapsed();
            } else {
                lastTap = { at: now, x: e.clientX, y: e.clientY };
            }
        }
        head.addEventListener("pointerup", endDrag);
        head.addEventListener("pointercancel", endDrag);

        // A shrinking window must never leave the panel half off screen.
        window.addEventListener("resize", function () {
            if (uiCollapsed) {
                const w = panel.offsetWidth;
                uiLeft = Math.round(dockedLeft(w));
                panel.style.left = uiLeft + "px";
                panel.style.right = "auto";
            }
            clampPanel();
            dockFromPosition();
            syncFeedBottom();
        });

        try {
            const savedUi = JSON.parse(localStorage.getItem(UI_KEY) || "null");
            if (savedUi && typeof savedUi.left === "number" && typeof savedUi.top === "number") {
                panel.style.left = savedUi.left + "px";
                panel.style.top = savedUi.top + "px";
                panel.style.right = "auto";
                panel.style.bottom = "auto";
            }
            placeCaretForDock(savedUi && savedUi.dock);
            uiCollapsed = !!(savedUi && savedUi.collapsed);
        } catch (e) { /* first run, keep the defaults */ }
        clampPanel();
        applyCollapsed(uiCollapsed, false, false);

        // Any change in the panel's own box (a new cart row, a longer log line,
        // the account chip landing) re-checks the bottom edge immediately instead
        // of waiting for the next resize or the 900 ms settle.
        if (typeof ResizeObserver === "function") {
            const uiObserver = new ResizeObserver(function () {
                if (keepPanelInView()) {
                    saveUi();
                    syncFeedBottom();
                }
            });
            uiObserver.observe(panel);
        }

        loadStore();
        runtime.carted = loadCartPending().filter(function (u) { return !store.done[u]; });
        // The restored list has to feed the same lookup the importer filters on,
        // otherwise an entry recovered from storage is claimed a second time.
        if (!store.carted) store.carted = {};
        runtime.carted.forEach(function (u) { store.carted[u] = 1; });
        // The stored list may be a leftover from an order that already went
        // through (or a cart cleared by hand). Check it against the real cart
        // once the panel is up, so "checkout (N)" never advertises an empty cart.
        reconcileCart().then(function () { render(); });
        render();
        loadMe();
        syncFeedBottom();
        // The first render fills in the account chip and the counters, which makes
        // the panel taller than the box it was placed in. Re-settle afterwards so
        // the bottom edge never hangs off the viewport.
        setTimeout(function () { clampPanel(); syncFeedBottom(); }, 900);
        window.addEventListener("resize", syncFeedBottom);
        setInterval(paintTick, 700);
        setInterval(autoScrollStep, 450);
        window.addEventListener("scroll", paintTick, { passive: true });
    }

    // Public handles: debugging from the console, and the test harness.
    window.FAB_BFG = {
        config: CONFIG,
        runtime: runtime,
        store: function () { return store; },
        start: start,
        pause: pause,
        resume: resume,
        stop: stop,
        importQueue: importQueue,
        reset: clearStore,
        scope: describeScope,
        // Read-only view of the scan position, used to verify the head re-read
        // and the jump back to the saved cursor.
        info: function () {
            return {
                pages: runtime.pages, cursor: runtime.cursor, headLeft: runtime.headLeft,
                headDone: runtime.headDone, resumeCursor: runtime.resumeCursor,
                endReached: runtime.endReached, dupStreak: runtime.dupStreak
            };
        },
        markSaved: markSavedOnPage,
        doneFx: playDoneFx,
        cartLicense: resolveCartLicense,
        addToCart: addToCart,
        revealInfo: function () {
            return {
                pending: revealQueue.length,
                autoScroll: !!runtime.autoScroll,
                running: !!runtime.running,
                idleFor: Date.now() - lastUserScroll,
                first: revealQueue.slice(0, 3)
            };
        },
        stats: function () {
            return JSON.parse(JSON.stringify({
                phase: runtime.phase, running: runtime.running, paused: runtime.paused,
                concurrency: runtime.concurrency, batchSize: runtime.batchSize,
                queue: runtime.queue.length, pages: runtime.pages,
                hiddenLibrary: runtime.hiddenLibrary, stats: runtime.stats,
                lastError: runtime.lastError,
                doneCount: Object.keys(store.done || {}).length,
                failedCount: Object.keys(store.failed || {}).length
            }));
        }
    };
    window.fabRun = function () { return start(); };

    if (document.readyState === "complete" || document.readyState === "interactive") buildUI();
    else window.addEventListener("DOMContentLoaded", buildUI);
})();
