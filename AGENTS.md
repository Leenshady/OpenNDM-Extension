# AGENTS.md — OpenNDM-Extension

Manifest V3 浏览器扩展，把用户真正想要的下载交给本机 Neat Download Manager（NDM）。
本文件是开发约定（供 AI 代理与维护者遵守）；实现细节、`decideCapture()` 规则表、NDM 协议字段见 [DEVELOPMENT.md](DEVELOPMENT.md)。
标准与规则的逐条对应及差距清单见 [DOWNLOAD-STANDARDS.md](DOWNLOAD-STANDARDS.md)；后续开发计划、能力上限与永久不做清单见 [ROADMAP.md](ROADMAP.md)。

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

以上 1–4 可以用 `node scripts/check.mjs` 一次跑完（见下节，push 前必须全绿）。

**打包（`node scripts/package.mjs`）只在明确要求发布时执行，不在每次修改时运行。**

## 推送门禁（push 前必须全绿）

- `node scripts/check.mjs` 是唯一的门禁入口：validate → 四个单元测试 → `web-test.mjs --fixtures` 全量夹具，任一步失败即非零退出。
- **只有门禁全绿才允许 push**。夹具双向断言（该抓的一条不能少、不该抓的一条不能多）就是「不会下载预期以外的文件」的判据；跳过夹具的 `--no-fixtures` 只允许用于确实没有浏览器的环境，且必须在结论里说明未验证捕获行为。
- 仓库提供 `.githooks/pre-push`（内容就是跑 `scripts/check.mjs`）。**启用由维护者自己执行一次**：`git config core.hooksPath .githooks`；代理不得改 git 配置。本机 PATH 无 node 时先 `export OPENNDM_NODE=<node.exe 路径>`。
- 发布走 `.github/workflows/release.yml`（手动触发）：先跑同一门禁，再打 zip/crx 并按 manifest 版本发 Release；门禁不过不会产出发布物。

## 版本号

- 每次修改递增 `manifest.json` 的 `version` 第三位，并同步 `package.json`（validate 会校验一致）。
- 第三位满 10 进位到第二位：`0.2.9 → 0.3.0`，不出现 `0.1.11` 这类版本。

## 本地化

- 任何用户可见文案必须同时写入 `_locales/en/messages.json` 与 `_locales/zh_CN/messages.json`，键名一致；代码里用 `t('key')`。

## 环境（Windows / Git Bash）

- 本机 PATH 中**没有**全局 node/npm。
- 实测可用 node（2026-11-02 校验，v24.21.0）：`C:\Users\ZZB001\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`，Git Bash 路径 `/c/Users/ZZB001/AppData/Local/Programs/DeepSeek Harness/...`。
- Qoder 本体装在 `D:\Program Files\Qoder`，其安装目录**没有独立的 node.exe**（只有 Electron 原生模块），别去那里找。
- 项目零依赖，所有脚本用上述 node.exe 直接运行即可；若该路径失效，先 `find` 重新定位本机 node，再更新本节。

## 其它

- 界面与文档默认中文；git 提交信息风格参照 `git log`（现有为英文简短句）。
- 调试方法、拒绝原因含义、已知取舍见 DEVELOPMENT.md 第 5、15、16 节。
- **改捕获分支前先读 [DOWNLOAD-STANDARDS.md](DOWNLOAD-STANDARDS.md)**：下载相关标准（RFC 9110/6266/8187/2047、`<a download>` 同源限制、fetch+blob、Range/206、`Sec-Fetch-*`、MV3 能力）与现有规则的逐条对应、以及差距清单 G1–G12 的状态都在那里；新增或修改分支时要同步更新该文的第 8、9 节。
- **不要扩大接管范围**：新需求先查 [ROADMAP.md](ROADMAP.md) 第 1 节（能力上限）与第 2 节（永久不做黑名单）；撞上黑名单的诉求一律拒绝，不做「加个开关绕过」的方案。
