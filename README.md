# SSAI 长截图工具

**v.1.0.0** · 一个本地运行的长截图小工具，支持截图拼接、隐私打码、裁剪、水印和 PNG/JPEG 导出。不需要账号，不上传截图。

- [下载安装包](https://github.com/eddylu93/ssai-longshot/releases/tag/v1.0.0)
- [反馈问题](https://github.com/eddylu93/ssai-longshot/issues)
- 作者微信：**sanshengya88**

## 功能

- 导入 PNG/JPEG 后自动识别重叠并拼成长图。
- 框选屏幕区域，保留常驻边框，手动滚动后停止采集并自动拼接。
- 同次采集支持向上、向下和反向滚动；不确定的接缝会提醒检查，可调整顺序或重叠后重算。
- 点击图片预览，滚轮缩放、拖动平移，再次点击退出。
- 时间、昵称、头像一键隐私打码，支持群聊昵称；可手动矩形、涂抹打码并撤销。
- 裁剪、文字水印、图片水印；水印支持平铺、密度、透明度和随机排列。
- 默认小窗口，展开后使用右侧编辑栏；小窗编辑栏在底部，不覆盖图片。
- 导出长图 PNG/JPEG 到下载文件夹，作者页脚不写入导出图片。

## 下载与平台

当前 Release 提供 **macOS Apple Silicon（arm64）DMG**。这是本机临时签名构建，**未经过 Apple 开发者签名和公证**，macOS 可能提示无法验证开发者。请自行评估来源与安全性。

Intel Mac、Windows 暂未提供经过实机验收的安装包；跨平台源码不等于已验证所有平台。

## 使用

1. 导入已有截图，或者点击区域采集后拖出正文区域。
2. 采集时点击框外的开始按钮，在目标窗口手动滚动，结束后点击停止。
3. 检查拼接结果；需要时打开编辑设置，执行打码、裁剪或水印处理。
4. 点击导出。存在未确认接缝时先检查内容，再决定导出或重算。

首次区域采集需要在 macOS 系统设置的录屏权限中允许本工具，然后重新打开应用。临时签名在重新构建后可能变化，旧授权可能需要移除后重新添加当前应用；本仓库不会自动修改系统权限。

## 限制

- 当前使用主显示器，不提供自动滚屏。相邻截图必须包含共同内容，漏采的部分不能恢复。
- 动态图片、重复消息、悬浮菜单、固定侧栏和滚动过快可能导致无法可靠匹配；不要把未确认接缝当成正确结果。
- 自动打码是辅助功能，可能遗漏或误识别，分享前必须人工检查。macOS 文字识别使用本地 Vision，要求 macOS 12+；Windows OCR 尚未实现。
- 单轮采集最多 60 帧或 5 分钟，容量约 100 MB；导出画布上限 3200 万像素、高度 32760 像素。
- 未完成真实微信/飞书所有版本、主题、长时间负载或 Windows 全流程验收。

## 开发

需要 Node.js、pnpm、Rust/Cargo，以及目标平台的 Tauri 开发工具链。测试命令需要支持原生 TypeScript 类型擦除的 Node.js，本机验证版本为 v26.0.0。macOS 需要 Xcode Command Line Tools；Windows 需要 MSVC 构建工具与 WebView2。

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm tauri:dev
```

仅查看浏览器界面：

```bash
pnpm dev
```

访问 `http://127.0.0.1:1420/`。原生录屏、Vision OCR 和下载目录写入需要桌面版，不能用浏览器预览替代验收。

构建当前平台安装包：

```bash
pnpm tauri:build
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

macOS 本机构建产物：

```text
src-tauri/target/release/bundle/macos/SSAI 长截图工具.app
src-tauri/target/release/bundle/dmg/SSAI 长截图工具_1.0.0_aarch64.dmg
```

软件显示版本为 `v.1.0.0`，配置与 Git 标签使用 `1.0.0`、`v1.0.0`。为保持本机更新兼容，沿用已有应用标识；Rust 模块保留内部技术名称，不影响界面名称。

## 源码与隐私

仓库不包含用户截图、导出结果、录屏数据、内部验收文档、缓存或密钥。`src-tauri/native/fixtures/stitching` 中的两张测试图是程序渲染的纯合成消息，不是真实聊天记录，用于逐像素回归测试。

## 许可证

本项目原创代码采用 [MIT](LICENSE)。第三方代码沿用各自许可证，见 [第三方说明](public/THIRD_PARTY_NOTICES.txt)、`public/*-LICENSE.txt` 和 `src-tauri/vendor/*/LICENSE`。

欢迎使用SSAI 工具系列。
