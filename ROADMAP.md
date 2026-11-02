# 开发计划与边界 / Roadmap and boundaries

**[DOWNLOAD-STANDARDS.md](DOWNLOAD-STANDARDS.md)**（标准与真实实现）· [DEVELOPMENT.md](DEVELOPMENT.md) · [AGENTS.md](AGENTS.md)

本文只回答两个问题：**接下来做什么**、**永远不做什么**。技术依据来自 [DOWNLOAD-STANDARDS.md](DOWNLOAD-STANDARDS.md)，编号 G1–G12 与那里的差距清单一一对应。

---

## 1. 能力上限（先认清边界）

Manifest V3 扩展只能看到 **HTTP 层可见的那部分用户意图**：响应头、请求元信息、资源类型、URL 形状。以下信息在协议层根本不存在，任何规则都拿不到：

| 拿不到的东西 | 原因 |
| --- | --- |
| `blob:` / `data:` 下载 | 不经过 `webRequest` |
| `<a download="报告.pdf">` 的文件名 | 属性只存在于 DOM，不上网络 |
| `fetch → Blob → <a download>` 的真实文件语义 | 网络层看就是一个 XHR，URL 常是 `/api/export` |
| StreamSaver / File System Access 的「下载」 | 压根没有 HTTP 下载事件 |
| 浏览器的最终处置决定 | Chrome 在 `onHeadersReceived` **之后**才决定下载还是渲染 |
| 请求体之外的完整原始请求 | `webRequest` 不给响应体，也不给 Cookie 明文以外的鉴权材料 |

⇒ 结论：**看不见的部分交给面板和右键，不靠加规则硬凑。** 判定永远只在「证据充分」时接管。

---

## 2. 永久不做（黑名单）

| 不做 | 理由 |
| --- | --- |
| Hook 页面的 `fetch`/XHR 去还原 blob 文件名 | 等于代理请求，违反 AGENTS.md「不代理请求、不改响应体」；且会与浏览器各下一份 |
| 接管 `blob:`/`data:`/StreamSaver/`showSaveFilePicker` | 要么无 HTTP 对象，要么文件已落盘，接管即重复 |
| 批量自动接管（一次点几十个文件） | Chrome 对无手势连续下载有限流并要求站点权限，体验比漏抓更糟 |
| 模仿 IDM 的「取消并重放」全量拦截 | MV3 没有 `webRequestBlocking`，做不到，也不该做 |
| 合并 DASH 音视频轨、转码、绕 DRM | 既有非目标 |
| 向 NDM 发送响应 `Content-Disposition` | 会造成 416 与错误命名 |
| 任何外部上报、统计、云服务、自动更新 | 数据不出本机；只与 `127.0.0.1` 通信 |
| 替用户确认 Chrome 的危险文件提示 | 扩展无法静默满足 `dangerType`，企业策略下更不行 |
| 承诺保留页面给定的文件名 | NDM 协议当前没有文件名字段；先确认协议支持再说 |

---

## 3. P0 —— 纯收紧，低风险（已完成）

| 编号 | 做什么 | 状态 | 验收结果 |
| --- | --- | --- | --- |
| G1 | 读响应 `Content-Encoding`；命中 `gzip/br/deflate`（非 `identity`）时**不发 `7:` 大小** | ✅ | [src/lib/rules.js:91-97](src/lib/rules.js#L91-L97)、[:218-226](src/lib/rules.js#L218-L226)；单元测试 3 条 + 夹具场景 12（去掉规则夹具会红，断言有效） |
| G2 | 处理 `Accept-Ranges` 死字段：`snapshot` 读了却从不使用 | ✅ 删除 | 判定不依赖「服务器说可以分段」，不留僵尸字段 |
| G10 | POST 请求体超过 96KB 上限时**拒绝接管**，不再静默截断后照发 | ✅ | [src/lib/utils.js:184-200](src/lib/utils.js#L184-L200)（raw）+ `limitBody` [:249-254](src/lib/utils.js#L249-L254)（表单）；[src/lib/rules.js:76-78](src/lib/rules.js#L76-L78) |
| G11 | 修正 DEVELOPMENT.md：`decideCapture()` 入参里没有 `tabId` | ✅ 改文档 | 中英两版签名与输入表已同步，新增 `contentEncoding` / `postBodyTooLarge` 两行 |
| G12 | 兜底下载路径假设 GET，会把「只有带请求体才成立」的下载当 GET 重取 | ✅ 本轮新发现 | `BROWSER_ONLY_REASONS`（[src/lib/constants.js:260-265](src/lib/constants.js#L260-L265)）+ [src/background.js:912-921](src/background.js#L912-L921)；夹具场景 13 守卫 |

## 4. P1 —— 有收益，需要新夹具与回归（已完成）

| 编号 | 做什么 | 状态 | 验收结果 |
| --- | --- | --- | --- |
| G6a | 重定向链：确认 302→zip 的判定与去重按**最终 URL** 生效 | ✅ 夹具 14 | 恰好 1 条，`/redirect-c14.zip` 不得出现 |
| G6b | NDM `waiting` 的 HEAD 补齐：非 2xx 要落一条可诊断日志，而不是静默 return | ✅ | `source: waiting`、`skipped: head-status-<code>`（[src/background.js:567-581](src/background.js#L567-L581)）；顺带丢弃压缩长度（[:584-588](src/background.js#L584-L588)） |
| G4 | `catcher` 的下载链接提示只看 `hasAttribute('download')` | ✅ | origin 比较（`data:`/`blob:` 例外），[src/content/catcher.js:134-149](src/content/catcher.js#L134-L149)；只影响 Ctrl 绕过提示，不改判定 |
| G6c | 跨 host 重定向后 Referer/Cookie 作用域仍按原始 URL 打包 | ⏳ 未做 | 需要真实签名 CDN 才能验证，本地夹具造不出过期签名；留在观察名单 |


## 5. P2 —— 观察名单（没有真实站点案例就不动手）

- **G3 `Sec-Fetch-User: ?1`**：`download` 不是一个 dest 值，`?1` 也无法区分「点开页面」与「点下载链接」。现有 `type === 'main_frame'` 已是标准等价近似，它只能作为加分项，**不能单独放行**。
- **G8 `multipart/byteranges`**：206 目前只在明确附件时放行，暴露面很小。
- **G7 203 Non-Authoritative**：接受它是有意宽松，保持现状，仅文档标注。
- **G5 文件名不上协议线**：属于 NDM 协议限制，先确认协议是否支持文件名字段，再谈功能。
- **G9 兜底路径伪造 `statusCode: 200`**：已知取舍，不改。

---

## 6. 验证边界（什么测试能证明什么）

| 层次 | 能覆盖 | 不能覆盖 |
| --- | --- | --- |
| `node tests/*.test.mjs` | 规则分支、NDM 报文构造、消息路由（假 `chrome.*` + 假 WebSocket） | 真实浏览器行为、缓存、扩展生命周期 |
| `node scripts/web-test.mjs --fixtures` | 该抓的一条不少、不该抓的一条不多；重定向、压缩、超大 POST | 危险文件确认流、多下载限流、站点权限、CSP sandbox iframe |
| `node scripts/web-test.mjs`（线上冒烟） | 真实站点不产生误下 | 覆盖不全，且需要外网 |
| 手工 | 上面浏览器策略类项目 | 不进 CI，写进测试计划即可 |

**门禁**：`node scripts/check.mjs` 串起 validate + 四个单元测试 + 夹具全量。**push 之前必须全绿**（见 AGENTS.md）。
`.githooks/pre-push` 就是这条门禁的本地执行器，需维护者自己启用一次：`git config core.hooksPath .githooks`（仓库内脚本不改 git 配置）。本机 PATH 无 node 时先 `export OPENNDM_NODE=<node.exe>`。
`--no-fixtures` 只用于确实没有浏览器的环境，此时**捕获行为未被验证**，不能作为发布依据。

---

## 7. 发布与 CI（已落地：[.github/workflows/release.yml](.github/workflows/release.yml)）

- 触发方式：**手动**（`workflow_dispatch`），不在每次 push 时发布；勾 `dry_run` 只跑门禁与打包，产物进 Actions 制品库，不发 Release。
- 顺序：定位 Chrome → 读 manifest 版本 → `node scripts/check.mjs` → `scripts/package.mjs` 出 zip → 解包该 zip 后用 Chrome `--pack-extension --pack-extension-key` 出 crx（保证 crx 与 zip 内容一致）→ 上传制品 → `gh release create v<version>`。
- **门禁不过就没有产物、也没有 Release**：夹具双向断言（该抓的一条不能少、不该抓的一条不能多）即「不会下载预期以外的文件」的判据。
- **版本号即发布标签**：`manifest.json` 的 `version` 是唯一事实来源，`package.json` 必须一致（`validate.mjs` 校验），Release tag 为 `v` + 该值；Release 已存在时改为 `gh release upload --clobber`。
- crx 需要仓库 secret **`CRX_PRIVATE_KEY`**（PEM 原文或其 base64，支持两种写法）；缺省时跳过 crx 并在 Release 正文注明。生成方式：
  `openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out private.pem`
- **crx 扩展 ID 由这把私钥唯一决定**：换 key 等于换扩展，私钥不可入库、不可随意轮换。
- 服务端强制：若要把门禁变成 push 的硬约束，在分支保护里要求 `Release` 工作流的门禁作业通过；默认只做本地 hook + 手动发布。

