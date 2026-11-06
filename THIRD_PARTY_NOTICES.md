# Third-party notices / 第三方说明

The project source has no assigned license yet. Third-party components retain the licenses listed below.

项目源码尚未指定许可；第三方组件适用下列许可证。

| Component / 组件 | License / 许可证 | Source / 来源 |
| --- | --- | --- |
| PDF.js (`pdfjs-dist`) | Apache-2.0 | https://github.com/mozilla/pdf.js |
| pdf-lib | MIT | https://github.com/Hopding/pdf-lib |
| @pdf-lib/standard-fonts | MIT | https://github.com/Hopding/standard-fonts |
| @pdf-lib/upng | MIT | https://github.com/Hopding/upng |
| pako | MIT and Zlib | https://github.com/nodeca/pako |
| tslib | 0BSD | https://github.com/microsoft/tslib |
| franc | MIT | https://github.com/wooorm/franc |
| iso-639-3 | MIT | https://github.com/wooorm/iso-639-3 |
| trigram-utils | MIT | https://github.com/wooorm/trigram-utils |
| n-gram | MIT | https://github.com/words/n-gram |
| collapse-white-space | MIT | https://github.com/wooorm/collapse-white-space |
| ECDICT dictionary / 词典 | MIT | https://github.com/skywind3000/ECDICT |

The release includes complete runtime notices in `reader/vendor/licenses/`. PDF.js font and WASM directories also retain their bundled notices. Dictionary attribution and its pinned source revision are in `reader/dictionary/LICENSE.txt` and `reader/dictionary/index.json`. In the source repository the dictionary files are under `public/dictionary/`; the franc notice is in `vendor-licenses/franc-LICENSE` because the pinned npm package omits that file.

发行包的 `reader/vendor/licenses/` 包含运行时组件的完整许可文本，PDF.js 字体及 WASM 目录也保留自带的说明。词典署名和固定源版本位于 `reader/dictionary/LICENSE.txt` 与 `reader/dictionary/index.json`。源码仓库对应目录为 `public/dictionary/`；固定版本的 franc npm 包缺少许可文件，因此单独保存在 `vendor-licenses/franc-LICENSE`。

Build and test tools are development dependencies, are not included in the extension ZIP, and retain the licenses distributed with their npm packages. The dependency versions and integrity hashes are pinned in `package-lock.json`.

构建和测试工具属于开发依赖，不打入扩展 ZIP，保留 npm 包中的各自许可。依赖版本及完整性校验固定在 `package-lock.json`。
