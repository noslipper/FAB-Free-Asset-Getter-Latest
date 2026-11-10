# FAB免费资产获取器

[English Version](#fab-free-asset-getter)

这是一个Tampermonkey脚本，可以帮助你一键获取FAB商城中的所有免费资产。

## 功能

- 在任意 `fab.com` 页面右下角提供 **「FAB 批量入库」** 面板
- 支持**任何免费资产搜索页**：全站免费（`/search?is_free=1`）、单个发行商（`&sellers=...`）、关键词、分类——页面 URL 上的筛选条件会原样带进接口
- **边扫边入库**：扫一批 → 立刻入库这批 → 再扫下一批，几秒内就能看到进度，不用等到全量扫完
- **气泡瀑布提醒**：每入库一个资产，就在面板正上方弹出一个气泡（标题 + 累计序号），最新的贴着面板、旧的向上瀑布式堆叠，约 6 秒后淡出
- **揭示队列连播**：已入库但还没进入视野的卡片排进队列，页面每 450ms 跳到下一张，落位瞬间补画徽章并播一次扫光，一张接一张连闪。**扫描本身绝不往下滚页**——队列里还没有 DOM 节点的卡片只排队等待，不会为了找卡片把页面拖下去，你随手往下滚，滚到哪张就当场闪哪张
- **14 种语言自动匹配**：面板跟随站点自己的语言设置（先看 `<html lang>`，再看 `EPIC_LOCALE` cookie，最后用浏览器语言），覆盖 FAB 语言菜单里的全部条目——English / 简体中文 / 繁體中文 / 日本語 / 한국어 / Deutsch / Français / Español (ES·LA) / Italiano / Polski / Português (BR) / Русский / Türkçe / العربية（阿拉伯语自动 RTL）。缺失词条回退英文，不会出现空白或键名
- **批量数值可撤销**：滑杆按固定档位走（1 / 10 / 20 / 50 / 100 / 200 / 300 / 500 / 1000 / 2000 / 3000 / 4000 / 5000），数字框可任意输入；后面 `↺` 一点回到默认 100
- **两个开关并排**：左「跟随卡片滚动」、右「入库特效」，均默认开启
- **卡片即时变成「已保存在我的库中」**：刚入库的卡片直接就地改成站点原生样式（同 fabkit 字体、字号与 `edsicon-check-circle-filled` 小对号图标），不用刷新页面；之后滚出来的卡片也会补上
- **按页面自身的筛选与排序扫描**：URL 上的 `q` / `sellers` / `categories` / `tags` / `asset_formats` / `sort_by`，以及路径里的 `channels/<slug>`、`categories/<...>` 全部原样带进接口，面板上会写明本次实际使用的条件
- **两个快捷跳转**（与「开始入库」「清空记录」同一行、配色区分）：带 Quixel 图标的 **Megascan** 直达 Quixel Megascans 在虚幻引擎频道的资产页；**免费资产** 直达虚幻引擎频道的免费资产页
- 批量大小可调：滑杆 1~5000（默认 100），右侧数字框可手输任意值，**不受滑杆范围限制**
- `暂停` 后面板会出现 **「入库(n)」** 按钮，把已经扫出来、还没入库的资产手动入库
- 不走页面滚动，直接调 FAB 接口：游标翻页 + 24 条一批查归属 + 并发 `add-to-library`
- **索引匿名读取公开清单**：登录态索引约 2000 条即截断（触发限速还会返回空结果），公开索引才是完整的
- **自动判断是否需要查归属**：当站点设置了「不显示库内资产」时，搜索结果本身就只有未入库的，脚本会自动跳过归属检查（行为检测，不是写死开关）；可用 `CONFIG.ownedCheck = "on" / "off"` 强制
- 自动跳过库中已有的资产、之前几轮已领取的资产，以及接口拒绝直接领取的 bundle（捆绑包）
- 进度写入 `localStorage`（游标 + 已处理 id，按搜索范围区分），刷新页面后可续跑
- 自适应并发：遇到 FAB 限速（返回 HTML 风控页 / 429）自动降并发并退避
- 实时面板：已扫描 / 队列 / 新增 / 跳过 / 失败、每秒条数、当前游标页
- 同一商品同时有个人版与专业版时，默认直接用搜索里带的 offer id 领取；只有领取失败才回退去查详情挑授权（`CONFIG.preferProfessional` 打开则始终先查详情）

## 安装方法

1. 首先安装Tampermonkey浏览器扩展：
   - Chrome: [Tampermonkey](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
   - Firefox: [Tampermonkey](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/)
   - Edge: [Tampermonkey](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd)

2. 安装脚本：
   - 方法1：在 [Greasy Fork](https://greasyfork.org/zh-CN/scripts/534044-fab-free-asset-getter) 页面点击「安装此脚本」
   - 方法2：点击[这里](chrome-extension://dhdgffkkebhmkfjojejmpbldmpobfkfo/options.html#nav=utils-tab)打开Tampermonkey的实用工具标签，然后从URL安装：
     ```
     https://raw.githubusercontent.com/noslipper/FAB-Free-Asset-Getter-Latest/refs/heads/main/fab.js
     ```
   - 方法3：打开Tampermonkey Dashboard -> 添加新脚本，然后复制粘贴`fab.js`中的内容

## 使用方法

1. 登录 FAB 账号，打开要清空的搜索页：
   - 全站免费资产：`https://www.fab.com/search?is_free=1`
   - 单个发行商（如 Quixel Megascans）：`https://www.fab.com/search?is_free=1&sellers=o-cbf5bbfdb340d6a839b5520cb31328`
   - 关键词 / 分类等筛选条件直接沿用页面 URL
2. 设置 **「批量」** 值：滑杆 1~5000，或直接在数字框里输入（想超过 5000 也能输）
3. 点击 **「开始入库」**：扫一批 → 入库这一批 → 继续扫下一批，不需要滚动页面，也不需要反复刷新
4. `暂停` 会停止扫描与入库，已扫描的资产留在队列里，面板出现 **「入库(n)」** 按钮可手动入库这些资产；`继续` 恢复运行，`停止` 中止，`清空记录` 清掉游标缓存
5. 支持断点续跑：游标与已处理 id 按搜索范围缓存，刷新后再次运行会从断点继续

## 注意事项

- 使用脚本前请确保已登录FAB账号
- 脚本会跳过已经在你库中的资产
- 如果遇到问题，可以尝试刷新页面后再使用
- 脚本适用于所有FAB商城页面，包括搜索结果
- 需要在浏览器的扩展程序页面开启开发者模式
- **<span style="color:#e53935;font-weight:bold">Edge浏览器：必须开启Tampermonkey的「允许用户脚本」开关</span>**（edge://extensions -> Tampermonkey -> 详细信息 -> 允许用户脚本）。未开启时脚本虽然显示已安装、已启用，但不会在任何页面上运行。
- 运行期间请让标签页保持在前台：后台标签的定时器会被浏览器节流，速率会明显下降
- 参数在 `fab.js` 顶部的 `CONFIG` 里：`batchSize`（默认 100，也可在面板上调）、`concurrency`（默认 12）、`maxConcurrency`（16）、`minConcurrency`（4）、`indexConcurrency`（8）、`waveDelay` / `waveJitter`（同一工作线程两条之间休息 30ms + 随机 90ms）、`cooldownEvery` / `cooldownMs`（每入库 1000 条冷却 2.5 秒）、`maxPages`（默认 420，把单次扫描收住）、`ownedCheck`（`"auto"` / `"on"` / `"off"`）、`preferProfessional`（默认 `false`：直接用搜索里带的 offer id，只有领取失败才回退查详情）
- 如果 FAB 开始软风控，扫描阶段会自动暂停重试（面板显示「疑似风控」），此时把 `concurrency` 调小并等待几分钟即可

## 版本历史

- **v3.7.1** — 主要变化：
  - **入库速度**：不再一条条点页面上的按钮，改成成批把资产存进库里，速度从每秒 1 条左右提到每秒 12 条左右；中途停下可以接着上一次继续，网站限速时会自动放慢等待。
  - **边扫边存**：读到一批就开始存，不用等全部扫完；一次存多少可以自己调；暂停后点「入库(n)」能把已经扫描的一次存完。
  - **跟着页面走**：搜索词、发行商、分类、排序都沿用页面当前的条件，从频道页进来也一样；账号里已经设了「不显示库内资产」时，脚本不再重复核对。
  - **看得见的进度**：每存好一条，面板上方弹一条气泡；对应卡片当场变成「已保存在我的库中」并扫一道光；这一屏看不到的卡片会排队，滚到哪儿就依次亮到哪儿。
  - **操作细节**：批量滑杆停在 1 / 10 / 20 / 50 / 100 … 5000 共 13 个整数档，`↺` 回到默认的 100；扫描时页面不会自己乱滚；界面语言跟着站点自动切换，覆盖 14 种语言。
  - **快捷入口**：新增带 Quixel 图标的 **Megascan** 与 **免费资产** 两个跳转按钮，分别直达 Quixel Megascans 在虚幻引擎频道的资产页、以及该频道的免费页面；按钮颜色与运行按钮区分，文字随界面语言变化。
- v2.4.2：更新以匹配最新版FAB网站
- v2.0：完全重写以匹配新版FAB网站
- v1.0：初始版本

## 许可

AGPL-3.0-or-later

---

# FAB Free Asset Getter

[中文版本](#fab免费资产获取器)

A Tampermonkey script that helps you automatically collect all free assets from the FAB marketplace with one click.

## Features

- Adds a **"FAB 批量入库 / Bulk Import"** panel to any `fab.com` page (bottom-right)
- Works on **any free-asset search**: the whole free catalogue (`/search?is_free=1`), one seller (`&sellers=...`), a keyword, a category — whatever filters the page has are carried into the API scan
- **Streaming pipeline**: scans a batch, imports that batch, scans the next one — progress is visible from the first seconds instead of after a full scan
- **Bubble feed**: every asset that lands in the library pops up as a bubble right above the panel, newest nearest the panel and older ones cascading upward
- **Reveal queue**: cards imported but still out of view line up; the page jumps to them (every 450 ms) and each one flips with its sweep the moment it lands, so the flips cascade instead of playing off screen. Scanning itself never scrolls the page — a queued card with no DOM node just waits for you to scroll there
- **14 languages, picked automatically**: the panel follows the site's own language setting (`<html lang>`, then the `EPIC_LOCALE` cookie, then the browser language) across every locale in Fab's language menu (English, 简中, 繁中, 日本語, 한국어, Deutsch, Français, Español (ES/LA), Italiano, Polski, Português (BR), Русский, Türkçe, العربية — RTL for Arabic)
- **Cards flip to "已保存在我的库中" instantly**: the card you just imported is repainted with Fab's own success label (same fabkit typography, size and check-circle icon), no page reload needed; cards that scroll into view later get repainted too
- **Scans with the page's own filters and ordering**, carried straight from the URL (`q`, `sellers`, `categories`, `tags`, `asset_formats`, `sort_by`) plus the path segment (`channels/<slug>`, `categories/<...>`); the panel shows exactly what will be sent
- **Two quick jumps** (on the same row as 开始入库 and 清空记录, coloured apart from the run buttons): **Megascan** with the Quixel mark opens Quixel Megascans inside the Unreal Engine channel; **Free assets** opens the free listings of that channel
- Adjustable batch size: slider 1–5000 (default 100) plus a free-form number box that is **not** limited to the slider range
- After `暂停` a **入库(n)** button appears and imports everything already scanned
- Talks to the FAB API instead of scrolling the page: cursor-paginated listing index, 24-id batched ownership checks, parallel `add-to-library` calls
- Reads the catalogue **anonymously**: FAB's logged-in search index silently truncates around 2 000 hits (and returns empty pages once it starts throttling), while the public index is complete
- **Ownership check is skipped automatically** when the account hides assets already in the library (Fab's "hide library items" preference): in that case search only returns unowned listings. Detection is behavioural (it is not a hard-coded flag); `CONFIG.ownedCheck = "on" | "off"` overrides it
- Skips assets already in your library (and everything claimed in earlier runs), and silently skips bundle listings, which the API refuses to add
- Resumes after a page reload: cursor + handled ids are cached per search scope
- Adaptive concurrency with automatic back-off when FAB starts rate limiting
- Live panel: scanned / queue / added / skipped / failed, items-per-second, page cursor
- One request per asset by default: the offer id comes straight from the search payload, and the per-item detail lookup is only a fallback when a claim fails (`CONFIG.preferProfessional` forces the detail-first path)

## Installation

1. First, install the Tampermonkey browser extension:
   - Chrome: [Tampermonkey](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
   - Firefox: [Tampermonkey](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/)
   - Edge: [Tampermonkey](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd)

2. Install the script:
   - Method 1: click "Install this script" on [Greasy Fork](https://greasyfork.org/zh-CN/scripts/534044-fab-free-asset-getter)
   - Method 2: Click [here](chrome-extension://dhdgffkkebhmkfjojejmpbldmpobfkfo/options.html#nav=utils-tab) to open Tampermonkey's utility tab, then install from URL using:
     ```
     https://raw.githubusercontent.com/noslipper/FAB-Free-Asset-Getter-Latest/refs/heads/main/fab.js
     ```
   - Method 3: Open Tampermonkey Dashboard -> Add New Script, then copy and paste the content of `fab.js`

## Usage

1. Log into FAB and open the search page you want to drain:
   - whole free catalogue: `https://www.fab.com/search?is_free=1`
   - one seller (e.g. Quixel Megascans): `https://www.fab.com/search?is_free=1&sellers=o-cbf5bbfdb340d6a839b5520cb31328`
   - any keyword / category filter you see in the URL is reused as-is
2. Set the **批量** value (slider 1–5000, or type any number in the box).
3. Click **"开始入库"**. The panel scans a batch, imports it, then scans the next batch.
4. `暂停` stops scanning/importing; the assets already scanned stay in the queue and a **入库(n)** button appears to import them manually. `继续` resumes, `停止` aborts, `清空记录` clears the cached cursor.
5. Refresh-safe: the cursor and the handled ids are cached per search scope, so a re-run continues where it stopped.

## Notes

- Make sure you are logged into your FAB account before using the script
- The script will skip assets that are already in your library
- If you encounter any issues, try refreshing the page and trying again
- The script works on all FAB marketplace pages, including search results
- You need to enable Developer Mode in your browser's extensions page
- **<span style="color:#e53935;font-weight:bold">Edge only: you must enable the "Allow user scripts" switch for Tampermonkey</span>** (edge://extensions -> Tampermonkey -> Details -> Allow user scripts). Without it, the script will not run on any page even though it appears to be installed and enabled.
- Keep the tab in the foreground while it runs: background tabs get their timers throttled and the throughput drops
- Tuning knobs live in the `CONFIG` object at the top of `fab.js`: `batchSize` (default 100), `concurrency` (default 12), `maxConcurrency` (16), `minConcurrency` (4), `indexConcurrency` (8), `waveDelay` / `waveJitter` (30 / 90 ms spread between two assets on a worker), `cooldownEvery` / `cooldownMs` (a 2.5 s break every 1000 imports), `maxPages` (default 420 — bounds one run), `ownedCheck` (`"auto"` / `"on"` / `"off"`), `preferProfessional` (default `false`: use the offer id straight from the search payload and only fall back to the detail lookup when a claim fails)
- If FAB starts soft-blocking, the scan pauses and reports "疑似风控" — lower `concurrency` and wait a few minutes

## Version History

- **v3.7.1** — what changed:
  - **Import speed**: instead of clicking through the page one item at a time, assets are saved in batches, lifting the rate from about 1 per second to about 12 per second; a stopped run picks up where it left off, and the script slows down and waits by itself when the site starts throttling.
  - **Scan and save at once**: saving starts as soon as a batch is read, no need to finish scanning first; the batch size is yours to set; after a pause, "入库(n)" saves everything already scanned in one go.
  - **Follows the page**: search term, seller, category and sorting all match what the page is showing, including when you come in from a channel page; if your account already hides library items, the duplicate check is skipped.
  - **Visible progress**: a bubble pops up above the panel for each saved asset; the matching card turns into "已保存在我的库中" on the spot with a light sweep; cards outside the viewport queue up and light up one by one as you scroll to them.
  - **Small details**: the batch slider stops at 13 whole steps (1 / 10 / 20 / 50 / 100 … 5000) and `↺` puts it back to 100; scanning never scrolls the page by itself; the interface language follows the site and covers 14 languages.
  - **Shortcuts**: two new jump buttons, **Megascan** with the Quixel mark and **Free assets**, open Quixel Megascans inside the Unreal Engine channel and that channel's free listings; their colours differ from the run buttons and the labels follow the interface language.
- v2.4.2: Updated to match the latest FAB website
- v2.0: Rewritten to match the new FAB website
- v1.0: Initial version

## License

AGPL-3.0-or-later
