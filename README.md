**中文** · [English](#fab-free-asset-getter)

# FAB免费资产获取器

这是一个 Tampermonkey 脚本，在 fab.com 上把免费资产批量收进你的 FAB 库。

## 功能

- 任意 `fab.com` 页面右下角出现「FAB 批量入库」面板，点一下就开始扫描并领取
- 扫描范围跟着页面走：全站免费、某个发行商、关键词、左侧类别、频道页，页面上的筛选（含多选）与排序都算数
- 免费资产同时有个人许可和专业许可时，优先领取专业许可；只有个人许可的照常领取个人许可
- 边扫边存，速度约每秒 12 条；中途停下可以接着上次继续
- 入库后卡片当场变成「已保存在我的库中」并扫一道光，面板上方同时弹出气泡提示
- 一次存多少可调：滑杆 13 个档位（1 ~ 5000），也可直接手输，`↺` 回到默认 100
- 两个开关：跟随卡片滚动、入库特效，默认开启
- 面板状态里显示当前登录的账号，一眼就能确认这次入库用的是你的账号
- 界面支持 14 种语言，自动跟随站点语言
- 扫到末尾、队列清空后，全屏播放一段完成特效
- 合集等无法直接入库的免费资产改为自动加入购物车，扫完后一次性结账；结账完成才播放完成特效
- 两个快捷入口：**Megascan** 带 Quixel 图标，直达 Quixel Megascans 的免费资产（最新发布排序）；**免费资产** 直达全站免费资产（最新发布排序）

## 安装方法

1. 先装 Tampermonkey 扩展：
   - Chrome: [Tampermonkey](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
   - Firefox: [Tampermonkey](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/)
   - Edge: [Tampermonkey](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd)

2. 安装脚本：
   - 方法1：在 [Greasy Fork](https://greasyfork.org/zh-CN/scripts/534044-fab-free-asset-getter) 页面点击「安装此脚本」
   - 方法2：点击[这里](chrome-extension://dhdgffkkebhmkfjojejmpbldmpobfkfo/options.html#nav=utils-tab)打开 Tampermonkey 的实用工具标签，然后从 URL 安装：
     ```
     https://raw.githubusercontent.com/noslipper/FAB-Free-Asset-Getter-Latest/refs/heads/main/fab.js
     ```
   - 方法3：打开 Tampermonkey Dashboard -> 添加新脚本，复制粘贴 `fab.js` 的内容

## 使用方法

1. 登录 FAB，打开要处理的页面，例如全站免费 `https://www.fab.com/search?is_free=1`
2. 按需设置「批量」，点「开始入库」
3. 要停就点「暂停」，已扫到的点「入库(n)」补领；「清空记录」清掉断点

## 注意事项

- 使用前请先登录 FAB 账号
- 已在库中的资产会自动跳过
- Edge 需在扩展页开启 Tampermonkey 的「允许用户脚本」开关（edge://extensions -> Tampermonkey -> 详细信息 -> 允许用户脚本），否则脚本不会运行
- 运行时让标签页保持在前台，后台标签会被浏览器降速
- 遇到 FAB 限速脚本会自动放慢并等待，稍等片刻即可

## 版本历史

- **v3.7.8** — 主要变化：
  - **只加免费档**：同一资产的专业版可能单独收费（个人版免费、专业版标价 333 之类），加购改为只在免费档里挑，优先专业版、没有才用个人版，购物车里不会再出现待付款条目。
- **v3.7.7** — 主要变化：
  - **合集不再被误判为已拥有**：账号只要拥有合集里的任意一条子资产，状态接口就返回「已拥有」，整包因此被跳过。合集现在不参与这项判断，一律走购物车。
  - **合集直通购物车**：合集不再先发一次注定返回 400 的领取请求，直接取许可加购，单条少一趟往返。
  - **请求超时**：单个请求 20 秒兜底，避免某条连接卡住让整轮停在原地。
- **v3.7.6** — 主要变化：
  - **合集走购物车**：合集（bundle）和同样无法通过领取接口入库的免费资产，脚本自动取用对应许可并加入购物车，扫完后在面板上给出「结账（n）」入口，一次性结账即可把它们收进库。
  - **结账后收尾**：结账页的人机验证需要本人完成，脚本会一直盯着购物车，等订单落地后核对库里是否真的到手，再计入新增并播放完成特效；购物车空了但库里没东西时不会报成功。
  - **加购补漏**：加购结束后回头核对购物车，漏掉的条目再补一次，避免出现「显示 12 条、车里只有 10 条」。
- **v3.7.5** — 主要变化：
  - **登录指示**：面板状态里显示当前登录的账号，未登录时直接标红提示，避免看着扫描有结果却一条都没进自己的库。
  - **完成特效**：扫到末尾、队列清空后播放一段全屏完成提示，汇总本次入库数量；关掉「入库特效」开关即可静默完成。
  - **合集如实报告**：合集类资产（bundle）无法通过领取接口入库，FAB 只提供购物车方式，脚本不再把它算作普通跳过，完成后单独说明这批合集的数量。
  - **收尾更准**：扫描结束前把队列里剩下的资产领完再判定完成，不会再出现「已完成」却还有几条没领的情况。
- **v3.7.4** — 主要变化：
  - **专业许可优先**：免费资产同时提供个人许可和专业许可时，领的是专业许可，不再落到个人许可上；只有个人许可的资产照常领取，不额外多跑一趟请求。
  - **扫描与入库同一身份**：搜索、核对、领取全部用你当前登录的账号发起，扫出来的清单与页面上看到的清单一致——之前用匿名身份读目录，同样的筛选会多出不在这页上的资产。
  - **入库速度**：不再一条条点页面上的按钮，改成成批把资产存进库里，速度从每秒 1 条左右提到每秒 12 条左右；中途停下可以接着上一次继续，网站限速时会自动放慢等待。
  - **边扫边存**：读到一批就开始存，不用等全部扫完；一次存多少可以自己调；暂停后点「入库(n)」能把已经扫描的一次存完。
  - **跟着页面走**：搜索词、发行商、左侧类别、排序都沿用页面当前的条件；多选的筛选项（例如格式同时勾 FBX 和 OBJ、同时勾多个发行商）也按页面原样一起带上，不会被压成只剩最后一项；从频道页进来同样生效；账号里已经设了「不显示库内资产」时，脚本不再重复核对。
  - **看得见的进度**：每存好一条，面板上方弹一条气泡；对应卡片当场变成「已保存在我的库中」并扫一道光；这一屏看不到的卡片会排队，滚到哪儿就依次亮到哪儿。
  - **操作细节**：批量滑杆停在 1 / 10 / 20 / 50 / 100 … 5000 共 13 个整数档，`↺` 回到默认的 100；扫描时页面不会自己乱滚；界面语言跟着站点自动切换，覆盖 14 种语言。
  - **快捷入口**：新增带 Quixel 图标的 **Megascan** 与 **免费资产** 两个跳转按钮，分别打开 Quixel Megascans 的免费资产与全站免费资产，均按最新发布排序；按钮颜色与运行按钮区分，文字随界面语言变化。
- v2.4.2：更新以匹配最新版FAB网站
- v2.0：完全重写以匹配新版FAB网站
- v1.0：初始版本

## 许可

AGPL-3.0-or-later

---

# FAB Free Asset Getter

A Tampermonkey script that collects all free assets from the FAB marketplace into your library in bulk.

## Features

- A "FAB Bulk Import" panel appears in the bottom-right corner of any `fab.com` page — press start and it scans and claims for you
- The scan follows the page: whole free catalogue, one seller, a keyword, the left-hand category tree or a channel page — every filter you see, multi-select included, and the ordering are the ones used
- A free asset that offers both a personal and a professional licence is claimed on the professional one; assets with a personal licence only are claimed as usual
- Scans and saves at the same time, at roughly 12 assets per second; a stopped run continues where it left off
- Each saved asset turns its card into the site's own "saved in my library" state with a light sweep, and pops a bubble above the panel
- Batch size is adjustable: a slider with 13 steps (1 – 5000) plus a free-form number box; `↺` restores the default 100
- Two switches: follow the cards, and import effects — both on by default
- The status row shows the account you are signed in with, so you can confirm at a glance whose library the run is filling
- The interface speaks 14 languages and follows the site's own language setting
- A full-screen finish effect plays once the last page is scanned and the queue is empty
- Bundles and other free types that the claim endpoint refuses are put in the cart automatically; one checkout at the end collects them, and the finish effect waits for that order
- Two shortcuts: **Megascan**, with the Quixel mark, opens the Quixel Megascans free listings sorted by newest; **Free assets** opens the whole free catalogue in the same order

## Installation

1. First, install the Tampermonkey browser extension:
   - Chrome: [Tampermonkey](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
   - Firefox: [Tampermonkey](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/)
   - Edge: [Tampermonkey](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd)

2. Install the script:
   - Option 1: click "Install this script" on the [Greasy Fork](https://greasyfork.org/zh-CN/scripts/534044-fab-free-asset-getter) page
   - Option 2: open Tampermonkey's utilities tab from [here](chrome-extension://dhdgffkkebhmkfjojejmpbldmpobfkfo/options.html#nav=utils-tab) and install from this URL:
     ```
     https://raw.githubusercontent.com/noslipper/FAB-Free-Asset-Getter-Latest/refs/heads/main/fab.js
     ```
   - Option 3: open the Tampermonkey dashboard, add a new script and paste the contents of `fab.js`

## Usage

1. Sign in to FAB and open the page you want to work on, for example the whole free catalogue at `https://www.fab.com/search?is_free=1`
2. Set the batch size if you need to, then press Start
3. Press Pause to stop; anything already scanned can be saved with the Import(n) button, and Clear wipes the saved progress

## Notes

- Sign in to your FAB account first
- Assets already in your library are skipped automatically
- On Edge you must enable Tampermonkey's "Allow user scripts" switch (edge://extensions -> Tampermonkey -> Details -> Allow user scripts), otherwise the script will not run at all
- Keep the tab in the foreground: background tabs get their timers throttled
- If FAB starts throttling, the script slows down and waits by itself — a short pause is enough

## Version History

- **v3.7.8** — what changed:
  - **Free tiers only**: the professional tier of one listing can be sold separately while the personal tier is free, so carting now picks among free tiers only, preferring professional and falling back to personal. No payable line can enter the cart.
- **v3.7.7** — what changed:
  - **Bundles are no longer misread as owned**: owning any single listing inside a bundle makes the state endpoint answer acquired, which used to skip the whole bundle. Bundles are now excluded from that check and always go to the cart.
  - **Bundles go straight to the cart**: the claim request that could only return 400 is skipped, so each bundle costs one less round trip.
  - **Request timeout**: a 20 second ceiling per request, so one stalled connection cannot freeze the run.
- **v3.7.6** — what changed:
  - **Bundles go through the cart**: bundles, and any other free type the claim endpoint refuses, are added to the cart with the right licence automatically; when the scan ends the panel offers a Checkout(n) entry that collects them in one order.
  - **The finish waits for the order**: the human check on the checkout page stays with the person, so the script watches the cart, then verifies the library really has the assets before counting them and playing the finish effect; an emptied cart with nothing acquired is reported as a miss, not a success.
  - **Second pass on the cart**: after adding, the cart is read back and anything missing is added again, so the count on screen matches what is really in the cart.
- **v3.7.5** — what changed:
  - **Signed-in indicator**: the status row shows the account the run is using and flags a signed-out session, so a scan that saves nothing to your library is visible immediately.
  - **Finish effect**: a full-screen completion animation plays once the last page is scanned and the queue is drained, summarising how many assets were saved; turn the effects switch off for a quiet finish.
  - **Bundles reported honestly**: bundle listings cannot be claimed through the library endpoint, FAB only offers the cart for them, so they are no longer counted as ordinary skips and their number is reported at the end.
  - **Cleaner finish**: the remaining queue is drained before a run is declared complete, so a finished run no longer leaves a few assets unsaved.
- **v3.7.4** — what changed:
  - **Professional licence first**: when a free asset offers both a personal and a professional licence, the professional one is claimed instead of the personal one; assets with only a personal licence are claimed as before, with no extra request.
  - **One identity for scan and save**: search, ownership check and claim all run under the account you are signed in with, so the list scanned matches the list on the page — reading the catalogue anonymously used to bring back assets this page never showed under the same filters.
  - **Import speed**: instead of clicking through the page one item at a time, assets are saved in batches, lifting the rate from about 1 per second to about 12 per second; a stopped run picks up where it left off, and the script slows down and waits by itself when the site starts throttling.
  - **Scan and save at once**: saving starts as soon as a batch is read, no need to finish scanning first; the batch size is yours to set; after a pause, Import(n) saves everything already scanned in one go.
  - **Follows the page**: search term, sellers, the left-hand category tree and sorting all match what the page is showing, including when you come in from a channel page; multi-select facets (two formats such as FBX and OBJ at once, several sellers) are carried through exactly as the page has them instead of collapsing to the last value; if your account already hides library items, the duplicate check is skipped.
  - **Visible progress**: a bubble pops up above the panel for each saved asset; the matching card switches to the saved state on the spot with a light sweep; cards outside the viewport queue up and light up one by one as you scroll to them.
  - **Small details**: the batch slider stops at 13 whole steps (1 / 10 / 20 / 50 / 100 … 5000) and `↺` puts it back to 100; scanning never scrolls the page by itself; the interface language follows the site and covers 14 languages.
  - **Shortcuts**: two new jump buttons, **Megascan** with the Quixel mark and **Free assets**, open the Quixel Megascans free listings and the whole free catalogue, both sorted by newest; their colours differ from the run buttons and the labels follow the interface language.
- v2.4.2: Updated to match the latest FAB website
- v2.0: Rewritten to match the new FAB website
- v1.0: Initial version

## License

AGPL-3.0-or-later
