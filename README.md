# FAB Free Asset Getter

[中文版本](#fab免费资产获取器)

A Tampermonkey script that helps you automatically collect all free assets from the FAB marketplace with one click.

## Features

- Adds a "Get Free Assets" button to FAB marketplace channel pages
- Automatically identifies all free assets on the page
- Filters out assets already in your library
- Shows progress information with toast notifications
- Supports multiple languages (English, Chinese)
- Uses API and iframe methods to add assets to your library without popups
- Handles network errors gracefully

## Installation

1. First, install the Tampermonkey browser extension:
   - Chrome: [Tampermonkey](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
   - Firefox: [Tampermonkey](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/)
   - Edge: [Tampermonkey](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd)

2. Install the script:
   - Method 1: Click [here](chrome-extension://dhdgffkkebhmkfjojejmpbldmpobfkfo/options.html#nav=utils-tab) to open Tampermonkey's utility tab, then install from URL using:
     ```
     https://raw.githubusercontent.com/noslipper/FAB-Free-Asset-Getter-Latest/refs/heads/main/fab.js
     ```
   - Method 2: Open Tampermonkey Dashboard -> Add New Script, then copy and paste the content of `fab.js`

## Usage

1. Visit a FAB marketplace channel page, for example:
   - English: https://www.fab.com/channels/unreal-engine?is_free=1&sort_by=-createdAt
   - Chinese: https://www.fab.com/zh-cn/channels/unreal-engine?is_free=1&sort_by=-createdAt

2. Click the "Get Free Assets" button in the top right corner of the page
3. The script will automatically scan the page for free assets, filter out those already in your library, and add the remaining assets to your library
4. Progress information will be displayed with toast notifications

## Notes

- Make sure you are logged into your FAB account before using the script
- The script will skip assets that are already in your library
- If you encounter any issues, try refreshing the page and trying again
- The script works on all FAB marketplace pages, including search results
- You need to enable Developer Mode in your browser's extensions page

## Version History

- v2.0: Complete rewrite to match new FAB website design
- v1.0: Initial version with basic functionality

## License

AGPL-3.0-or-later

---

# FAB免费资产获取器

[English Version](#fab-free-asset-getter)

这是一个Tampermonkey脚本，可以帮助你一键获取FAB商城中的所有免费资产。

## 功能

- 在FAB商城频道页面添加"添加免费资产"按钮
- 自动识别页面上的所有免费资产
- 过滤掉已经在你库中的资产
- 通过气泡通知显示进度信息
- 支持多种语言（英文、中文）
- 使用API和iframe方法添加资产到你的库中，无需弹出窗口
- 优雅地处理网络错误

## 安装方法

1. 首先安装Tampermonkey浏览器扩展：
   - Chrome: [Tampermonkey](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
   - Firefox: [Tampermonkey](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/)
   - Edge: [Tampermonkey](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd)

2. 安装脚本：
   - 方法1：点击[这里](chrome-extension://dhdgffkkebhmkfjojejmpbldmpobfkfo/options.html#nav=utils-tab)打开Tampermonkey的实用工具标签，然后从URL安装：
     ```
     https://raw.githubusercontent.com/noslipper/FAB-Free-Asset-Getter-Latest/refs/heads/main/fab.js
     ```
   - 方法2：打开Tampermonkey Dashboard -> 添加新脚本，然后复制粘贴`fab.js`中的内容

## 使用方法

1. 访问FAB商城频道页面，例如：
   - 中文：https://www.fab.com/zh-cn/channels/unreal-engine?is_free=1&sort_by=-createdAt
   - 英文：https://www.fab.com/channels/unreal-engine?is_free=1&sort_by=-createdAt

2. 点击页面右上角的"添加免费资产"按钮
3. 脚本会自动扫描页面上的免费资产，过滤掉已经在你库中的资产，并将剩余的资产添加到你的库中
4. 进度信息会通过气泡通知显示

## 注意事项

- 使用脚本前请确保已登录FAB账号
- 脚本会跳过已经在你库中的资产
- 如果遇到问题，可以尝试刷新页面后再使用
- 脚本适用于所有FAB商城页面，包括搜索结果
- 需要在浏览器的扩展程序页面开启开发者模式

## 版本历史

- v2.0: 完全重写以匹配新版FAB网站设计
- v1.0: 初始版本，实现基本功能

## 许可

AGPL-3.0-or-later
