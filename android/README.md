# Android 双应用壳

两个独立的原生 Java/WebView 工程，无 Gradle、无第三方 Java 依赖。这里只提供应用壳；服务端须先在 Android 设备本机运行，应用不会启动终端或申请 root。

- [tavern](<tavern/AndroidManifest.xml>)：包名 `com.yg.sillytavern`，连接设备本机回环端口 8000，支持系统文件选择器及导出。
- [manager](<manager/AndroidManifest.xml>)：包名 `com.yg.subscriptionmanager`，连接设备本机回环端口 8318，启动时读取应用私有目录中的 `manager-config.json`。
- [通用构建脚本](<build.ps1>)：通过 `-ProjectPath` 指定工程；两个工程各有轻量入口。

源码中的回环地址仅表示安装设备自身，并非远程主机。网络配置默认禁止明文通信，仅为回环地址例外。两个 Manifest 均显式设置 `allowBackup=false`、`debuggable=false`。OAuth 仅经允许的公共服务域名交给系统浏览器；发布内容不含账号、应用密钥、用户配置或原签名。

## 准备工具链

在 Windows 使用 PowerShell 5.1+（或 PowerShell 7）、完整 JDK 17+、Android SDK Platform 35 或更新稳定版、Build-Tools 34.0.0 或更新稳定版。请自行安装这些工具；脚本不会下载 SDK、JDK 或依赖。

环境变量：

- `ANDROID_SDK_ROOT`：SDK 根目录；未设置时读取 `ANDROID_HOME`。
- `JAVA_HOME`：JDK 根目录；未设置时由 PATH 中的 `javac.exe` 定位同一 JDK 的 `bin` 目录，需要同时含 `java`、`javac`、`jar`、`keytool`。
- 可选 `ANDROID_SIGNING_PASSWORD`：本地签名密码。首次构建若未设置，则以加密随机数自动生成。密码不放入命令行参数或仓库。

环境变量值由使用者按实际安装位置配置，工程没有固定电脑路径。

## 验证与构建

以下命令从本目录执行；`-ExecutionPolicy Bypass` 仅作用于本次进程，以支持本地审阅过的未签名脚本，不更改系统持久策略。使用 PowerShell 7 时可将 `powershell` 换成 `pwsh`：

```powershell
# 只校验工具链及 Manifest；不编译、不生成签名、不生成输出
powershell -NoProfile -ExecutionPolicy Bypass -File ./tavern/build.ps1 -ValidateOnly
powershell -NoProfile -ExecutionPolicy Bypass -File ./manager/build.ps1 -ValidateOnly

# 构建、独立签名并验证 APK
powershell -NoProfile -ExecutionPolicy Bypass -File ./tavern/build.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File ./manager/build.ps1

# 可显式指定已安装工具版本
powershell -NoProfile -ExecutionPolicy Bypass -File ./build.ps1 -ProjectPath ./tavern -Platform android-35 -BuildToolsVersion 34.0.0
```

默认优先使用 Platform 35 和 Build-Tools 34.0.0；若相应版本未安装，则在 SDK 中选择较新的最新稳定版，不选择预览版。编译平台可更新，应用的最低/目标版本仍以各 Manifest 为准：最低 Android 8.0/API 26，目标 API 35。

构建顺序：`aapt2 compile/link` → `javac --release 11` → `d8 --min-api 26` → 打入 dex → `zipalign` → `apksigner` → 签名/对齐/包信息验证。每个工程输出本地 `out/app.apk` 与 `out/sha256.txt`，中间目录为 `gen`、`classes`、`out`。这些目录全部被忽略，构建日志可能包含本机工具路径，分享前应另行检查。

## 本地签名与升级

每个工程首次构建单独生成 `signing/app.jks` 与 `signing/password.env`，别名为 `app`，证书主体为 `CN=Local Android Apps, O=Local Android Apps`。环境文件只含本地密码键值，不被执行；后续默认读取它，也可通过 `ANDROID_SIGNING_PASSWORD` 提供匹配密码。两个工程各自生成随机密码和证书，不复用任何原私有构建证书。

`signing`、密码环境文件和所有构建产物均已加入 [忽略规则](<.gitignore>)。环境文件是明文的本地秘密：只保存在受限、可信目录，证书与密码须成对私密备份，勿提交或打进源码包。删除签名目录会产生新证书，既有安装将不再接受其更新。

保留 `com.yg.*` 包名是为了保持现有组件/跳转约定；**包名相同并不代表可直接更新**。仓库未附原签名，新生成 APK 不可无损覆盖原私有签名安装。请先通过各服务和系统文件选择器导出需要保留的数据；全新安装前确认数据备份，卸载会删除应用私有数据。后续使用同一份本地签名，并按需提升 Manifest 的 `versionCode`/`versionName`。

## 管理壳私有配置

部署端须把 UTF-8 JSON 写入管理壳应用的私有 files 目录，文件名为 `manager-config.json`：字段 `baseUrl` 必须等于源码中固定的本机管理服务地址；字段 `appKey` 是部署端为本地服务生成的非空可打印 ASCII 秘密。该配置不嵌入 APK、不放到公共存储，也不随源码发布。管理壳通过 `X-App-Key` 引导会话，配置异常时不显示密钥内容。

本仓库只含源码和通用工具，不含手机配置、服务数据、证书、密码、截图或预编译 APK。构建输出文件的哈希只用于核对该次产物；本地签名和 ZIP 时间戳等因素使不同机器的 APK 未必字节一致。
