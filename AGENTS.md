# AGENTS.md — OpenNDM-Extension

Manifest V3 浏览器扩展，把用户真正想要的下载交给本机 Neat Download Manager（NDM）。
本文件是开发约定（供 AI 代理与维护者遵守）；实现细节、`decideCapture()` 规则表、NDM 协议字段见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 硬性约束

- **无构建、无运行时依赖**：不引入打包器，不 `npm install` 任何运行时依赖；仓库根目录本身就是可加载的扩展。
- **数据不出本机**：只与 `127.0.0.1` 通信；不新增任何外部上报/统计/云端功能。
- **捕获判定唯一入口**：所有自动捕获必须经过 `src/lib/rules.js` 的 `decideCapture()`；新增规则改这里，不要在别处旁路。
- **宁可漏拦，不可误下**：拿不准就不接管；媒体（`kind: media/hls`）只进面板，绝不自动发送。
- **不代理请求、不改响应体**；**不要向 NDM 发送响应 `Content-Disposition`**（会导致 416 / 命名错误）。
- 内存中的过期表统一走 `pruneExpiring(map, limit)`，新增缓存表必须设上限。
- 源码注释保持中英双语。

## 改动后的验证顺序

每修改一次，按序验证，全部通过才算完成：

1. `node scripts/validate.mjs` — 清单、i18n、版本一致性。
2. 逐个跑单元测试（本项目零 npm 依赖，直接跑文件即可）：
   - `node tests/background.test.mjs`
   - `node tests/rules.test.mjs`
   - `node tests/capture.test.mjs`
   - `node tests/package.test.mjs`
3. 涉及捕获行为的改动：补/改 `tests/rules.test.mjs` 或 `tests/capture.test.mjs` 用例（用假 `chrome.*` 与 `FakeWebSocket`，无浏览器）。
4. `node scripts/web-test.mjs --fixtures`（本地夹具，可选但优先于站点冒烟）：需要本机有 Chrome/Edge，**不需要外网**；逐场景双向断言（该抓的一条不能少，不该抓的一条不能多）。
5. `node scripts/web-test.mjs`（线上站点冒烟，可选）：需要浏览器与网络；有捕获即失败。日常改动不强制。

**打包（`node scripts/package.mjs`）只在明确要求发布时执行，不在每次修改时运行。**

## 版本号

- 每次修改递增 `manifest.json` 的 `version` 第三位，并同步 `package.json`（validate 会校验一致）。
- 第三位满 10 进位到第二位：`0.2.9 → 0.3.0`，不出现 `0.1.11` 这类版本。

## 本地化

- 任何用户可见文案必须同时写入 `_locales/en/messages.json` 与 `_locales/zh_CN/messages.json`，键名一致；代码里用 `t('key')`。

## 环境（Windows / Git Bash）

- 本机 PATH 中**没有**全局 node/npm（旧 DeepSeek harness 已卸载，其 Electron 运行时不可用）。
- 可用 node：`C:\Users\ZZB001\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`（v24，Git Bash 路径 `/c/Users/ZZB001/AppData/Local/Programs/DeepSeek Harness/...`）。
- 项目零依赖，所有脚本用上述 node.exe 直接运行即可；若该路径失效，重新定位本机 node 后更新本节。

## 其它

- 界面与文档默认中文；git 提交信息风格参照 `git log`（现有为英文简短句）。
- 调试方法、拒绝原因含义、已知取舍见 DEVELOPMENT.md 第 5、15、16 节。
