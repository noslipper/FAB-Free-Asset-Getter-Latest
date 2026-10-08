[README.md](https://github.com/user-attachments/files/33190590/README.md)
# FAB Free Asset Getter

[中文版本](#fab免费资产获取器)

A Tampermonkey script that helps you automatically collect all free assets from the FAB marketplace with one click.

## Features

- Adds a "Get Free Assets" button to FAB marketplace pages
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

1. Visit a FAB marketplace page, for example:
   - English: https://www.fab.com/channels/unreal-engine?is_free=1&sort_by=-createdAt
   - Chinese: https://www.fab.com/zh-cn/channels/unreal-engine?is_free=1&sort_by=-createdAt

2. On channel pages a blue **"Go to Free Search"** button appears in the bottom-right corner; click it to jump to the free asset search page
3. On the free asset search page, click the green **"Get Free Assets"** button in the bottom-right corner
4. The script will automatically scan the page for free assets, filter out those already in your library, and add the remaining assets to your library
5. Progress information will be displayed with toast notifications

## Notes

- Make sure you are logged into your FAB account before using the script
- The script will skip assets that are already in your library
- If you encounter any issues, try refreshing the page and trying again
- The script works on all FAB marketplace pages, including search results
- You need to enable Developer Mode in your browser's extensions page
- **<span style="color:#e53935;font-weight:bold">Edge only: you must enable the "Allow user scripts" switch for Tampermonkey</span>** (edge://extensions -> Tampermonkey -> Details -> Allow user scripts). Without it, the script will not run on any page even though it appears to be installed and enabled.

## Version History

- v2.4.2: Updated to match the latest FAB website
- v2.0: Rewritten to match the new FAB website
- v1.0: Initial version

## License

AGPL-3.0-or-later

---

# FAB免费资产获取器

[English Version](#fab-free-asset-getter)

这是一个Tampermonkey脚本，可以帮助你一键获取FAB商城中的所有免费资产。

## 功能

- 在FAB商城页面添加"添加免费资产"按钮
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

1. 访问FAB商城页面，例如：
   - 中文：https://www.fab.com/zh-cn/channels/unreal-engine?is_free=1&sort_by=-createdAt
   - 英文：https://www.fab.com/channels/unreal-engine?is_free=1&sort_by=-createdAt

2. 在频道页面右下角会出现蓝色 **"Go to Free Search"** 按钮，点击跳转到免费资产搜索页
3. 在免费资产搜索页，点击右下角绿色 **"Get Free Assets"** 按钮
4. 脚本会自动扫描页面上的免费资产，过滤掉已经在你库中的资产，并将剩余的资产添加到你的库中
5. 进度信息会通过气泡通知显示

## 注意事项

- 使用脚本前请确保已登录FAB账号
- 脚本会跳过已经在你库中的资产
- 如果遇到问题，可以尝试刷新页面后再使用
- 脚本适用于所有FAB商城页面，包括搜索结果
- 需要在浏览器的扩展程序页面开启开发者模式
- **<span style="color:#e53935;font-weight:bold">Edge浏览器：必须开启Tampermonkey的「允许用户脚本」开关</span>**（edge://extensions -> Tampermonkey -> 详细信息 -> 允许用户脚本）。未开启时脚本虽然显示已安装、已启用，但不会在任何页面上运行。

## 版本历史

- v2.4.2：更新以匹配最新版FAB网站
- v2.0：完全重写以匹配新版FAB网站
- v1.0：初始版本

## 许可

AGPL-3.0-or-later

