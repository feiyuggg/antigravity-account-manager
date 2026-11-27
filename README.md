# Antigravity Account Manager

基于**环境变量隔离**与 **`agy acp` 官方认证流程**的 macOS Google Antigravity 账号切换管理工具。

## 核心特性

- **一账号一隔离环境**：每个账号拥有独立的 `HOME` 与 `ANTIGRAVITY_HOME` 目录，切换账号无需反复重新登录。
- **独占 `agy acp` 登录流程**：点击「添加账号」或「重新登录」时直接唤起 `agy acp` 触发浏览器 OAuth 授权，不读取系统 Keychain、不解析 token、不调用任何额度或配额查询接口。
- **自动识别邮箱 & 默认名防重**：通过 `agy` / Antigravity 独立配置文件探测已登录邮箱并自动回填；重名时自动生成唯一目录名称。
- **保留历史会话与已安装插件**：在主目录与各账号隔离环境间智能链接/同步历史会话、插件与 MCP 配置。
- **自定义启动参数与附加进程**：支持配置 Antigravity 启动参数，以及切换后自动重启的关联 CLI / 插件进程（例如 `cli.js watch --relaunch` 等）。
- **版本升级数据无缝迁移**：从本地 `npm run dev` 模式升级到打包后的 `.app` 时，首次启动自动迁移已有 `profiles.json` 配置。

## 从源码运行与构建

```bash
npm install
npm run typecheck
npm test
npm run dev
```

### 打包 macOS Release（Apple Silicon arm64）

```bash
npm run release:macos
```

生成产物位于 `release/`：
- `Antigravity Account Manager.app`
- `Antigravity-Account-Manager-1.0.0-macOS-arm64.dmg`
- `Antigravity-Account-Manager-1.0.0-macOS-arm64.zip`
- `SHA256SUMS.txt`

## 首次安装提示（macOS Ad-hoc 签名）

当前 v1.0.0 Release 使用本地 ad-hoc 签名，未经过 Apple Developer 公证。若首次打开 `.app` 时系统提示「无法验证开发者」或「已损坏」，请在拖入 `/Applications` 后执行：

```bash
xattr -cr "/Applications/Antigravity Account Manager.app"
```

或在「系统设置 -> 隐私与安全性」中点击「仍要打开」。

## License

[MIT](./LICENSE)
