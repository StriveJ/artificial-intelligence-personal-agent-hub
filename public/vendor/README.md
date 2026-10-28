# 浏览器 Markdown 依赖

此目录包含从官方 npm 包提取的原始浏览器模块，随 Hub 本地提供，不依赖运行时 CDN，也不需要执行 npm install。

- Marked 18.1.1：`marked/lib/marked.esm.js`，MIT，许可见 `LICENSE-marked`。
- DOMPurify 3.4.17：`dompurify/dist/purify.es.mjs`，Apache-2.0 或 MPL-2.0 双许可，见 `LICENSE-DOMPurify` 和 `LICENSE-DOMPurify-MPL`。
- 来源地址及已校验的包 SHA-512 完整性记录见 `versions.json`。库文件保持上游原样。

更新时从 `https://registry.npmjs.org/<name>/<version>` 获取发布元数据，下载 `dist.tarball`，校验其 `dist.integrity`，再提取上述文件并同步版本、许可与完整性记录。验证 Markdown 渲染和危险 HTML/链接过滤后再更新。
