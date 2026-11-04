# PortDeck · 本机端口总览台

AI 在后台起了一堆 dev server，窗口关了、对话找不到，端口却一直占着。PortDeck 把这些端口收成一张表：**用途、启动目录、访问链接、进程信息**一目了然，点一下就能关掉。macOS 和 Linux 都能跑。

## 安装

```bash
npm install -g portdeck
portdeck
```

不安装也可以直接跑：

```bash
npx portdeck
```

没有 npm 的 Linux 机器，用 bash 脚本装（只依赖 curl 和 Node ≥ 18）：

```bash
curl -fsSL https://raw.githubusercontent.com/vaclock/portdeck/main/install.sh | bash
# 会自动把 ~/.local/bin 写进 zsh / bash 的启动文件；不想改就加 --no-path
# 卸载：bash install.sh --uninstall（会一并清掉写进去的那段 PATH）
```

浏览器会自动打开 <http://127.0.0.1:7799>。没有任何第三方依赖，Node ≥ 18。

从源码运行就是 `node server.js`（或 `npm start`）。如果 7799 已经有一份在跑，重复启动会直接打开已有的那个页面，不会起第二个实例。

## 命令行

不想开浏览器时，同一套扫描/分类/备注逻辑也能在终端里用：

```bash
portdeck --list            # 打印端口表格（默认隐藏系统服务）
portdeck --list --all      # 连同系统 / 工具常驻服务一起列出
portdeck --json            # 输出 JSON，便于脚本处理
portdeck --kill 3000       # 关闭占用 3000 的进程
portdeck --kill 5000 --force   # 确认要关系统服务时才加 --force
portdeck --port 7800       # 指定网页看板端口
portdeck --no-open         # 启动后不自动打开浏览器
```

`--kill` 复用网页端同一套保护规则：不关别人的进程、不关自己的祖先进程、默认不关系统/IDE 常驻服务。

## 界面能做什么

| 能力 | 说明 |
| --- | --- |
| 端口列表 | 扫描本机所有 TCP 监听端口，按「开发服务 → 应用 → 本工具 → 系统」排序 |
| 用途 | 自动从页面标题 / 框架 / 进程推断；点一下可改成自己的备注，写进 `~/.portdeck/notes.json`，重启不丢 |
| 启动目录 | 取进程真实 cwd 并向上找项目根（`package.json` / `.git` / `pyproject.toml` 等），点目录名用 Finder / 文件管理器打开 |
| 访问链接 | 自动探测 `http://localhost:PORT` 的可达性与页面标题，点链接直接开浏览器 |
| 资源占用 | CPU 与内存（RSS）分两列右对齐展示，统计整个进程树（含 esbuild 等子进程）；顶部还有全部开发服务的内存合计 |
| 排序 | 点「端口 / CPU / 内存」表头排序，再点一次切换升降序；选择记在 localStorage，刷新与自动更新都会保持 |
| 单个关闭 | 「关闭」→ 确认弹窗（带命令目录）→ SIGTERM，3 秒没退再 SIGKILL |
| 批量关闭 | 「关闭全部开发服务」一次收掉所有 dev 端口 |
| 防误杀 | 系统 / GUI 常驻服务（ControlCenter、Ollama、Figma 等）标记为「锁定」，不参与批量关闭 |

系统服务默认折叠（表格底部的「N 个系统服务已折叠 · 展开」可点开，或勾选工具栏「显示系统服务」）；搜索时会跨全部分类查找。

## 判定规则

进程分成四类，避免把 IDE 自己的服务当成 dev server 杀掉：

- **开发**：命令行里出现 `vite` / `next` / `uvicorn` / `http.server` / `npm run` / `--port` 等特征，或 cwd 落在有项目标记文件的目录里
- **应用**：其余属于当前用户、且不是系统路径的进程
- **系统**：`/System`、`/usr/libexec`、`/Applications`、`*.app/Contents`（但 `Python.app` 这类开发运行时除外），以及编辑器 / AI 工具写在 `~/.xxx` 下的工作区进程（`~/.nvm` 等运行时目录除外）
- **本工具**：PortDeck 自身及其它实例

另外，PortDeck 自己的祖先进程（启动它的 shell / AI / IDE 宿主）一律锁定——防止「一键关闭」把正在跟你对话的进程也关了。

## 安全边界

- 只监听 `127.0.0.1`，不对外网暴露
- 写操作要求自定义请求头 `x-portdeck-request`，并校验 `Origin`，避免任意网页用表单 POST 打到本地端口
- 只允许结束「当前用户」的进程；`pid` 必须是当下确实监听该端口的进程，防止 PID 复用误杀
- 系统 / 工具常驻服务默认拒绝关闭，CLI 需要显式加 `--force` 才会动手

## 数据

`~/.portdeck/notes.json` 只存端口备注，删掉即恢复自动推断。想换个位置就设环境变量 `PORTDECK_DATA_DIR`。

## 已知限制

- 支持 macOS 与 Linux。macOS 用 `lsof` + `ps`；Linux 优先读 `/proc`，没有 `lsof` 时自动退回 `ss -tlnp`（精简镜像请装 `lsof` 或 `iproute2`）。Windows 未验证。
- CLI 的 CPU 只有一次采样，显示的是 `ps` 的生命周期平均值；网页端因为每 5 秒轮询，能看到两次采样之间的实时值。
- 扫的是**本机**端口。若 AI 在远端容器 / 沙箱里起服务，需要在那个环境里跑这份工具。
- 被 `npm run dev` 的 watcher 拉起的服务，关闭后可能被父进程重新拉起——工具会整组结束（进程组 + 子进程），但若 watcher 在上层 shell 里，仍可能重启。
- 端口探测只发一次 GET `/`，非 HTTP 协议（gRPC、TCP 自定义协议）会显示「非 HTTP 或未响应」，链接仍会列出。
- CPU 不是 `ps` 那个「生命周期平均值」（对空闲服务永远是 0），而是**两次刷新之间的 CPU 时间差分**，所以：
  - 页面刚打开的第一屏会显示 `live=false` 的平均值，5 秒后自动变成实时值；
  - 数值反映的是最近约 5 秒的平均占用，不是毫秒级瞬时峰值。
- 内存是 RSS（实际驻留），不含 swap / 共享内存分摊，和「活动监视器」的数字会有出入。
