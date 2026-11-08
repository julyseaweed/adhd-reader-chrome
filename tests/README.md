# Test data / 测试数据

All included PDF fixtures are generated from original drawing code in this repository. No PDF files, personal reading material, captured document text, screenshots, browser profiles, annotations or local databases are committed.

The portable unit suite covers focus geometry, scrolling, column ordering, word selection, the bundled dictionary, translation validation and extension permissions. Browser tests generate their PDFs at runtime and use temporary browser contexts. Network translation responses are mocked in unit tests.

Selection-boundary browser tests use independently authored PDF glyph advances for mouse coordinates, so a misaligned DOM text layer cannot validate itself. They cover both drag directions, zoom, partial words and split text runs.

本目录的 PDF 夹具均由仓库内原创绘制代码生成，不提交 PDF 文件、私人阅读材料、文档摘文、截图、浏览器资料、标注或本地数据库。

便携单元测试覆盖行引导几何、滚动、分栏顺序、选词、随包词典、译文校验和扩展权限。浏览器测试在运行时生成 PDF，并使用临时浏览器环境。翻译单元测试模拟网络响应。

选字边界测试根据独立编写的 PDF 字形宽度确定鼠标坐标，避免错位的 DOM 文字层自我验证。覆盖正反向拖选、缩放、部分单词和多个文字片段。
