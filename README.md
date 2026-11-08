# ADHD Reader for Chrome

[English](#english) · [中文](#中文)

## English

ADHD Reader is a local PDF reader with a persistent single-line reading guide, continuous scrolling, Chinese word translation and portable PDF annotations. The current interface is in Chinese. This repository contains the Chrome extension and the same reader as a standalone local web app.

### Install

Requires **Chrome 125 or newer**.

1. Download [`ADHD-Reader-Chrome.zip`](https://github.com/julyseaweed/adhd-reader-chrome/releases/latest/download/ADHD-Reader-Chrome.zip) from Releases.
2. Extract it to a permanent folder.
3. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
4. Select the extracted folder containing `manifest.json`, then pin ADHD Reader to the toolbar.

The ZIP is an unpacked-extension package, not a Chrome Web Store installation. To update, replace the files in the same folder and click **Reload** on the extension card. Keep the same installed extension and folder to retain its local drafts.

### Read and annotate

- Open a local PDF with the file picker or drag it into the reader. The home screen lists the five most recently opened PDFs.
- Click a text line to place the guide. Up moves to the previous reading unit; Down or Enter moves to the next one, across columns and pages. The guide stays on one reading unit and gently recenters when needed.
- Wheel, touch and scrollbar movement browse the document without changing the locked reading position. The next reading key resumes from that position. Explicit page navigation starts at that page; clicking text sets a new position.
- Figure and table interiors are skipped during line navigation, while captions and notes remain readable. Their text stays available for selection and annotation. Fractions, roots, scripts and other formula parts are grouped into reading units.
- Drag or double-click to select text. Use the floating toolbar or the highlight, underline and comment tools. The color control appears only in highlight mode and cycles through pale yellow, blue and gray. Underlines always export as black PDF underlines.
- Press Enter with a selection to show Chinese meanings next to it. English words use the bundled offline dictionary first; phrases, other languages and missing words use online translation.
- In select mode, click an annotation to open its menu. Delete it, or edit a comment created in this reader. Delete and Backspace remove the selected annotation; the annotation panel also provides editing and deletion.
- Press E to erase: click one annotation or drag across several. Each stroke is one undo step. Touch scrolling does not erase annotations. Undo and redo also restore deletions.
- Imported standard Highlight, Underline and Text annotations can be deleted. Other imported annotation types remain read-only and are preserved. Marks flattened into page content cannot be erased as annotations.
- **Save PDF** downloads an annotated copy. Highlights, underlines and comments are written as standard PDF annotations with appearance streams and Unicode comments, so other readers, including Zotero, can display them.
- Day mode is the default. The day/night choice and surrounding-text dimming are remembered. Pinch and trackpad zoom respond to smaller gestures, changing only the PDF while the toolbar stays the same size.

| Key | Action |
| --- | --- |
| Up / Down | Previous / next reading unit |
| Enter | Translate selected text; otherwise next reading unit |
| F | Toggle the line guide |
| V / H / U / N / E | Select / highlight / underline / comment / erase |
| Delete / Backspace | Delete the selected annotation |
| Ctrl or Cmd + O | Open PDF |
| Ctrl or Cmd + S | Download annotated PDF |
| Ctrl or Cmd + Z | Undo |
| Ctrl or Cmd + Shift + Z | Redo |
| Escape | Dismiss selection or floating controls |
| Alt + Shift + L | Open the extension; configurable at `chrome://extensions/shortcuts` |

Typing in a comment field keeps normal text-editing behavior.

### Storage and network privacy

PDFs, drafts and reading positions are stored locally in the current browser's IndexedDB. Local reading and PDF export need no account or server. The app has no telemetry and does not upload PDFs to a translation service. Save annotated PDFs for a durable copy: uninstalling the extension or clearing its browser data can remove local drafts. The extension, a separately hosted web reader and Zotero have separate storage; exchange work through exported PDFs.

The offline English–Chinese dictionary is included with the extension. Language detection uses the selection and nearby document text locally. If an online translation is needed, a user-triggered translation sends **only the selected text (up to 500 UTF-8 bytes) and detected source-language code** to [MyMemory](https://mymemory.translated.net/doc/spec.php). Nearby context and the PDF are not sent. The provider controls availability and quotas and receives normal network-request metadata. Failed or unchanged responses are not cached as successful translations.

Opening a remote PDF contacts its original website directly. The request may include that site's cookies for authenticated access. Website permissions are requested when needed, rather than broad website access at installation. If authentication or download restrictions prevent access, download the PDF and import it locally.

Scanned pages need OCR before text-based reading and annotation; OCR is not included. Password-protected PDFs can be read after entering a password, but annotation export requires a decrypted PDF. Unusual layouts may still need manual text positioning.

### Develop and build

Requires **Node.js 22.13 or newer** and npm.

```sh
npm ci
npm run build
npm test
npx playwright install chromium
npm run test:browser
```

`extension/` is ready for **Load unpacked**. `dist/` contains the standalone static reader, including PDF.js workers, fonts, CMaps and WASM; no CDN scripts are used. For a local preview:

```sh
npm run dev
```

Open `http://127.0.0.1:4173`. Browser tests start their own temporary local server and isolated browser contexts. They generate synthetic PDFs at runtime and require no personal documents. `CHROME_EXECUTABLE` can optionally point to an existing Chrome executable; otherwise Playwright's installed Chromium is used.

```sh
npm run package
npm run check:release
```

The release ZIP and `SHA256SUMS` are written to `release-artifacts/`. Generated output, dependencies and test artifacts are ignored by Git. Rebuild the bundled dictionary, if needed, with `python scripts/import-dictionary.py --download`; its fixed source revision is recorded in `public/dictionary/index.json`.

### Zotero and licenses

The companion [ADHD Reader for Zotero](https://github.com/julyseaweed/adhd-reader-zotero) adds the reading guide to Zotero's native reader and keeps Zotero's annotation workflow. Its translation behavior is separate; the Zotero add-on does not include this Chrome reader's translation feature.

The project source has no assigned license yet. Third-party components retain their respective licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). ECDICT's MIT license and source revision are included with the dictionary.

## 中文

ADHD Reader 是一个本地 PDF 阅读器，提供持久的单行引导、连续滚动、中文释义和可保存到 PDF 的标注。当前界面为中文。本仓库包含 Chrome 扩展，以及同一阅读器的独立本地网页版本。

### 安装

需要 **Chrome 125 或更新版本**。

1. 在 Releases 下载 [`ADHD-Reader-Chrome.zip`](https://github.com/julyseaweed/adhd-reader-chrome/releases/latest/download/ADHD-Reader-Chrome.zip)。
2. 解压到固定文件夹。
3. 打开 `chrome://extensions`，开启「开发者模式」，点击「加载已解压的扩展程序」。
4. 选择包含 `manifest.json` 的解压文件夹，再将 ADHD Reader 固定到工具栏。

这个 ZIP 用于加载已解压扩展，不是 Chrome 网上应用店安装包。更新时覆盖同一文件夹中的文件，并在扩展卡片上点击「重新加载」。保留原安装项和文件夹，可以继续使用本地草稿。

### 阅读与标注

- 用文件选择器打开 PDF，或直接拖入。首页显示最近打开的五份 PDF。
- 点击文字行定位；上键读上一单元，下键或 Enter 读下一单元，可跨栏和跨页。引导固定为一个阅读单元，需要时柔和回移。
- 滚轮、触摸和滚动条只浏览页面，不改变锁定的阅读位置。再次按阅读键会从原位置继续。主动翻页从该页开始，点击文字会重新定位。
- 逐行阅读跳过图片和表格内部，保留图注、表题和表注；图表内文字仍可选择和标注。分式、根号、上下标等公式部分会组合为完整阅读单元。
- 拖选或双击文字后使用浮动工具栏，也可先选高亮、下划线或评论工具。颜色控件仅在高亮模式显示，可切换淡黄、淡蓝、淡灰；下划线始终按黑色 PDF 下划线导出。
- 有选区时按 Enter，在旁边显示中文含义。英文单词优先使用随包离线词典；短语、其他语言及未收录词使用在线翻译。
- 在选取模式点击已有标注，弹出菜单可删除标注，或修改本阅读器创建的评论。Delete、Backspace 可删除选中的标注；标注面板也提供编辑和删除操作。
- 按 E 切换擦除工具，点击擦除一条标注，拖动可擦除经过的多条。一次拖擦对应一步撤销；触摸滚动不会擦除标注。删除支持撤销、重做。
- 导入 PDF 中标准的 Highlight（高亮）、Underline（下划线）、Text（评论）标注可删除，其他原有标注保留并只读显示。已扁平化到页面内容中的痕迹不能作为标注擦除。
- 「保存 PDF」下载带标注的副本。高亮、下划线和评论以标准 PDF 标注、外观流及 Unicode 评论写入，Zotero 等其他阅读器也能显示。
- 默认白天模式，记住日夜模式及周围文字淡化偏好。双指和触控板缩放响应更灵敏，只改变 PDF，工具栏保持原尺寸。

| 按键 | 操作 |
| --- | --- |
| 上 / 下 | 上一 / 下一阅读单元 |
| Enter | 有选区时翻译，否则下一阅读单元 |
| F | 开关行引导 |
| V / H / U / N / E | 选取 / 高亮 / 下划线 / 评论 / 擦除 |
| Delete / Backspace | 删除选中的标注 |
| Ctrl 或 Cmd + O | 打开 PDF |
| Ctrl 或 Cmd + S | 下载带标注的 PDF |
| Ctrl 或 Cmd + Z | 撤销 |
| Ctrl 或 Cmd + Shift + Z | 重做 |
| Escape | 关闭选区或浮动控件 |
| Alt + Shift + L | 打开扩展，可在 `chrome://extensions/shortcuts` 修改 |

评论输入框保留正常的文字编辑行为。

### 本地存储与网络隐私

PDF、草稿和阅读位置保存在当前浏览器的 IndexedDB。本地阅读和 PDF 导出无需账号或服务器，应用没有遥测，也不会把 PDF 上传到翻译服务。请保存带标注的 PDF 留存：移除扩展或清理浏览器数据可能删除本地草稿。扩展、单独部署的网页阅读器与 Zotero 使用各自的存储，可通过导出的 PDF 交换标注。

扩展包含离线英汉词典。原文语言由选区及附近正文在本机识别。需要在线翻译时，用户主动触发的请求**只把所选文字（最多 500 个 UTF-8 字节）及检测到的原文语言代码**发送给 [MyMemory](https://mymemory.translated.net/doc/spec.php)，不发送附近正文或 PDF。服务方管理可用性和额度，并接收正常网络请求元数据。失败或原文回显不会作为成功译文缓存。

打开远程 PDF 会直接请求文件原网站；为访问需要登录的文件，请求可能携带该网站的 Cookie。网站权限按需请求，安装时不要求访问所有网站。遇到认证或下载限制，可先下载再本地导入。

扫描页需要先进行 OCR，阅读器未内置 OCR。加密 PDF 可输入密码阅读，但导出标注需要先取得已解密的 PDF。不规则版面可能仍需手动点击定位。

### 开发与构建

需要 **Node.js 22.13 或更新版本**和 npm。

```sh
npm ci
npm run build
npm test
npx playwright install chromium
npm run test:browser
```

`extension/` 可直接「加载已解压的扩展程序」。`dist/` 是完整静态阅读器，包含 PDF.js Worker、字体、CMaps 和 WASM，不使用 CDN 脚本。本地预览：

```sh
npm run dev
```

打开 `http://127.0.0.1:4173`。浏览器测试自行启动临时本地服务和隔离浏览器环境，运行时生成合成 PDF，不需要私人文档。可用 `CHROME_EXECUTABLE` 指定现有 Chrome 程序；否则使用 Playwright 安装的 Chromium。

```sh
npm run package
npm run check:release
```

发行 ZIP 和 `SHA256SUMS` 写入 `release-artifacts/`。构建输出、依赖和测试产物均被 Git 忽略。若需重建词典，可运行 `python scripts/import-dictionary.py --download`；固定源版本记录在 `public/dictionary/index.json`。

### Zotero 与许可证

姊妹项目 [ADHD Reader for Zotero](https://github.com/julyseaweed/adhd-reader-zotero) 在 Zotero 原生阅读器内提供行引导，并保留原生标注流程。Zotero 插件不含本 Chrome 阅读器的翻译功能。

项目源码尚未指定许可；第三方组件适用各自的许可证，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。ECDICT 的 MIT 许可证和源版本随词典分发。
