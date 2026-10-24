# 手机酒馆 + 订阅网关管理器

> **一句话回忆：这是“把 SillyTavern 装在安卓手机本机，套成手机应用，再用另一个应用管理 GPT／Claude／Antigravity 登录和模型”的那个项目。**
>
> 英文仓库名：SillyTavern Android Manager。

## 这个项目当时是为了解决什么？

想在手机上直接打开酒馆聊天，而不是每次找浏览器地址；后台也在手机自己的 Linux 容器里运行，不必一直开着电脑。还希望电脑或其他设备通过 Wi-Fi／Tailscale 访问同一份酒馆，并且订阅登录过期时能在手机界面重新登录，不用再进终端折腾。

所以这里做的不是新的聊天模型，也不是酒馆本体，而是围绕现有 SillyTavern 和 CLIProxyAPI 做的 **两个安卓入口 + 一个本机管理后端 + 部署与构建脚本**。

## 手机上哪两个应用？各自干什么？

| 应用／组件 | 你什么时候打开它 | 它负责什么 |
| --- | --- | --- |
| **SillyTavern／酒馆** 安卓应用 | 想聊天、用角色卡、世界书或酒馆插件时 | 把手机本机酒馆网页装进原生 WebView 壳；聊天仍由 SillyTavern 处理 |
| **订阅管理** 安卓应用（S+） | 要重新登录、换账号、换默认模型、找网关密钥时 | 中文管理界面，管理网关中的 GPT／Claude／Antigravity 账号与模型 |
| **CLIProxyAPI 网关** | 平时不需要单独打开 | 后台连接相应服务，把它们接成酒馆可调用的 OpenAI 兼容接口 |
| **Linux 容器中的服务** | 排查后台未启动时 | 真正运行酒馆、网关和管理后端；安卓壳本身不包含这些服务 |

**记忆法：聊天开“酒馆”，账号和密钥开“订阅管理”。**

## 以后回来，日常怎么用？

1. **正常聊天**：打开手机的“酒馆”应用。
2. **GPT 登录过期／加账号**：打开“订阅管理” → GPT 卡片 → 设备码登录 → 官方网页完成登录 → 返回应用确认。
3. **Claude／Antigravity 重新登录**：在各自卡片打开官方浏览器授权；需要时在应用里提交最终回调链接。
4. **换默认模型**：“订阅管理” → 模型与酒馆 → 选择模型 → 设为酒馆默认 → 重开酒馆。模型名前缀 `codex/`、`pro/`、`agy/` 用来区分来源。
5. **给酒馆插件填网关参数**：“订阅管理” → 网关密钥 → 复制 **API 密钥**。由手机酒馆后端转发时，基础 URL 是 `http://127.0.0.1:8317/v1`。**管理密码不是插件 API 密钥。**
6. **电脑访问同一个酒馆**：用手机当时的 Wi-Fi 或 Tailscale 地址加 `:8000`；只开放酒馆，账号管理端保持本机访问。真实设备地址不写进公开仓库。

这份清单用于回忆已经部署好的系统；如果是新手机或新环境，先按下方安装步骤准备后台与两个应用。

## 容易记混的地方

- **这个仓库是源码存档，不是手机完整备份。** 这里能找回安卓壳、管理代码、构建／部署方式；找不回私人聊天、角色、账号登录和原安装签名。
- **这里不是某个绘图或数据库插件的仓库。** 魔女画匣、数据库等是另装的酒馆扩展，本仓库没有打包它们；这里只提供它们运行所依赖的酒馆入口和可选网关管理。
- **“订阅接入”不等于模型在手机离线运行。** 手机运行的是酒馆与代理服务，模型回复仍依赖上游网络和账号权限。
- **不是装一个 APK 就全套就绪。** 两个 APK 是入口，还需要手机 Linux 容器中的后台服务。
- **局域网能连通但返回 403，先查酒馆白名单。** Tailscale 网络、系统防火墙、酒馆白名单是不同层，排查方法见下方“局域网与 Tailscale”。

## 要改东西，先看哪里？

| 想做的事 | 入口 |
| --- | --- |
| 改订阅管理页面或按钮 | [manager/public](manager/public/) |
| 改账号、OAuth、模型与服务管理逻辑 | [manager/server.mjs](manager/server.mjs) |
| 改 GPT 设备码登录适配 | [manager/device-login.mjs](manager/device-login.mjs) |
| 重建手机上的两个应用 | [安卓构建说明](android/README.md) |
| 换机／重新部署管理后端 | [管理服务安装脚本](scripts/install-manager.sh)及本文下方安装步骤 |
| 查哪些数据应保持私有 | [凭据与本机访问说明](docs/SECURITY.md) |

**这是源码工程，不含任何人的账号、令牌、聊天记录、实际部署地址或签名证书。** 本项目不分发 SillyTavern、CLIProxyAPI、Android SDK 或模型权重；它们需要分别安装。

---

以下是功能明细、架构和重新部署文档。

## 能做什么

- **酒馆安卓壳**：连接同一手机 `http://127.0.0.1:8000/`，支持系统文件选择器、导出保存、返回导航及键盘／系统栏适配。
- **订阅管理安卓壳**：连接 `http://127.0.0.1:8318/`，私有配置自动建立管理会话，无需每次输入管理密码。
- **三渠道账号管理**：ChatGPT / Codex、Claude、Antigravity 的重新登录／添加账号、状态查看、刷新凭据、暂停／启用、移除本机登录。
- **GPT 设备码登录**：卡片中查看和复制设备码，在系统浏览器完成登录后返回应用自动检测；另保留浏览器 OAuth 与手工回调。
- **模型管理**：按 `codex/`、`pro/`、`agy/` 区分来源，更新目录、搜索、设为酒馆默认；保存时校验当前接口并备份设置。
- **维护**：重启固定的网关／酒馆服务、导出不含凭据的诊断。
- **密钥面板**：仅在用户主动确认后查看／复制网关 API 密钥或管理密码，30 秒或切后台清空明文显示；不显示提供商 OAuth 令牌。

不显示未经核实的实时剩余额度。模型目录中的条目也不代表相应模型当前一定可调用。订阅权限、模型可用性、限额、第三方工具规则与计费以提供商为准；订阅登录不等于开发者平台 API 余额。

## 架构

```text
手机酒馆应用 / 同网浏览器
             │
             ▼
SillyTavern :8000 ───► CLIProxyAPI 127.0.0.1:8317
                              │
                              ├─ Codex
                              ├─ Claude
                              └─ Antigravity
                              ▲
订阅管理 Android ──► 本机管理服务 127.0.0.1:8318
                    （认证会话、白名单操作、无通用命令执行接口）
```

所有 `127.0.0.1` 都指运行相关进程的设备本身。电脑浏览器直接访问自己的 localhost 并不会访问手机。

## 目录

```text
android/                  两个独立安卓应用源码与构建脚本
manager/server.mjs        Node.js 本机管理后端
manager/device-login.mjs  Codex CLI 设备码进程适配
manager/public/           中文管理前端
manager/server.test.mjs   不使用真实账号的隔离契约测试
scripts/                  安装、安卓配置置入与隐私检查
examples/                 只有占位符的配置模板
```

## 前置条件与边界

- Android 8+（API 26），可用的 Android System WebView；目标 API 35。
- 手机上已有 Linux 容器／chroot（例如 Droidspaces Debian），可运行 Node.js **24+**、systemd、Linux ARM64 CLIProxyAPI。
- 已安装并独立启动 SillyTavern。最初集成基线：SillyTavern **1.19.0**、CLIProxyAPI **8.0.41**；未来版本可能变更管理 API 或授权输出，需复测。
- Windows 构建环境见 [安卓构建说明](android/README.md)。
- 安装脚本和服务管理需要容器 root；首次向安卓应用私有目录置入配置需要 Android root。**安卓应用本身不执行 root、不会自动授权账号。** 普通无 root Android 尚未实现一键安装整个堆栈。
- 本项目默认读写酒馆 `default-user` 设置。多用户／密码登录的酒馆部署需要额外适配认证，不能把默认方案当成任意用户管理器。

## 1. 准备上游服务

分别按照 [SillyTavern](https://github.com/SillyTavern/SillyTavern) 和 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 文档安装。

约定默认目录：

```text
/opt/SillyTavern
/opt/st-subscription-proxy/cli-proxy-api
/opt/st-subscription-proxy/config.yaml
/opt/st-subscription-proxy/auth/
/opt/st-subscription-proxy/local-access.json
```

网关的 systemd 服务名约定为 `st-subscription-proxy.service`，酒馆为 `sillytavern.service`。后台重启按钮只操作这两个固定服务名。

参考 [网关配置模板](examples/gateway.example.yaml) 配置回环监听、客户端密钥和管理密钥。复制 [本机凭据结构模板](examples/local-access.example.json) 到私有运行目录，替换两个 `REPLACE_...` 字段，确保与网关实际配置相同。建议使用密码管理器或系统随机源生成彼此不同的随机值。权限设为 `0600`，上层目录不对其他用户开放。

**不要把实际配置放在源码仓库，尤其不要提交 `config.yaml`、`local-access.json` 或 `auth/`。**

## 2. 安装本机管理服务

在 Linux 容器内、项目根目录执行：

```sh
# 默认目录且 Node 已在 PATH 中
sudo bash scripts/install-manager.sh

# 自定义安装位置；路径不支持空格
sudo env NODE_BIN=/opt/node/bin/node \
  GATEWAY_ROOT=/opt/st-subscription-proxy \
  TAVERN_ROOT=/opt/SillyTavern \
  bash scripts/install-manager.sh
```

脚本只部署本项目管理服务，不覆盖网关账号或密钥；首次生成单独的应用访问密钥，存为私有 `manager/manager-access.json`。升级时保留该文件，既有代码先备份到运行目录。生产代码使用 Node 内置模块，无需 `npm install`。

启动后验证：

```sh
systemctl is-active st-subscription-manager.service
systemctl is-enabled st-subscription-manager.service
curl -i http://127.0.0.1:8318/
# 未认证请求应返回 HTTP 401，而不是公开面板
```

## 3. 构建与安装 Android 应用

见 [android/README.md](android/README.md)。只发布源码，不附带原设备签名或已签名 APK。首次构建会生成你自己的本地签名；**没有原安装证书时，不能用新证书直接覆盖原设备上的同包名应用。** 请保留自己的签名材料，迁移前备份相关应用私有配置。

安装 `com.yg.subscriptionmanager` 后先启动一次，随后将该手机管理服务生成的私有配置置入安卓应用：

```sh
# 在 Android root shell 执行。CONTAINER_PID 要按当前运行容器实际 PID 替换。
sh /data/local/tmp/provision-android.sh \
  /proc/CONTAINER_PID/root/opt/st-subscription-proxy/manager/manager-access.json
```

[置入脚本](scripts/provision-android.sh) 只在手机内部复制，不打印密钥，并修正 UID、0600 权限与 SELinux 标签。脚本需要预先通过 ADB 等方式放进手机。重开订阅管理应用后自动建立 HttpOnly 会话；应用／源码中不硬编码真实秘密。

## 4. 配置酒馆

在酒馆 API 页面：

1. API 类型选 **聊天补全**。
2. 来源选 **自定义 OpenAI 兼容**。
3. 基础 URL 填 `http://127.0.0.1:8317/v1`，不添加 `/chat/completions`。
4. 密钥填网关 **API 密钥**，不是管理密码，也不是 OAuth token。
5. 登录账号并刷新模型，选择对应来源的模型。

订阅管理的“设为酒馆默认”只允许当前正在使用本机自定义网关的酒馆，不会悄悄覆盖其他连接。切换后重开酒馆，避免旧页面自动保存把设置覆盖回来。

## 5. 重新登录与管理

- **Codex**：设备码登录 → 复制卡片设备码 → 官方浏览器页面登录 → 返回原生订阅管理。设备码会过期，取消或超时会终止对应 CLI 进程。
- **Claude / Antigravity**：打开浏览器 OAuth → 完成后返回应用。若最终 loopback 页面打不开，可在本机卡片粘贴完整回调 URL；它只提交给本机并校验当前 state。不要分享回调 URL。
- 新授权可能创建新的本机记录；重复项由用户主动暂停／移除，不自动删号。**移除登录不等于取消付费订阅。**
- 凭据刷新不等于刷新额度；连接测试会先确认且消耗少量额度，不自动切换上游来源。
- 密钥查看／复制仅通过已认证会话与显式确认 POST，响应 `no-store`；前端不存入 localStorage，不放入诊断或最近操作。剪贴板寿命由操作系统管理。

## 局域网与 Tailscale

只有酒馆前端按需求对外开放；网关 `8317` 和管理服务 `8318` 保持回环监听。

访问酒馆使用 `http://PHONE_LAN_IP:8000/` 或 `http://PHONE_TAILSCALE_IP:8000/`，设置酒馆 `listen: true`、IPv4 监听与明确的客户端 IP／CIDR 白名单。优先放行具体可信设备或受控子网，不直接关闭全部访问控制。Tailscale 连得通但 HTTP 403 时，检查酒馆应用层白名单；Tailscale ACL、系统防火墙与应用白名单是不同层。

在真实共享网络中启用酒馆认证与适当的 TLS／网络访问控制，否则可达设备可能共享聊天数据与模型额度。本项目不自动开放 CGNAT 整段，也不替用户修改 Tailscale ACL。

## 开发与测试

```sh
npm run check
npm test
npm run privacy:check
```

测试使用随机临时端口与虚构提供商，不读取真实账号，禁用真实 systemd 与设备码登录进程。覆盖会话认证、跨站请求、账号状态、错误保存响应、OAuth state／并发、密钥查看确认和诊断脱敏。实际 OAuth 与安卓交互需要你自己的手机人工验收。

## 隐私与发布原则

本仓库为白名单整理的全新源码快照，**不包含原工作区 Git 历史**。

不发布：
- 账号邮箱、私人主机名、设备序列号、真实局域网／Tailscale 地址；
- API／管理／应用密钥、OAuth 文件、cookie、设备码或回调 URL；
- 聊天、角色与设置备份、手机截图、UI dump、原始日志、真实验收 JSON；
- 签名证书、签名密码、APK、打包输出、上游源码或依赖缓存。

`.gitignore` 是辅助，不替代审查。发布前运行隐私扫描并检查 `git diff --cached`、`git ls-files`；扫描不保证发现所有语义隐私。若误提交过密钥，单纯删除当前文件不足以清理 Git 历史，应立即轮换并处理历史。

## 已知限制

- Android 壳依赖本机 Linux 服务，不是内嵌 Node 或模型的一体化 APK。
- 账号刷新与配额信息取决于上游；不提供通用实时余额。
- 暴露管理密钥意味着完整网关管理能力，只允许本机用户主动查看。
- 酒馆设置 API 没有原子 compare-and-swap；已做队列、冲突检测、备份和回读，但多端同时编辑仍应避免。
- 多用户、非 systemd、其他端口或复杂路径需要按源码约定适配。
- 测试基线不承诺未来版本的 OAuth 页面、CLI 输出、模型目录不变。

## 上游与许可

本工程不重新分发上游产品。SillyTavern、CLIProxyAPI、Android SDK、各模型与服务商各自适用其许可证／条款。本源码的说明见 [NOTICE.md](NOTICE.md)；未附带第三方图片、个人签名或运行数据。
