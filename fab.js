// ==UserScript==
// @name        FAB Free Asset Getter
// @namespace   https://greasyfork.org/en/users/313682-没拖鞋
// @version     2.4.2
// @description A script to get all free assets from the FAB marketplace. Fork of the original by subtixx.
// @author      noslipper
// @homepageURL https://github.com/noslipper/FAB-Free-Asset-Getter-Latest
// @supportURL  https://github.com/noslipper/FAB-Free-Asset-Getter-Latest/issues
// @match       https://www.fab.com/*
// @grant       none
// @license     AGPL-3.0-or-later
// @icon        https://www.google.com/s2/favicons?sz=64&domain=fab.com
// ==/UserScript==

(function () {
    "use strict";
    var notificationQueueContainer = null;
    var scriptIsRunning = false;
    var mainBtn = null;
    var processedIds = new Set();   // items already handled (success / not-free / owned) this session
    var rateLimited = false;        // adaptive slowdown when the site returns HTML (bot-check) responses

    // --- UTILS ---
    function showToast(message, type, duration) {
        type = type || "success";
        duration = duration || 3000;
        const toast = document.createElement("div");
        toast.textContent = message;
        toast.style.margin = "5px 0";
        toast.style.padding = "12px 16px";
        toast.style.backgroundColor = type === "success" ? "#28a745" : (type === "warning" ? "#ffc107" : "#dc3545");
        toast.style.color = type === "warning" ? "black" : "white";
        toast.style.borderRadius = "6px";
        toast.style.zIndex = "10000";
        toast.style.fontFamily = "Segoe UI, Roboto, Arial, sans-serif";
        toast.style.fontSize = "14px";
        toast.style.boxShadow = "0 4px 12px rgba(0, 0, 0, 0.15)";
        toast.style.opacity = "0";
        toast.style.transition = "opacity 0.3s ease";
        toast.style.maxWidth = "300px";
        toast.style.whiteSpace = "nowrap";
        toast.style.overflow = "hidden";
        toast.style.textOverflow = "ellipsis";

        if (notificationQueueContainer) notificationQueueContainer.appendChild(toast);

        requestAnimationFrame(() => { toast.style.opacity = "1"; });

        setTimeout(() => {
            toast.style.opacity = "0";
            setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 300);
        }, duration);
    }

    function getCSRFToken() {
        let cookies = document.cookie.split(";");
        for (let i = 0; i < cookies.length; i++) {
            let cookie = cookies[i].trim();
            if (cookie.startsWith("fab_csrftoken=")) {
                const v = cookie.split("=").slice(1).join("=");
                if (v) {
                    try { return decodeURIComponent(v); } catch (e) { return v; }
                }
            }
        }
        let metaToken = document.querySelector('meta[name="csrf-token"], meta[name="xsrf-token"]');
        if (metaToken) return metaToken.getAttribute("content");
        return "";
    }

    // Interruptible delay so the user can cancel during long waits
    async function cancellableDelay(ms) {
        let elapsed = 0;
        while (elapsed < ms && scriptIsRunning) {
            await new Promise(r => setTimeout(r, 100));
            elapsed += 100;
        }
    }

    // Fetch with retry + backoff. The FAB API occasionally answers a plain HTML
    // page (bot check / rate limit) instead of JSON; we detect that and retry.
    async function apiFetch(url, options, retries) {
        retries = retries || 2;
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const r = await fetch(url, options);
                const ct = r.headers.get("content-type") || "";
                if (r.status === 401) return { ok: false, status: 401 };
                if (!r.ok) {
                    if (attempt < retries) await cancellableDelay(1500 * (attempt + 1));
                    continue;
                }
                if (ct.indexOf("application/json") >= 0) {
                    const data = await r.json();
                    rateLimited = false;
                    return { ok: true, data: data };
                }
                // HTML response => treat as transient bot-check / rate-limit
                rateLimited = true;
            } catch (e) {
                // network error; keep retrying
            }
            await cancellableDelay(1500 * (attempt + 1));
        }
        return { ok: false, status: -1 };
    }

    // --- FREE-OFFER DETECTION ---
    // The current FAB details API exposes licenses with a priceTier that has
    // `price` (base price) and `discountedPrice` (current price when on sale).
    // An offer is free when either is 0. License type is detected via the
    // stable `slug` field (professional / personal / uefn-reference-only),
    // because `name` is localized ("专业" instead of "Professional").
    const LICENSE_PRIORITY = { professional: 0, personal: 1, "uefn-reference-only": 2 };

    function findFreeOffer(licenses) {
        if (!Array.isArray(licenses) || licenses.length === 0) return null;
        let best = null;
        let bestPriority = Infinity;

        for (const lic of licenses) {
            const pt = lic && lic.priceTier;
            if (!pt) continue;
            const price = pt.price;
            const discounted = pt.discountedPrice;
            const isFree = (price === 0 || price === "0") || (discounted === 0 || discounted === "0");
            if (!isFree) continue;

            const slug = (lic.slug || "").toLowerCase();
            const name = (lic.name || "").toLowerCase();
            let priority;
            if (Object.prototype.hasOwnProperty.call(LICENSE_PRIORITY, slug)) {
                priority = LICENSE_PRIORITY[slug];
            } else if (name.indexOf("professional") >= 0 || name.indexOf("专业") >= 0) {
                priority = 0;
            } else if (name.indexOf("personal") >= 0 || name.indexOf("个人") >= 0) {
                priority = 1;
            } else {
                priority = 2;
            }

            if (priority < bestPriority) {
                bestPriority = priority;
                best = lic;
            }
        }
        if (!best) return null;
        return best.offerId || best.uid || best.listingLicenseId || null;
    }

    // --- OWNED CHECK ---
    // 1) API: the same batch endpoint the FAB page itself uses for ownership.
    // 2) DOM: text hints on the card.
    const OWNED_TEXTS = [
        "Saved in My Library", "In Library", "My Library", "Added to Library",
        "已保存", "已添加", "在库中", "已拥有", "已领取", "已添加到库"
    ];

    function isOwnedNode(node) {
        if (!node) return false;
        const text = node.innerText || node.textContent || "";
        const parentText = node.parentElement ? node.parentElement.innerText : "";
        return OWNED_TEXTS.some(t => text.indexOf(t) >= 0 || parentText.indexOf(t) >= 0);
    }

    async function fetchOwnedMap(ids) {
        if (!ids.length) return new Map();
        try {
            const token = getCSRFToken();
            if (!token) return new Map();
            // The API expects listingIds as REPEATED query params (listingIds=a&listingIds=b),
            // and returns [{uid, acquired, entitlementId, wishlisted}, ...].
            const q = new URLSearchParams();
            ids.slice(0, 200).forEach(id => q.append("listingIds", id));
            const r = await apiFetch("/i/users/me/listings-states?" + q.toString(), {
                headers: { "X-CsrfToken": token, "X-Requested-With": "XMLHttpRequest", "Accept": "application/json" }
            }, 1);
            if (!r.ok || !r.data) return new Map();
            const list = Array.isArray(r.data) ? r.data : (r.data.results || r.data.data || []);
            const owned = new Map();
            for (const item of list) {
                if (item && item.acquired === true && item.uid) {
                    owned.set(item.uid, true);
                }
            }
            return owned;
        } catch (e) {
            return new Map();
        }
    }

    // --- SCAN VISIBLE ITEMS ---
    // Title parsing strategies for the current card layout:
    // 1. Typography text inside the listing link (e.g. .fabkit-Typography-ellipsisWrapper)
    // 2. aria-label (e.g. "Quixel Megascans创作的Forest Terrain")
    // 3. Raw link innerText
    function getTitle(link) {
        const textNode = link.querySelector(".fabkit-Typography-ellipsisWrapper, [class*='Typography'], h3, h2, span.text");
        if (textNode && textNode.innerText && textNode.innerText.trim()) {
            return textNode.innerText.trim();
        }
        const aria = link.getAttribute("aria-label");
        if (aria && aria.trim()) return aria.trim();
        if (link.innerText && link.innerText.trim()) return link.innerText.trim();
        return "";
    }

    function scanVisibleItems() {
        const allLinks = document.querySelectorAll("a[href*='/listings/']");
        const items = [];
        const seen = new Set();
        allLinks.forEach(link => {
            if (link.closest("footer")) return;

            const url = link.href;
            const m = url.match(/\/([^/?#]+)\/?$/);
            const id = m ? m[1] : null;
            if (!id || seen.has(id)) return;
            seen.add(id);

            let title = getTitle(link);
            if (!title) title = "Asset #" + id;
            title = title.replace(/[\n\r]+/g, " ").trim();

            const card = link.closest("div[class*='Card'], div[class*='Stack'], div[class*='Surface']") || link.parentElement;
            const owned = isOwnedNode(card || link);

            items.push({ id: id, name: title, url: url, isOwned: owned, element: link });
        });
        return items;
    }

    // --- PROCESS ITEMS ---
    async function processItems(items, ownedMap) {
        let processedCount = 0;
        let fatal = null;
        const token = getCSRFToken();
        if (!token) {
            showToast("Error: Security token missing. Please log in or refresh.", "error", 5000);
            return { added: 0, fatal: "no-token" };
        }

        for (const item of items) {
            if (!scriptIsRunning) break;
            if (item.isOwned || ownedMap.get(item.id)) {
                processedIds.add(item.id);
                continue;
            }
            if (processedIds.has(item.id)) continue;

            // A. Fetch details and locate the free offer
            let freeOfferId = null;
            try {
                const detailsReq = await apiFetch("https://www.fab.com/i/listings/" + item.id, {
                    headers: { "X-CsrfToken": token, "X-Requested-With": "XMLHttpRequest", "Accept": "application/json" }
                });
                if (detailsReq.status === 401) {
                    fatal = "auth";
                    break;
                }
                if (!detailsReq.ok || !detailsReq.data) {
                    // transient failure: leave item unmarked so it retries next round
                    console.warn("[FAB] details fetch failed, will retry later:", item.name);
                    continue;
                }
                freeOfferId = findFreeOffer(detailsReq.data.licenses);
            } catch (e) {
                console.error("[FAB] details error:", item.name, e);
                continue;
            }

            if (!freeOfferId) {
                processedIds.add(item.id);
                console.log("[FAB] skipped (no free tier):", item.name);
                continue;
            }

            // B. Add to library
            showToast("Adding: " + item.name + "...", "info", 1500);
            try {
                const formData = new FormData();
                formData.append("offer_id", freeOfferId);
                const addReq = await fetch("https://www.fab.com/i/listings/" + item.id + "/add-to-library", {
                    method: "POST",
                    headers: { "X-CsrfToken": token, "X-Requested-With": "XMLHttpRequest" },
                    body: formData
                });

                if (addReq.ok) {
                    processedIds.add(item.id);
                    processedCount++;
                    markAdded(item);
                    showToast("Success: " + item.name, "success");
                } else if (addReq.status === 401) {
                    fatal = "auth";
                    showToast("Error 401: Session expired. Please refresh the page.", "error", 5000);
                    break;
                } else {
                    const body = await addReq.text().catch(() => "");
                    if (/already|exists|已在|已保存|已添加|已拥有/i.test(body)) {
                        processedIds.add(item.id);
                        console.log("[FAB] already owned:", item.name);
                    } else {
                        // transient error: retry on the next round
                        console.error("[FAB] add failed (will retry):", item.name, "status=" + addReq.status, body.slice(0, 200));
                    }
                }
            } catch (e) {
                console.error("[FAB] add error:", item.name, e);
            }

            await cancellableDelay(rateLimited ? 2000 : 600);
        }
        return { added: processedCount, fatal: fatal };
    }

    function markAdded(item) {
        if (item.element && item.element.isConnected) {
            const href = item.element.getAttribute("href") || "";
            if (href.indexOf(item.id) >= 0) {
                item.element.style.border = "3px solid #45C761";
                item.element.style.boxSizing = "border-box";
            }
        }
    }

    // --- MAIN LOOP ---
    async function startLoop() {
        scriptIsRunning = true;
        mainBtn.textContent = "Cancel Script";
        mainBtn.style.backgroundColor = "#dc3545";
        showToast("Starting Auto-Scroll & Claim...", "success");

        let previousHeight = 0;
        let noChangeCount = 0;
        let totalAdded = 0;

        while (scriptIsRunning) {
            const currentItems = scanVisibleItems();
            console.log("[FAB] scanned", currentItems.length, "items in current view");

            // Batch ownership check via the official API (best-effort)
            const toCheck = currentItems.filter(i => !processedIds.has(i.id)).map(i => i.id).slice(0, 200);
            const ownedMap = await fetchOwnedMap(toCheck);

            const result = await processItems(currentItems, ownedMap);
            if (result.fatal) {
                scriptIsRunning = false;
                mainBtn.textContent = "Failed. Refresh Page.";
                mainBtn.style.backgroundColor = "#dc3545";
                break;
            }
            if (!scriptIsRunning) break;
            totalAdded += result.added;

            previousHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
            window.scrollTo({ left: 0, top: document.body.scrollHeight, behavior: "smooth" });

            showToast("Scrolling... (Session Total: " + totalAdded + ")", "warning", 2000);
            await cancellableDelay(3000);
            if (!scriptIsRunning) break;

            const newHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
            if (newHeight <= previousHeight) {
                noChangeCount++;
                console.log("[FAB] page height unchanged, attempt", noChangeCount, "/4");

                // Jiggle scroll to trigger lazy-load observers
                window.scrollBy(0, -300);
                await cancellableDelay(500);
                window.scrollTo(0, document.body.scrollHeight);
                await cancellableDelay(2000);

                if (noChangeCount >= 4) {
                    showToast("Finished! No new items loading.", "success", 5000);
                    scriptIsRunning = false;
                    mainBtn.textContent = "Done!";
                    mainBtn.style.backgroundColor = "#45C761";
                    break;
                }
            } else {
                noChangeCount = 0;
            }
        }

        // Reset UI after a manual cancel
        if (mainBtn && mainBtn.textContent === "Stopping...") {
            showToast("Script Cancelled.", "warning");
            mainBtn.textContent = "Get Free Assets";
            mainBtn.style.backgroundColor = "#45C761";
        }
    }

    // --- UI & INIT ---
    function addControls() {
        if (document.getElementById("fab-auto-btn")) return;

        notificationQueueContainer = document.createElement("div");
        Object.assign(notificationQueueContainer.style, {
            position: "fixed", bottom: "20px", right: "20px", zIndex: "10000",
            display: "flex", flexDirection: "column", alignItems: "flex-end", pointerEvents: "none"
        });
        document.body.appendChild(notificationQueueContainer);

        mainBtn = document.createElement("button");
        mainBtn.id = "fab-auto-btn";

        // STRICT CHECK: only run the scraper on the search page
        const isSearchPage = window.location.pathname.startsWith("/search");

        if (!isSearchPage) {
            mainBtn.textContent = "Go to Free Search";
            mainBtn.style.backgroundColor = "#007bff";
        } else {
            mainBtn.textContent = "Get Free Assets";
            mainBtn.style.backgroundColor = "#45C761";
        }

        Object.assign(mainBtn.style, {
            position: "fixed", bottom: "80px", right: "20px", zIndex: "2147483647",
            padding: "12px 24px", color: "white",
            border: "2px solid white", borderRadius: "8px", fontWeight: "bold",
            cursor: "pointer", boxShadow: "0 4px 12px rgba(0,0,0,0.3)", fontSize: "14px",
            fontFamily: "sans-serif"
        });

        mainBtn.onclick = () => {
            if (!isSearchPage) {
                // Redirect to the free-asset search page
                window.location.href = "https://www.fab.com/search?&is_free=1";
            } else {
                if (!scriptIsRunning) {
                    startLoop();
                } else {
                    // Cancel sequence
                    scriptIsRunning = false;
                    mainBtn.textContent = "Stopping...";
                    mainBtn.style.backgroundColor = "#ffc107";
                }
            }
        };

        document.body.appendChild(mainBtn);
        window.fabRun = startLoop;
    }

    if (document.readyState === "complete" || document.readyState === "interactive") {
        addControls();
    } else {
        window.addEventListener("DOMContentLoaded", addControls);
    }
})();
