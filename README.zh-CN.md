# Yamakawa Code 使用指南（中文）

一个 Claude Code 风格的 VS Code 侧边栏聊天插件，可对接任意 OpenAI 兼容接口。

> 英文版说明请见 [README.md](README.md)。

---

## ✨ 功能特性

- 侧边栏聊天面板，UI 极度贴近 Claude Code 风格
- 流式响应 + 平滑的打字机效果
- 内置轻量 Markdown 渲染（代码块、列表、标题、链接、强调等）
- 工作区级别的对话历史持久化
- 一键 **清除历史**（视图标题栏垃圾桶图标）
- 中断生成（流式输出过程中显示 **Stop** 按钮）
- 自定义 Base URL、模型、System Prompt、Temperature
- 支持替换为 `.svg` / `.png` / `.jpg` / `.jpeg` 图标

---

## 🚀 快速开始

### 0. 一键自动配置（推荐给新同事/新设备）

克隆仓库后，直接执行一条命令即可完成依赖安装与编译：

```bash
python3 scripts/bootstrap_project.py
```

或：

```bash
npm run bootstrap
```

### 1. 安装依赖并编译

```bash
cd "yamakawa code"
npm install
npm run compile
```

### 2. 在 VS Code 中运行

- 用 VS Code 打开本项目根目录
- 按 `F5` 启动 **Extension Development Host**（一个新的 VS Code 窗口）
- 在新窗口的活动栏（左侧竖排图标栏）会出现 **Yamakawa Code** 图标，点击打开聊天面板

### 3. 配置 API Key

按以下任意一种方式提供 API Key（优先级从高到低）：

| 顺序 | 来源 | 说明 |
| --- | --- | --- |
| 1 | VS Code 设置 `yamakawaCode.apiKey` | 在 Settings 中搜索 *Yamakawa Code* 填入 |
| 2 | 对应供应商的环境变量（见下） | 终端 `export XXX=...` 后重启 VS Code |

各 provider 读取的环境变量：

| Provider | 环境变量（按顺序回退） |
| --- | --- |
| `openai` | `OPENAI_API_KEY` → `OHMYGPT_API_KEY` |
| `anthropic` | `ANTHROPIC_API_KEY` → `CLAUDE_API_KEY` |
| `gemini` | `GEMINI_API_KEY` → `GOOGLE_API_KEY` → `GOOGLE_GENERATIVE_AI_API_KEY` |
| `ollama` | 不需要（本地） |

> ⚠️ 在 macOS 上，从 Dock 启动的 VS Code 可能读不到 shell 的环境变量。最稳妥的做法是直接在 **设置** 里填，或从终端执行 `code .` 启动 VS Code。

---

## 🌐 多 Provider 支持

通过 `yamakawaCode.provider` 切换后端，`baseUrl` 留空会自动使用对应默认值：

| Provider | 默认 baseUrl | 适用 |
| --- | --- | --- |
| `openai` | `https://apic1.ohmycdn.com/v1` | OpenAI / OhMyGPT / DeepSeek / Moonshot (Kimi) / Groq / OpenRouter / xAI / Together / Azure OpenAI 等所有 OpenAI 兼容接口 |
| `anthropic` | `https://api.anthropic.com` | Claude 官方 API |
| `gemini` | `https://generativelanguage.googleapis.com` | Google Gemini |
| `ollama` | `http://localhost:11434` | 本地模型（无需 API Key） |

切换示例：
- **Claude 官方**：provider = `anthropic`，model = `claude-sonnet-4-20250514`，apiKey 填 `sk-ant-...`
- **DeepSeek**：provider = `openai`，baseUrl = `https://api.deepseek.com/v1`，model = `deepseek-chat`
- **Gemini**：provider = `gemini`，model = `gemini-2.5-flash`，apiKey 填 Google AI Studio 的 key
- **本地 Ollama**：provider = `ollama`，model = `llama3.1`（或任何已 `ollama pull` 的模型）

---

## ⚙️ 配置项

在 **Settings → Extensions → Yamakawa Code** 中可调整：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `yamakawaCode.provider` | `openai` | 后端类型：`openai` / `anthropic` / `gemini` / `ollama` |
| `yamakawaCode.baseUrl` | （空，按 provider 自动） | 接口基础 URL；留空走对应默认 |
| `yamakawaCode.model` | `gpt-5.2` | 默认模型 |
| `yamakawaCode.apiKey` | （空） | API Key；留空时回落到环境变量 |
| `yamakawaCode.systemPrompt` | 内置专业 Pair-Programmer 提示词 | 每轮对话的系统提示词 |
| `yamakawaCode.temperature` | `0.7` | 采样温度（0~2） |
| `yamakawaCode.theme.accent` | `#c96442` | 主色（暖珊瑚） |
| `yamakawaCode.theme.background` `.foreground` `.muted` `.border` | （空） | 各色覆盖；空则跟随 VS Code |
| `yamakawaCode.theme.fontFamily` | （空）| UI 字体（Styrene 风的无衬线） |
| `yamakawaCode.theme.fontSerif` | （空）| AI 回复正文衬线字体（Tiempos 风） |
| `yamakawaCode.theme.fontMono` | （空）| 代码块等宽字体 |

---

## 💬 使用技巧

- **回车**：发送消息
- **Shift + 回车**：换行
- 流式输出过程中，发送按钮会变为红色的 **Stop** 按钮 — 可随时打断
- 视图标题栏右上角的 🗑 图标会清空当前工作区的对话历史

---

## 🖼 替换插件图标（支持 `.svg` / `.png` / `.jpg` / `.jpeg`）

`media/` 目录下放任意一张图片即可被识别，命名必须以 `icon.` 开头：

```
media/icon.svg
media/icon.png
media/icon.jpg
media/icon.jpeg
```

**两个生效位置：**

1. **侧边栏聊天面板内的 Logo**（顶部圆角图块）：插件运行时会**自动**按 `jpg → jpeg → png → svg` 的优先级在 `media/` 目录里挑选第一张存在的图片，不需要任何额外配置，重新打开聊天面板即可看到。
2. **活动栏（左侧图标栏）的入口图标**：这里 VS Code 只读 `package.json` 中声明的路径，所以更换文件类型后需要跑一行命令同步：

```bash
npm run set-icon
```

该脚本会自动扫描 `media/` 目录，并把 `package.json` 中 `viewsContainers.activitybar`、`views`、以及插件市场图标（仅当图片为 `.png/.jpg/.jpeg` 时）的 `icon` 字段更新为最新文件。改完后重新加载窗口（命令面板 → *Developer: Reload Window*）即可。

当检测到 `icon.jpg` / `icon.jpeg` / `icon.png` 时，脚本会自动生成 `media/icon.auto.svg` 作为备用文件；但左侧活动栏图标会优先固定使用 `media/icon.svg`（单色 SVG），避免出现“黑块/黑团”显示问题。

### 📌 关于活动栏图标的小贴士

- VS Code 活动栏 **推荐** 单色 SVG（会根据主题自动着色，效果最一致）
- `.png` / `.jpg` / `.jpeg` **可以显示**，但会保持原始颜色，不会被主题染色，建议尺寸 `48×48` 或 `64×64`，背景透明
- 如果你想要"主题感"，建议导出 SVG；如果想用品牌彩色 Logo，PNG 更合适

---

## 🧪 开发与调试

```bash
# 监听文件并自动重编译
npm run watch
```

VS Code 中按 `F5` 后会启动调试宿主；修改源码后在调试窗口里执行 *Developer: Reload Window* 即可重载。

### 项目结构

```
yamakawa code/
├── media/                # Webview 静态资源（CSS / JS / 图标）
│   ├── icon.svg          # 当前生效的图标（可替换为 png/jpg/jpeg）
│   ├── main.css
│   └── main.js
├── scripts/
│   ├── set-icon.mjs              # 自动同步 package.json 图标路径
│   ├── bootstrap_project.py      # 一键初始化（安装依赖 + 编译）
│   ├── update_github.py          # 安全提交并推送到 GitHub
│   └── publish_extension.py      # 一键打包/发布 VS Code 插件
├── src/
│   ├── extension.ts      # 扩展激活入口
│   ├── ChatWebviewProvider.ts  # 侧边栏 Webview 实现
│   └── api.ts            # OpenAI 兼容 SSE 流式客户端
├── package.json
└── tsconfig.json
```

---

## ❓ 常见问题

**Q：发送后提示 “No API key found”？**
A：检查设置 `yamakawaCode.apiKey`，或在启动 VS Code 的终端里 `export OPENAI_API_KEY=...` 后用 `code .` 重新打开。

**Q：模型回复 404 / 401？**
A：先核对 `baseUrl` 是否正确（不要带 `/chat/completions`），再确认你的 Key 与该 Base URL 属于同一服务商。

**Q：换了 PNG 图标但活动栏没变？**
A：跑一下 `npm run set-icon`，再执行 *Developer: Reload Window*。

**Q：清除历史是按工作区独立的吗？**
A：是的，历史保存在 `workspaceState` 中，不同工作区互不影响。

---

## 📦 打包发布（可选）

推荐直接使用项目内置发布命令：

```bash
export VSCE_PAT=your_marketplace_pat
npm run release:patch
```

也可以用 Python 发布脚本：

```bash
python3 scripts/publish_extension.py --bump patch
```

仅打包检查（不发布）：

```bash
npm run release:check
```

如果你只想推送代码到 GitHub（不是发布插件）：

```bash
python3 scripts/update_github.py -m "chore: update"
```

底层 `vsce` 命令方式：

```bash
npm install -g @vscode/vsce
vsce package
```

会生成 `yamakawa-code-x.y.z.vsix`，可在 VS Code 中通过 *Extensions: Install from VSIX...* 安装。
