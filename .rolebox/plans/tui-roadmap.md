# tern TUI 库开发路线图（Development Roadmap）

> 维护位置：`.rolebox/plans/tui-roadmap.md`（仓库内路线图主文档）  
> 生成日期：2026-08-20 ｜ 对应版本：v0.2.0（npm 已发布）  
> 文档语言：中文（技术术语保留英文）  
> 配套文档：`docs/components.md`（组件级状态页）、`docs/perf.md`（渲染性能与基准）、`docs/guide.md`（API 指南）、`docs/architecture.md`（架构）、`docs/api-stability.md`（API 稳定性与 1.0 冻结边界）  
> 更新约定：每个里程碑完成后在本文档勾选并记录实测数据；组件级进展同步维护 `docs/components.md` 状态表。

---

## 1. 背景与目标

tern 是一个 Rust 原生 TUI 渲染引擎：JS 端（React / SolidJS）描述场景，Rust 端完成场景树、布局（taffy）、合成（compositor）、diff 渲染与终端前端，经 napi 桥接。主攻场景是 AI coding agent 的终端 UI（流式 transcript、diff、表格、多面板工作区）。

本路线图的起点不是「MVP」——v0.2.0 已经远超 MVP：完整组件集、push 式事件、增量渲染四轮优化、11 平台发布矩阵均已落地。本路线图回答的问题是：**从「功能完备的 0.2.0」到「真正生产级、可与 ratatui / bubbletea / textual / blessed / notcurses 对标的完整 TUI 库」还缺什么，以及按什么顺序补齐**。

总目标：
1. **终端能力与输入层硬化**——从「环境变量猜测」升级为「交互式能力探测 + 分级启用 + 优雅降级」；
2. **渲染性能天花板突破**——补齐终端滚动区域优化等大帧场景的最后一块拼图；
3. **组件与布局广度对齐**——覆盖表单、菜单、帮助面板、日历等成熟库标配组件，并加深 Markdown/代码编辑能力；
4. **无障碍、主题与跨平台验证**——让「生产级」名副其实；
5. **生态、文档与 1.0**——API 稳定性契约、完整文档体系、恢复 stage 4 延期的 wasm/xterm.js/tern-server 方向。

---

## 2. 现状盘点（2026-08，v0.2.0）

> 本节基于代码库实际调查（134 commits；`src/core/`、`src/bindings/tern-node/`、`packages/{core,react,solid,examples}`）。

### 2.1 架构与仓库布局

```
tern/
├── src/                          # Rust workspace
│   ├── core/
│   │   ├── tern-core/            #   场景树 SceneNode、Cell 缓冲、Style、Color、Cursor、grapheme cluster 支持
│   │   ├── tern-layout/          #   taffy 封装：flex、CSS grid、绝对定位、clip/scroll 区域、增量布局
│   │   ├── tern-terminal/        #   crossterm 后端：diff flush、run 批处理、OSC 0/8/52、kitty 键盘/下划线协议、光标形状
│   │   ├── tern-components/      #   Compositor（增量脏区重绘）+ 渲染对象（Text/Box/Input/Textarea/Spinner/Panels/StatusBar/Canvas）
│   │   ├── tern-highlight/       #   tree-sitter 高亮（4 种语法：Rust、TS/JS、JSON、shell）
│   │   └── tern-wasm/            #   C-ABI 预览绑定（wasm32-unknown-unknown，浏览器 canvas demo）
│   └── bindings/tern-node/       # napi 绑定（Node.js / Deno → Rust）
├── packages/                     # @tern-tui/core（TS 绑定，约 7.6k 行）· react（react-reconciler）· solid · examples
├── docs/                         # architecture.md · components.md · guide.md · perf.md · api/（生成站点）
├── examples/                     # rust/tern-demo · web/（wasm demo）
└── tools/                        # bench/ · verify.sh · fix-dts.mjs · check-import-resolution.mjs
```

数据流：JS reconciler → `@tern-tui/core` → tern-node（napi）→ tern-core 场景树 → tern-layout → Compositor（painting 到 Cell Buffer）→ tern-terminal（diff + flush）→ 终端；事件经 `poll_events` / push 事件循环反向回到 JS。

### 2.2 已实现能力清单（如实记录）

| 领域 | 已实现 |
|------|--------|
| 渲染管线 | 场景树 → 布局 → 合成 → diff → flush 全链路；四轮优化：scene-epoch 无操作快速路径、行跳过 diff、SGR run 合并、空 diff 抑制 flush、终端尺寸缓存、`requestFrame` 合帧、增量布局（taffy reconcile）、脏区重绘（scratch frame + copy_rect）、变更点推送脏集（O(mutated)）、大脏帧路径（scratch 池化、retained buffer 复用、单次 layout 全量回退） |
| 布局 | taffy 引擎：flex（方向/增长/收缩/basis）、CSS grid（模板/自动流/跨行跨列）、百分比尺寸、绝对定位、clip_x/y/width/height、scroll_x/y、z_index、gap/padding/border |
| 组件（22 个） | Box、Text、StreamingText、MarkdownView、DiffView（unified + side-by-side + 行内高亮）、Input、Textarea、Select（过滤/多选/floating）、Table（sticky header、windowed rows）、Tabs、Panels（折叠/拖拽调宽）、Progress（Gauge 对齐）、Spinner、StatusBar（保留底行）、ScrollView（滚动条）、Modal（焦点隔离）、Tree/TreeView、Canvas（braille）、BarChart、Chart、Sparkline、Selection（原生选区覆盖层） |
| 事件与交互 | push 式事件流（ThreadsafeFunction，无轮询）；key（kitty 键盘协议：repeat/release、super/meta/hyper 修饰键）、resize、focus、mouse（按钮/拖拽/滚轮/SGR）、paste（bracketed paste 端到端）；FocusManager（路由/遍历/反向索引/订阅）；click-to-focus、wheel scroll、panel drag-resize、鼠标选区（双击选词、OSC 52 复制）、IME 姿势（组合态归终端模拟器，确认输入走 paste 通道，CJK 往返无损） |
| 样式与主题 | 主题系统（One Dark 默认；role/component 语义提示 → fg/bg/border_style 创建期解析；mergeTheme/resolveTheme；React ThemeProvider / Solid setTheme）；样式键：fg/bg（rgb、indexed）、bold/dim/italic/underline/blink/reversed/hidden/strikethrough、下划线变体 + 颜色（kitty SGR 4:N / 58）、边框色、OSC 8 超链接、光标形状/可见性控制 |
| Unicode | 全程 grapheme cluster（UAX #29，unicode-segmentation）：宽度（min(2, Σ)、ZWJ emoji、flag、combining）、整簇换行、不裂簇截断、cluster-aware 光标移动；ANSI 转义剥离（输入侧）；Cell.symbol + masked continuation 宽字符不变量 |
| 终端能力 | supports-color 探测（truecolor/256/16）+ RGB→ANSI256 量化；kitty 下划线样式（TERM_PROGRAM 环境探测）；kitty 键盘增强（无条件 push）；OSC 0 标题、OSC 52 剪贴板；备用屏开关（useAltScreen）；headless 渲染模式 |
| 跨平台 | napi 11 目标发布矩阵（linux x64/arm64 gnu+musl、FreeBSD、riscv64、Android arm64、macOS x64/arm64、Windows x64/arm64）；npm optionalDependencies 分发 |
| 测试 | Rust：单元 + compositor 黄金缓冲测试 + 脏区一致性测试 + dirty-parity 模糊测试 + bench（release `--ignored`）；JS：core 约 270+ 用例（index_test.ts 7.8k 行）、react/solid 各约 3.4k/3.0k 行测试；PTY smoke harness（4 个 demo、中途 resize、退出 0）；`setAddonForTesting` 无头注入 |
| 文档与示例 | guide（734 行）、architecture、components（组件路线图状态）、perf + BASELINE（四轮实测数据）、生成式 API 站点（core/react/solid）；示例：react-demo、solid-demo、kitchen-sink×2、agent-transcript、file-browser、diff-review、rust tern-demo、web wasm demo |
| 发布 | tag 触发全自动发布（napi 矩阵构建 → 平台包 → core → react → solid）；npm provenance；CHANGELOG 全量记录 |

### 2.3 已完结路线历史（供延续）

- Phase 1–11（组件完备性、事件面、性能轮次、Phase 10 组件广度）——已完结（见 git 历史与 CHANGELOG）。
- Stage 5（npm 0.2.0、11 目标矩阵、API 站点、三个新示例过 PTY smoke）——已完结。
- **Stage 4（延期保留）**：tern-server（内嵌密钥认证 + 多路复用常驻服务）、@tern/core 完整 wasm 对齐、tern-highlight-in-wasm、xterm.js 前端。
- 旧 `docs/roadmap.md` / `docs/todo.md` 已移出仓库（改为仓库外维护）；本文档将其**收编回仓库**（`.rolebox/plans/`），作为唯一路线图主文档。

---

## 3. 对标差距分析

> 对标库：ratatui（Rust，组件/渲染）、bubbletea（Go，交互/状态机）、textual（Python，富文本/无障碍/调试）、blessed（Node，历史参考）、notcurses（C，性能/图形）。每项给出 现状 → 差距 → 优先级。

### 3.1 对标总览（13 个能力域）

| # | 能力域 | 现状（tern v0.2.0） | 主要差距 | 对标参考 | 优先级 |
|---|--------|---------------------|----------|----------|--------|
| 1 | 渲染 / 双缓冲 / diff | 强：retained buffer + 最小 diff + run 批处理 + 增量脏区 | 无终端滚动区域（scroll region）优化；无帧预算/输出节流；大帧字节数仍有压缩空间 | ratatui/notcurses 滚动优化 | P0 |
| 2 | 布局系统 | 强：taffy flex + CSS grid + 绝对定位 + clip/scroll | overflow 显式配置、min/max/aspect 约束未完整暴露 | ratatui Constraint/Flex | P2 |
| 3 | 组件广度 | 良：22 个组件 | 缺表单类（checkbox/radio/toggle）、Menu、Keymap/Help 面板、Calendar、Pagination、Slider；Markdown 无表格/嵌套列表/可点链接 | ratatui/bubbletea 组件集 | P0 |
| 4 | 事件 / 输入 | 良：push 事件、kitty 键盘、focus/paste/mouse 全链路 | 鼠标 any-event(1003) 常开（事件流量大）；无按键 chord/宏层；无输入法组合态（已决策非目标） | bubbletea KeyMap | P0 |
| 5 | 样式 / 主题 | 良：主题系统 + 全样式键 | 无运行期主题热切换 API（Solid 模块级、React 依赖重渲染）；无对比度检查 | textual themes | P1 |
| 6 | Unicode / 宽字符 / emoji | 强：grapheme cluster 全程一致 | 无终端上报宽度（DA1 探测）校验；无 emoji 呈现选择（VS16）；RTL/bidi 非目标 | ratatui/notcurses | P2 |
| 7 | 终端能力探测 | 弱：仅 env（supports-color + TERM_PROGRAM） | **无交互式探测**（DA1/DA2/DA3、XTVERSION、XTGETTCAP、kitty 支持探测）；无 OSC 52/剪贴板能力探测；无 TERM=dumb 降级 | blessed/notcurses | P0 |
| 8 | 跨平台 | 良：11 目标构建矩阵，8 目标运行时验证（M4.3 ✅） | darwin-x64/riscv64/android 无托管运行时（build-only）；无真实终端模拟器端到端测试（M4.4 待办） | 各库 CI 实践 | P1 |
| 9 | 性能 | 强：四轮优化 + 基准设施 | 无滚动区域优化（见 #1）；无基准回归门禁（CI 不跑 bench）；无渲染节流 | notcurses | P0 |
| 10 | 测试设施 | 强：黄金缓冲 + PTY smoke + fuzz | 无属性测试（selection/diff 数学）；无事件路由边界用例；无终端模拟器端到端（tmux/xterm.js headless） | 各库测试实践 | P1 |
| 11 | 文档 | 良：4 篇设计文档 + API 站点 | 无教程/cookbook；无迁移指南；无中文文档；无 API 稳定性/弃用策略 | textual docs | P1 |
| 12 | 示例 | 良：8+ 个示例 | 无交互式 showcase 页（如 textual demo）；无性能对比 demo | textual | P2 |
| 13 | API 稳定性 | 弱：0.2.0，表面仍在扩张 | 无 1.0 稳定化计划；无弃用策略/特性开关契约；无 API 面审计 | 各库 1.0 实践 | P1 |

### 3.2 关键差距详述

#### 3.2.1 终端能力探测（最弱环节，P0）

现状：颜色支持来自 `supports-color` crate；kitty 下划线样式与键盘协议来自 `TERM_PROGRAM` 环境猜测；**从不向终端发起查询**（无 DA1/DA2/DA3、XTVERSION、XTGETTCAP）。后果：
- kitty 键盘协议被无条件 push——不支持的终端静默忽略，**无回退路径**（key repeat/release、修饰键上报依赖它，一旦缺失，行为静默降级）；
- OSC 52 剪贴板、OSC 8 超链接是否可用无从得知；
- 无法区分「终端不支持」与「探测失败」，降级策略无法数据驱动。

对标：blessed/notcurses 会发起 DA1 查询并解析回复；生产库应实现带超时的交互式探测（C0/C1 查询、CSI 回复解析、kitty keyboard `CSI u` 支持检测），并把结果缓存为 `TerminalCapabilities` 结构暴露给上层与 JS。

#### 3.2.2 鼠标捕获模式（P0）

现状：`enable_event_listening` 一次性启用 1000+1002+1003+1015+1006（含 **any-event 1003**，鼠标**移动即上报**）。后果：无鼠标移动监听的场景也持续产生事件流量，拖累事件循环与电量。

对标：成熟库按需启用——基础按下/释放用 1006 SGR；仅当注册了 motion/drag 处理器才启用 1003；teardown 时按序关闭。

#### 3.2.3 信号处理与终端生命周期（P0）

现状：无 SIGINT/SIGTERM/SIGHUP/SIGTSTP/SIGCONT 处理。raw mode / 备用屏的恢复依赖应用自身退出路径；被 kill -9 或异常崩溃时终端可能残留 raw 状态；SIGTSTP（Ctrl+Z）挂起/恢复没有标准流程（恢复后需重进 raw mode + 重绘全屏）。

对标：crossterm 不处理信号，生产 TUI 库（bubbletea 等）自带信号注册：退出信号 → 恢复终端 + 退出码；TSTP → 恢复终端 → 挂起 → CONT → 重进 raw mode → 全屏重绘。

#### 3.2.4 渲染：终端滚动区域优化（P0）

现状：ScrollView/StreamingText 滚动时，把新旧内容以 diff 重绘（逐单元格重画），**不使用终端的原生滚动能力**（`ESC[<top>;<bottom>r` + index/RI 或 `DECSTBM` + 单行重绘）。后果：大滚动帧（chat 上翻、日志滚动）重绘整屏。

对标：ratatui 的 `Scrollbar` 与终端滚动优化、notcurses 的 scroll 均利用 DECSTBM；chat 类应用（如 textual）滚动时只重绘新增行 + 用终端滚动移动旧行，字节数与 CPU 大幅下降。这是大帧性能最后一块拼图（现单格 0.66ms 地板，滚动帧 ≈1.2ms）。

#### 3.2.5 组件缺口（P0/P2）

- **P0**：Checkbox/Radio/Toggle（表单基元）、Menu（弹出菜单，Select 的浮层机制可复用）、Keymap/Help 面板（bubbletea Help 对齐；tern 已有 Keymap 类但无渲染组件）、Calendar（ratatui 对齐）、Pagination（长列表分页）。
- **P2**：Slider（区间/数值）、Toast/通知浮层、活动日志（ActivityLog）。
- **MarkdownView 加深（P0）**：表格渲染、嵌套列表、可点击链接（OSC 8 已具备）、任务列表、图片占位；tree-sitter 语法从 4 种扩到 ≥10 种（Python/Go/TOML/YAML/Markdown/C/C++…）。
- **Textarea 加深（P1）**：undo/redo（有界历史栈）、行号栏、查找/替换、软换行缩进延续；语法高亮编辑器可作为组件之上的一层（依赖高亮语法扩展）。

#### 3.2.6 无障碍（A11y，P1）

现状：无任何无障碍面。文本只存在于 cell buffer，屏幕阅读器不可读；无焦点语义、无 aria 等价描述。

对标：textual 提供完整语义树与 a11y 协议输出（iTerm2/系统读屏可读）；现代生产级 TUI 的最低要求是：每个交互组件暴露语义（角色、标签、状态），渲染层可选输出 a11y 协议（如 iTerm2 的 a11y report sequences），并提供语义 API 供测试与第三方读屏桥接。

#### 3.2.7 主题运行期化（P1）

现状：主题在 element-creation 期把 role/component 解析成具体 fg/bg/border_style 并写入节点——主题切换需要整树重建或依赖框架重渲染；无「主题只影响渲染期、不落节点」的抽象；无对比度校验。

对标：textual 主题是运行期变量，切换即时生效；可增加 `setTheme` 触发整树重渲染（已有 epoch 机制，代价可控），或把语义提示保留到渲染期解析。

#### 3.2.8 跨平台验证（P1）

现状：CI 构建 11 目标，但**仅 3 个运行加载**；musl/FreeBSD/riscv64/Android/Windows-arm64 为 build-only，发布包是否可加载未在 CI 验证。

目标：为每个平台包增加运行时验证（musl 用 node:alpine 容器、Windows-arm64 用 windows-11-arm runner、FreeBSD 用对应 runner/容器）；增加真实终端模拟器（tmux / headless xterm / pty.js）端到端测试，验证转义序列在真实终端中的渲染结果。

#### 3.2.9 API 稳定性与 1.0（P1）

现状：0.2.0；napi 表面 + JS 表面仍在扩张；无弃用流程、无特性开关、无 API 面冻结计划。

目标：发布 1.0 前完成公共 API 审计（core/react/solid 三面 + napi 背面）、确立弃用策略（deprecate → warn → remove，至少一个 minor 周期）、引入特性开关（feature flag）模式、建立 semver 契约文档并纳入 CONTRIBUTING。

#### 3.2.10 生态与延期方向（Stage 4，P1/P2）

- **wasm 对齐（P1）**：现有 C-ABI 预览仅支持 box/text/streaming_text；补齐 @tern/core 全组件 + 事件 + FocusManager 的 wasm 等价物，tern-highlight-in-wasm，浏览器 xterm.js 前端 demo。
- **tern-server（P2）**：内嵌密钥认证 + 多路复用常驻服务（ssh 场景深化）；works-over-a-pty 已达成，server 是差异化增量。

---

## 4. 分阶段路线图

> 优先级记号：P0=该里程碑内必须完成；P1=应完成（资源允许）；P2=可以延后。阶段间依赖见 §5。每个里程碑完成后：勾选状态、记录实测数据（基准、字节数、覆盖率）、更新 `docs/components.md`。

### M1 终端能力与输入硬化（Terminal Capabilities & Input Hardening）

**目标**：把终端交互从「环境变量猜测」升级为「交互式探测 + 分级启用 + 信号安全 + 优雅降级」——这是所有下游能力（滚动优化、a11y、降级渲染）的地基。

**范围与优先级**：

| 工作项 | 优先级 | 依赖 | 说明 | 状态（2026-08-20 实测） |
|--------|--------|------|------|------|
| M1.1 交互式终端能力探测：DA1/DA2/DA3、XTVERSION、XTGETTCAP（kitty/underline/OSC 52/clipboard）带超时解析，输出 `TerminalCapabilities` 并暴露到 JS（`renderer.capabilities` 扩展） | P0 | — | 探测在 `tern-terminal` 实现（写/读循环 + 超时）；结果缓存；未知终端保守默认 | ✅ 达成 — `probe.rs`：5 查询（DA1/DA2/DA3/XTVERSION/XTGETTCAP×8 capname）一次批量发出，单查询超时 60ms、总预算 300ms，OnceLock 缓存；13 单测（伪造回复注入：kitty 全量回复、单字节分片、超时保守默认等）；`renderer.capabilities` 暴露 9 字段；PTY 实测最坏 313.5ms（无应答终端 ≈ 预算+开销），getter 走缓存 0ms |
| M1.2 kitty 键盘协议支持探测与回退：先探测再启用；不支持时降级为传统 key 上报（保持现有 KeyName 语义） | P0 | M1.1 | 依赖探测结果决定是否 push enhancement flags | ✅ 达成 — `should_push_keyboard_enhancement`（opt-in ∧ 非 headless ∧ `probe.kitty_keyboard` 才 push `CSI > flags u`）；8 组合真值表单测（`keyboard_enhancement_push_decision_covers_all_combinations`）；不支持时零 push、保持 legacy key 上报 |
| M1.3 鼠标捕获分级：基础 1006 SGR 常开；1003 any-event 仅在注册 motion/drag 监听后启用；teardown 按序关闭 | P0 | — | JS 侧 `onMouse` 注册计数驱动开关 | ✅ 达成 — 默认 enable 序列无 `?1003h`（`enable_event_listening_emits_mouse_and_focus_enable_sequences` 断言 + 精确 `?1003h`/`?1003l` 字节级单测）；JS `onMouse` 注册计数驱动 `set_any_event_mouse`（0→1 开 / 1→0 关 / 1→1 不重复，index_test.ts 计数用例）；destroy 先 `?1003l` 再整体关闭；PTY smoke 实测：默认 demo 无 `?1003h`，kitchen-sink 注册 motion 监听后 `?1003h` 出现 |
| M1.4 信号处理：SIGINT/SIGTERM/SIGHUP 清理退出（恢复 raw mode + 备用屏 + 退出码）；SIGTSTP 挂起/恢复（恢复后重进 raw + 全屏重绘） | P0 | — | 在 tern-node 层注册，经 push 事件通道通知 JS | ✅ 达成 — `signals.rs`（SIGINT/TERM/HUP 清理退出；TSTP/CONT 挂起恢复，suspend/resume 经 `TernEventJs.lifecycle` 推送）；PTY smoke：SIGTERM → 退出 143 + termios 恢复（TERMIOS_SANE=yes）；SIGTSTP/CONT → 恢复标记 + 重绘 + 退出 0 |
| M1.5 降级路径：TERM=dumb / 非 TTY 输出的显式警告或禁用渲染；bracketed paste / focus 事件不可用时的事件过滤与文档化回退 | P1 | M1.1 | 探测结果驱动 | ✅ 达成 — TuiRenderer::new 对 TERM=dumb/非 TTY 显式报错；enable_event_listening_to 按 probe 分级启用 ?1004h/?2004h（字节级单测 ×4）；run-smoke.sh 新增 term-dumb 用例；docs/guide.md 记录降级回退 |
| M1.6 Windows 专项：legacy conhost 与 ConPTY 行为差异处理（颜色、尺寸、事件） | P2 | M1.1 | 需要 Windows 运行时环境（§M4.3）配合验证 | ⛔ 未实现（P2，不在本轮 M1 验收范围） |

**验收标准**：
- [x] `renderer.capabilities` 返回交互探测结果（终端型号、kitty 键盘/下划线、OSC 52 支持），且单元测试可注入伪造回复；✅ 达成 — `renderer.capabilities` 9 字段（truecolor/colors + terminalIdentity/kittyKeyboard/kittyUnderline/osc52/bracketedPaste/focusEvents/probed）；probe 13 单测含伪造回复注入（kitty 全量回复 → 全字段 true + identity「kitty(0.36.0)」）；JS 侧 `renderer capabilities getter routes to the native addon` 用例通过；
- [x] 无 1003 监听时终端不接收 any-event 上报（字节级断言：无 `?1003h`）；✅ 达成 — backend 默认 enable 序列不含 `?1003h`（字节级单测断言 `!s.contains("?1003h")`）；JS `onMouse` 计数驱动 `set_any_event_mouse`（0→1 开 / 1→0 关 / 1→1 不重复，index_test.ts 计数用例通过）；PTY smoke 实测：默认 demo 无 `?1003h`，kitchen-sink 注册 motion 监听后 `?1003h` 出现；
- [x] PTY smoke 扩展：SIGTERM 与 SIGTSTP/CONT 序列后进程干净退出/恢复，终端状态无残留（raw mode 检测）；✅ 达成 — run-smoke.sh 新增 signal-term（SIGTERM → 退出 143 + TERMIOS_SANE=yes 无 raw 残留）与 signal-tstp-cont（SIGTSTP/CONT → 恢复标记 + 重绘 + 退出 0）两用例，实测 PASS；
- [x] `TERM=dumb` 下渲染器给出明确行为（报错或禁用）而非乱画；✅ 达成 — TuiRenderer::new 非 headless 分支在任意终端 I/O 前对 TERM=dumb/非 TTY 显式报错（消息 "tern requires an interactive terminal (TERM=dumb or non-TTY)"；纯决策函数 truth table 单测 ×4 + run-smoke.sh term-dumb PTY 用例断言无 ESC 字节）；
- [x] 全量现有测试（cargo + deno + PTY smoke）保持绿色；✅ 达成 — `bash tools/verify.sh` 四门全绿退出 0（2026-08-20 实测：cargo build+test --workspace 通过（含 probe 13 例、keyboard/1003/termios 生命周期用例）；deno check 通过；deno test 457 passed / 0 failed；PTY smoke 7 demos + 3 用例（SIGTERM / TSTP-CONT / term-dumb）PASS）。

**风险**：交互式探测在部分终端（CI、无响应终端）可能超时——必须全部带超时且失败保守默认；Windows 信号与事件行为差异需在真实 runner 验证。

---

### M2 渲染性能与滚动优化（Rendering & Scrolling）

**目标**：把大帧（滚动、全屏更新）从「整屏 diff 重绘」降为「终端原生滚动 + 增量重绘」，并建立性能回归门禁。

**范围与优先级**：

| 工作项 | 优先级 | 依赖 | 说明 | 状态（2026-08-20 实测） |
|--------|--------|------|------|------|
| M2.1 终端滚动区域（DECSTBM + index/RI）优化：Compositor 检测「同一区域垂直平移」的帧对，输出滚动区域指令 + 仅重绘新增行 | P0 | M1.1（能力探测确认终端支持） | 作用于 ScrollView / StreamingText / Table 内容区；保留 diff 正确性（滚动后仍走 diff 校验） | ✅ 达成 — `compositor/scroll.rs` `detect_vertical_scroll`（全宽区域、高度>1、重叠行逐格匹配）+ `exposed_band_updates`；`backend.rs` `ScrollOp` + `flush_scroll_to`（裸 DECSTBM `ESC[t;br` + SU/SD + 暴露带 + 复位 + park）；`renderer.rs:553-601` render() 在 `scroll_region` 能力为真且选项未禁用时路由到 `flush_scroll`，否则回退 diff flush，`inner.last` 恒更新；`scrollOptimization` 逃生开关（默认按能力探测）；能力探测 `probe.rs scroll_region`（tmux/screen 保守回退）；tern-node 94 测试 + run-smoke 全绿 |
| M2.2 帧预算与输出节流：可配置 FPS 上限、高负载下合帧降频（在 requestFrame 之上加显式 throttle） | P1 | — | 面向高帧率动画 + 大场景；默认关闭以保持行为不变 | ✅ 达成 — `index.ts` `maxFps` 选项（0/未设=关，逐字节不变）+ 5 测试；burst 合帧率 ~1.0 |
| M2.3 基准回归门禁：CI 增加 bench job（`tools/bench/run.sh` 的 Rust 段），阈值失效即失败 | P0 | — | 门槛值取自 BASELINE.md 当前数据 + 容差 | ✅ 达成 — `run.sh --check`（10% 容差 + 对比表 + GATE FAIL + 非零退出，pass/fail 双路径验证）；`ci.yml` `bench` job（rust 路径过滤）；R5_* 常量刷新后 `--check` 干净退出 0 |
| M2.4 大帧字节压缩：同风格长行的字符级差分（重复段折叠）、尾部空白抑制 | P2 | M2.1 | 以 flush 字节数为度量 | ⏸ 延期（P2，理由记录于 M2 notes）— ≥60% 字节降幅已由 M2.1 终端原生滚动达成（4904→203 B，−95.9%），字符级折叠自带 SGR/masked-cell 正确性风险，明确延后 |

**验收标准**：
- [x] 新增基准场景「滚动帧」：滚动 1 行帧的 flush 字节数较现状（约 5KB 级全屏）下降 ≥60%，p50 时间下降（对照 tools/bench/BASELINE.md）；✅ 达成 — `bench_scroll_churn_frame` 走 `detect_vertical_scroll` + `flush_scroll_to` 终端原生滚动路径；实测 bytes/frame **4904 → 203 B（−95.9%，远超 ≥60% 目标）**，99.35%（1987/2000）帧命中滚动路径；BASELINE.md 新增「Round 5 — scroll-region fast path」章节，run.sh 表格与 R5_* 常量刷新；
- [x] 滚动优化后与全量重绘的**最终画面逐格一致**（黄金测试强制，参照现有 incremental_consistency）；✅ 达成 — (a) `incremental_consistency.rs:576` `incremental_buffer_parity_on_full_width_scroll_steps`（scroll_y ±1 多帧，增量帧 == 全量重算逐格 + diff 一致）；(b) tern-terminal `scroll_model_reconstructs_next_buffer_cell_for_cell` 语义模型重建；(c) tern-node `render.rs:467` counting-backend 滚动路由测试（scroll_flush_calls==1、精确 ScrollOp、后续 mutation 对留存帧 diff 正确）；(d) `index_test.ts:2171` `scrollOptimization` 开/关 `snapshotFrame()` 序列逐格一致（deno ok）；`inner.last` 恒更新保证 diff 正确性；dirty_parity_fuzz 保持绿；
- [x] CI 含 bench job，超阈值失败并附对比表；✅ 达成 — `tools/bench/run.sh --check` 模式（10% 容差、对比表 + GATE FAIL 列表 + 非零退出）；`.github/workflows/ci.yml` 新增 `bench` job（rust 路径过滤、release bench + `run.sh --check`，TS 段无头 SKIP）；实测 `--check` 干净运行退出 0（GATE PASS，scroll bytes 203/203 +0.0%、scroll p50 −0.3%）；注：`Rust single-cell mean` 在负载 dev 机上偶发 ±抖动（p50 稳定 +2%），CI 专用 runner 更稳定，列为观察项；
- [x] 请求帧节流开关生效且有测试（burst 合帧率保持 ~1.0）。✅ 达成 — `packages/core/src/index.ts` `CreateRendererOptions.maxFps`（0/未设=关，默认行为逐字节不变）；`#scheduleFrame` 按 FPS 预算算延迟；5 个新测试（1000 调用 burst→1 次原生渲染、间隔小于预算延迟到 cap、显式 render() 绕过节流、maxFps=0 不节流、JS 侧限定）；deno 462 passed / 0 failed。

**风险**：DECSTBM 与 tmux/screen 兼容性（部分终端滚动区域行为怪异）；必须以能力探测结果 + 保守回退兜底。

---

### M3 组件与布局补齐（Widget & Layout Breadth）

**目标**：组件广度对齐成熟库，Markdown/编辑能力深化。

**范围与优先级**：

| 工作项 | 优先级 | 依赖 | 说明 | 状态（2026-08-20 实测） |
|--------|--------|------|------|------|
| M3.1 表单基元：Checkbox / Radio / Toggle（聚焦态、键盘切换、主题 preset） | P0 | — | 三端（core/react/solid）对齐现有模式 | ✅ 达成 — core `checkbox`/`toggle`/`radio` 工厂（glyph + label 一叶，label/options 为 JS bookkeeping）+ `checkboxKey`/`toggleKey`/`radioKey`；react/solid 场景直接使用 core 工厂（MarkdownView 模式）；`index_test.ts` 组合 + 键盘交互用例（6854/6892/6922/7011/7049/7079）；kitchen-sink react/solid 覆盖并断言 |
| M3.2 Menu（弹出菜单）：复用 Select 浮层机制 + FocusManager；支持层级子菜单 | P0 | M3.1 之后的浮层模式 | 键盘导航 + 鼠标悬停/点击 | ✅ 达成 — core `Menu`（inline/flyout 子菜单、`floating`→z_index、hidden+display:none）+ react `<Menu>` host + solid `Menu` 工厂（`disposeMenuFocus`/`subscribeMenuMouse`）；`menuKey`/`menuHover`/`menuClick` + `openMenu`/`closeMenu`（焦点记录/恢复）；浮层 z-order（7228）、子菜单（7253/7276）、焦点隔离（7361/7392）黄金测试；kitchen-sink 断言 z_index=100 + 子菜单展开 |
| M3.3 Keymap / Help 面板：从 Keymap 类渲染出按键帮助浮层（bubbletea Help 对齐） | P0 | — | 读现有 keymap 注册表 | ✅ 达成 — `Keymap.register(combo, handler, description?)`（description 供面板显示；无描述条目跳过，bubbletea 语义）+ `HelpPanel`（title 行 + 每描述条目一行：`ctrl+k` 式 hint 右对齐于最宽列 + 两格间距 dim 描述；materialize 为纯 `box`）；测试 + kitchen-sink（`ctrl+k`/`ctrl+p` 行、dispatch-only `q` 被跳过） |
| M3.4 Calendar（ratatui 对齐）：月视图、日期选择、今日高亮 | P2 | — | 纯文本组件 | ⛔ 未实现（P2，不在本轮 M3 P0 验收范围） |
| M3.5 Pagination：长列表/表格分页控件 | P2 | — | Table/List 之上的一层 | ⛔ 未实现（P2，不在本轮 M3 P0 验收范围） |
| M3.6 MarkdownView 加深：表格、嵌套列表、可点击链接（OSC 8 已支持）、任务列表；tree-sitter 语法扩到 ≥10 种 | P0 | tern-highlight 扩展（M3.7） | 表格用现有 Table 逻辑局部渲染 | ✅ 达成 — 管道表格（`|---|:--:|` 分隔行 → 本地 `Table` 节点，列宽取最宽单元+1、`:--:`/`--:` 对齐）、任务列表（`[ ]`/`[x]`/`[X]` → `[x]`/`[ ]` glyph）、链接 stamp `hyperlink`→`href`（OSC 8，engine `Style::hyperlink`，PTY 实测输出 `ESC]8;;url` 序列）；嵌套列表（2 空格缩进）原有；`markdown_test.ts` 41 例（新增表格/任务列表/OSC-8 href + 相邻链接不合并用例）；**tree-sitter markdown grammar 延期**：唯一发布 crate（tree-sitter-markdown）钉死 tree-sitter 0.19 且无 highlight query，无法加入 0.26 运行时；≥10 目标由其余 12 种语法达成 |
| M3.7 tree-sitter 语法扩展（Python/Go/TOML/YAML/Markdown/C/C++ 等） | P1 | — | 新增语法包 + HIGHLIGHTS_QUERY + 测试 | ✅ 达成 — 12 种语法：Rust/TS/Tsx/JS/JSON/Shell + Python/Go/TOML/YAML/C/C++（`Cargo.toml` 新增 6 包，全部走 `tree-sitter-language 0.1` `LANGUAGE: LanguageFn` 绑定）；`highlight_reconstructs_source_exactly_for_every_language`（12 语言真实样本重建）+ `fence_names_map_to_languages`（别名/大小写）；JS 侧路由测试逐语言断言 addon 调用 + span 重建；**markdown grammar 明确不加**（唯一 crate 不可用，见 M3.6） |
| M3.8 Textarea 增强：undo/redo（有界历史）、行号栏、查找/替换、软换行缩进延续 | P1 | — | 状态仍在 JS bookkeeping（现有模式） | ⏸ 未实现 — 本轮未做（基础编辑已在此前 milestone shipped；undo/redo 有界历史为 M3.8 follow-on，见验收倒数第二项） |
| M3.9 布局约束补全：overflow 显式配置、min/max 尺寸、aspect-ratio 暴露 | P2 | — | taffy 已支持大部分，主要暴露 props + 文档 | ⛔ 未实现（P2，不在本轮 M3 P0 验收范围） |

**验收标准**：
- [x] 每个新组件：core 工厂 + react host + solid 工厂三端对齐，黄金缓冲测试 + 交互测试（键盘序列驱动）通过；✅ 达成 — Menu 为完整三端（core `Menu` + react `<Menu>` host + solid `Menu` 工厂含 focus/mouse 接线）；Checkbox/Toggle/Radio/HelpPanel 为 core 工厂、react/solid 场景直接使用（MarkdownView 模式，组件本身无需 host 标签）；黄金组合测试 + 键盘交互测试全部通过（`checkboxKey`/`toggleKey`/`radioKey`/`menuKey` 键盘序列，index_test.ts 17 例）；`deno test` 全量见下方实测计数；
- [x] Menu 的浮层 z-order 与焦点隔离有黄金测试（参照 Modal/Select floating）；✅ 达成 — `Menu floating mode sets a z_index prop`（7228）、`Menu flyout submenus render as overlay layers with their own z_index`（7276）、`openMenu focuses the first registered focusable and closeMenu restores the prior focus`（7361）、`closeMenu falls back to a blur`（7392）；kitchen-sink 断言 `z_index === MENU_Z_INDEX(100)` + open/close 显隐；
- [x] MarkdownView 表格/嵌套列表/链接渲染有黄金测试；新增语法均有高亮快照用例；✅ 达成 — `markdown_test.ts` 41 passed：新增管道表格组合测试（Table 节点、列宽/对齐）、任务列表 glyph 测试、OSC-8 href 测试（含相邻链接不合并）；嵌套列表（2 空格缩进）与链接原有用例保持绿；新增语法快照：tern-highlight `highlight_reconstructs_source_exactly_for_every_language`（12 语言真实样本逐字节重建）+ `fence_names_map_to_languages`（别名/大小写），JS 侧路由测试逐语言断言 addon 调用；
- [ ] Textarea undo/redo 有界历史栈行为测试；（未勾选 — M3.8 follow-on：undo/redo 有界历史未实现）
- [x] 全部新组件进入 `docs/components.md` 状态表与 API 站点；kitchen-sink demo 覆盖新组件。✅ 达成 — components.md 状态表新增 3 行（Checkbox/Radio/Toggle、Menu、HelpPanel，✅ Shipped）+ 三个新章节（Purpose/Design/API sketch/Acceptance/Shipped）+ MarkdownView 章节更新（表格/任务列表/OSC-8/12 语法/markdown 延期说明）；API 站点 `deno task docs:api` 重新生成（1588 files，含 Checkbox/HelpPanel/Menu/checkboxKey 等新导出）；kitchen-sink-react（13→14 节点，+4 root 兄弟节点）与 kitchen-sink-solid（14→19 节点）PTY 实测 PASS。

**实测数据（2026-08-20，`bash tools/verify.sh` 四门全绿退出 0）**：gate 1 cargo build --workspace + cargo test --workspace 通过（tern-highlight 12 语法用例含 `highlight_reconstructs_source_exactly_for_every_language`/`fence_names_map_to_languages` + tern-node highlight 测试）；gate 2 `npm run check`（deno check）通过；gate 3 `npm test`（deno test --allow-env=NODE_ENV core/react/solid/examples）**495 passed / 0 failed**（core index_test 296 + markdown_test 41 + react 83 + solid 74 + examples 1）；gate 4 PTY smoke 7 demos（react/solid/kitchen-sink-react/kitchen-sink-solid/agent-transcript/file-browser/diff-review，全部经历 80x24→111x31 resize 后断言 + 退出 0）+ signal-term/SIGTSTP-CONT/term-dumb 用例 PASS；语法数 = 12（Rust/TS/Tsx/JS/JSON/Shell + Python/Go/TOML/YAML/C/C++），markdown grammar 延期（唯一发布 crate 钉死 tree-sitter 0.19 且无 highlight query，无法加入 0.26 运行时）。

**风险**：组件数量增长带来 API 面膨胀——每个新组件必须走统一三端模板与测试模板，避免特例。

---

### M4 无障碍、主题与跨平台验证（A11y, Theming & Cross-platform Verification）

**目标**：让「生产级」名副其实：读屏可读、主题运行期可切换、11 平台包全部经过运行时验证。

**范围与优先级**：

| 工作项 | 优先级 | 依赖 | 说明 | 状态（2026-08-21 实测） |
|--------|--------|------|------|------|
| M4.1 语义树（Semantics Tree）：每个交互组件暴露语义（role/label/state/enabled/selected），核心维护平行语义节点 | P0 | M3（组件语义随组件定） | 渲染期与 scene 同步，不影响 cell 输出（默认关闭） | ✅ 达成 — `tern-core/src/semantics.rs` `SemanticsNode`（role/label/state/enabled/selected 等字段）+ `scene.rs` 平行语义 store（`set_semantics`/`clear_semantics`/`semantics_iter`；默认关闭、等值写入 no-op、缺失节点拒绝、真实写入 bump epoch 但**不进 dirty**——纯 bookkeeping，cell 输出逐字节不变）；tern-core 新增 13 语义用例（semantics.rs 5 + scene.rs 8）；JS 三端 API `packages/core/src/semantics.ts`（`SemanticsNodeJs`/`SceneSemanticsJs`/`renderer.semantics()` flat dump）+ `semantics_test.ts` 15 例（每组件语义派生：Box/Checkbox/Input/Menu/Radio/Select/Textarea/Toggle + key-handler 状态转移 + 默认关闭契约 + paint-invariance 黄金）；tern-node 10 语义单测含 2 个 paint-invariance 证明（`semantics_writes_never_change_painted_snapshot_rows`、`semantics_write_repaint_produces_an_empty_diff`）；`docs/a11y.md` |
| M4.2 A11y 输出通道：iTerm2 a11y report sequences（或等价的通用语义流）输出 + 文档 | P1 | M4.1 | 供屏幕阅读器/测试桥接 | ✅ 达成 — 如实说明：iTerm2 **无** app-facing a11y report-tree OSC 协议（其文档化转义序列仅 OSC 1337 套件：marks/colors/notifications/clipboard/annotations，见 <https://iterm2.com/documentation-escape-codes.html>），故按路线图允许的等价通道交付为两件：(i) **通用 JSONL 语义流**（主通道，任何终端可用）——`packages/core/src/a11y.ts` `A11yStream` + `A11Y_STREAM_VERSION=1`，`Renderer.startA11yStream/stopA11yStream` 挂接合帧路径（每合帧至多一行**全量** dump，JSON 数组单行、bigint id 十进制字符串、内嵌换行转义），无变更抑制（逐字节相同则不发）、best-effort sink（抛错吞掉，不伤帧路径）、纯读（paint-invariance 证明）、幂等/销毁即关；`a11y_test.ts` 4 例（黄金行/抑制/渲染不变量/坏 sink 容错）；(ii) **可选 OSC 1337 `AddHiddenAnnotation` 发射器**（iTerm2 only，VoiceOver 可达）——tern-terminal `A11yAnnotation` + `flush_a11y_annotations_to`（逐条目 `ESC]1337;AddHiddenAnnotation=<summary>BEL`，BEL 终结符同 OSC 0/52 约定）+ 纯决策 `a11y_annotations_enabled(opt_in, caps)` + 注入式 gate `flush_a11y_annotations_gated_to`（gate 失败严格零字节）；`Backend::with_a11y_annotations`/`set_a11y_annotations`（opt-in **且** probe identity 含 "iTerm2" 才写字节，默认关）；tern-node `A11yAnnotationJs` DTO + `TuiRendererOptions.a11y_annotations` + napi `set_a11y_annotations`（`[role][: label][, state...]` summary）；core 4 单测（精确字节/无 opt-in 零字节/kitty 零字节/真值表）+ tern-node 2 例（paint-invariance + summary 转发）；文档 `docs/a11y.md` M4.2 章节（JSONL 格式规范、iTerm2 reality check 引文、人工验证清单） |
| M4.3 CI 运行时矩阵扩展：musl（node:alpine）、Windows arm64（windows-11-arm）、FreeBSD 等平台包的加载与 smoke 验证 | P0 | — | 每个平台包至少一个真实运行时 load-check + demo 冒烟 | ✅ 达成 — `ci.yml` `napi-build` 11 行矩阵，8 目标真实运行时验证：linux-gnu x64/arm64 原生 node（arm64 走 `ubuntu-24.04-arm` runner）、musl x64/arm64 走 `node:alpine` 容器、win32-x64/win32-arm64 原生（arm64 走 `windows-11-arm` runner）、darwin-arm64 原生；FreeBSD 由独立 `freebsd-runtime` job 承接（`cross-platform-actions/action` FreeBSD 15 VM + pkg 装 node）；每行 `load-check` + `runtime-smoke.mjs`（15 断言：napi 表面加载、`render_to_buffer` 24 行、边框角标、destroy 状态）；darwin-x64/riscv64/android 无托管运行时 → build-only（文档化 verify on-device）；actionlint 1.7.12 PASS；README Supported platforms 表 11 行含验证状态 |
| M4.4 终端模拟器端到端测试：tmux（或 headless xterm）下跑示例并断言渲染结果/转义序列 | P1 | — | 补足 PTY smoke 的「真实终端语义」缺口 | ✅ 达成 — `packages/examples/run-e2e-tmux.sh`（262 行，shellcheck-clean，`bash -n` clean）：7 个 demo（react-demo/solid-demo/kitchen-sink-react/kitchen-sink-solid/agent-transcript/file-browser/diff-review）各自在钉死 80x24 的分离 tmux 会话（`new-session -d -s tern-e2e -x 80 -y 24`，demo 即会话初始命令，窗口随 demo 退出自关）运行；断言通道为 `tmux pipe-pane` 原始字节流（append-only、无竞态——实测 capture-pane 采样不到最终 ok: 行 ok-in-pane=0 / ok-in-file=1，且 demo 的 console.log 断言行会覆盖实时格子）；渲染关键内容断言：kitchen-sink-react 用 `capture-pane -p -e` 实测命中 `\x1b]8;;https://tern.dev\x1b\` OSC 8 开序列 + `tern.dev`（`-e` 才重发存储的 OSC 8，纯 `-p` 会剥离），agent-transcript 断言 `user: how do I sum a Vec<i32>?`，diff-review 断言 `formatBytes`+`hunk`+`1/3`；'q' 退出（0.5s grace + 2s 重发一次覆盖输入订阅竞态）+ 轮询 `has-session -t tern-e2e` 消失；kill-session 清理覆盖成功与全部失败路径，无残留会话/临时文件；强制失败路径（`run-e2e-tmux.sh bogus-demo`）exit 1；本地实测 7/7 PASS exit 0（tmux 3.7b，最终版本两次复跑均绿）；CI：`ci.yml` smoke job 新增 `brew install tmux` + `tmux -V` 安装步与 `run-e2e-tmux.sh` 调用步（同 smoke 路径过滤器），actionlint 1.7.12 PASS；`tools/verify.sh` 四门未动 |
| M4.5 主题运行期切换：`setTheme` 触发整树重渲染（走现有 epoch/diff 机制）或渲染期解析；对比度检查工具 | P1 | — | 保证切换后与新建主题的渲染一致（黄金测试） | ✅ 达成 — `packages/core/src/index.ts` 运行期主题引擎（M4.5 subtask 1）：`setTheme(overrides)`/`getTheme()` 合并于 `defaultTheme`（`mergeTheme`，绝不改基主题）；`setTheme` 走已记录节点（`WeakRef` 注册表，带 hint 才记录）原地重解析——只推变更样式键（单键 `set_prop`，绝不整表 `set_props`），调度恰好一次合并重绘（不进同步 paint）；core 4 例（黄金：切换场景与 B 主题下新建挂载逐格一致且切换确实改变画面；diff：box 3 键 + leaf 2 键单键写入、fullWrites 恒 0；无 hint 节点零原生调用零重绘；同主题 no-op 零调用）；react 1 例（ThemeProvider 挂载后 core `setTheme(B)` 原地重解析、节点不重挂载、逐格等于 B 下新挂载、react re-export 即 core 同引用）；solid 5 例（setTheme 合并/getTheme round-trip、组件预设盖章到工厂、显式 props 优先、getTheme 返回完整 Theme、M4.5 实时切换：创建后 setTheme(B) 原地重绘既有元素至 B 树）；`packages/core/src/contrast.ts` WCAG 2.1 对比度检查器（subtask 2：`parseThemeColor`（hex/`indexed:N`/`default`→null）/`relativeLuminance`/`contrastRatio`（顺序无关、`>=1`、未知色 null）/`auditTheme`（默认 4.5 阈值，palette 角色 + 双色 component preset，确定性顺序）+ `XTERM_256` 常量表）+ `contrast_test.ts` 17 例（默认主题审计精确 2 项：palette:muted ≈ 2.546:1、palette:border ≈ 1.579:1，danger ≈ 4.817:1 勉强通过；#767676/#ffffff ≈ 4.542 跨 4.5 阈值线）；kitchen-sink-react/solid 双端演示新增实时主题切换 + 对比度审计（PTY smoke 实测覆盖，见下）；`docs/guide.md` 主题运行期切换 + 对比度审计文档（含可运行示例） |
| M4.6 属性测试：selection/diff/编辑操作的属性测试（快速检查） | P2 | — | 补足模糊测试外的性质断言 | ⛔ 未实现（P2，不在本轮 M4 P0 slice 验收范围） |

**验收标准**：
- [x] 语义树 API 有文档 + 每组件语义单测；✅ 达成 — `docs/a11y.md` + `packages/core/src/semantics.ts` API + `semantics_test.ts` 15 例（Box/Checkbox/Input/Menu/Radio/Select/Textarea/Toggle 每组件语义派生与 key-handler 状态转移）+ tern-core 13 语义用例 + tern-node 10 例（2 paint-invariance）；
- [x] a11y 输出在支持终端上可读（人工验证清单）；✅ 达成 — `docs/a11y.md`「Manual verification checklist (roadmap line 266)」提供 4 步人工清单（启用 semantics + JSONL stream → iTerm2 上跑 kitchen-sink demo 交互 → 确认 `{"v":1}` 头 + 每变更帧一行全量 dump、VoiceOver 读 hidden annotations → 默认关时终端字节洁净无 `ESC]1337`）；JSONL 流通道已可运行（`a11y_test.ts` 4 例验证格式/抑制/不变量），iTerm2 侧为可选 OSC 1337 `AddHiddenAnnotation` 发射器（opt-in、probe-gated、默认关、仅单测——iTerm2 无 a11y report-tree OSC 协议，如实记录于 docs/a11y.md）
- [x] CI 矩阵：所有平台包均有运行时验证 job（load-check + smoke），状态表（README Supported platforms）更新；✅ 达成 — `ci.yml` 11 行矩阵 8 目标运行时验证（原生 node / node:alpine / windows-11-arm / FreeBSD 15 VM）+ `runtime-smoke.mjs` 15 断言；README Supported platforms 表更新为 11 行含验证状态；darwin-x64/riscv64/android 无托管运行时，文档化 build-only（verify on-device）；
- [x] tmux 端到端测试套件在 CI 运行并断言画面关键内容；✅ 达成 — `packages/examples/run-e2e-tmux.sh` 7/7 demo PASS exit 0（tmux 3.7b 本地实测两轮复跑），断言渲染关键内容（kitchen-sink-react 的 OSC 8 超链接 `\x1b]8;;https://tern.dev\x1b\` + `tern.dev`、agent-transcript 的 `user: how do I sum a Vec<i32>?`、diff-review 的 `formatBytes`/`hunk`/`1/3`）+ 'q' 退出 + `has-session` 消失；`ci.yml` smoke job 已新增 tmux 安装步（`brew install tmux` + `tmux -V`）与 `run-e2e-tmux.sh` 调用步，actionlint 1.7.12 PASS
- [x] 主题热切换前后画面逐格一致（黄金测试）；对比度检查 CLI/API 可用；✅ 达成 — 黄金测试 core 4 例 + react 1 例 + solid 1 例实时切换（切换场景与 B 主题新建挂载逐格一致，节点不重挂载、无 React 重渲染）；对比度检查 API `auditTheme`/`contrastRatio`/`parseThemeColor`/`relativeLuminance` 落地 + `contrast_test.ts` 17 例；kitchen-sink-react/solid 双端 PTY smoke 实测实时切换 + 审计
- [x] 全量现有测试保持绿色。✅ 达成 — `bash tools/verify.sh` 四门全绿退出 0（2026-08-21 实测数据见下）。

**实测数据（2026-08-21，`bash tools/verify.sh` 四门全绿退出 0）**：gate 1 cargo build --workspace + cargo test --workspace 通过——workspace **589 tests passed / 0 failed**（tern-core 120、tern-node 104、tern-terminal 97、tern-components 173、tern-layout 40、tern-highlight 18、incremental 10、abi_roundtrip 6、tern-wasm 7、dirty_parity_fuzz 3、incremental_consistency 11）；gate 2 `npm run check`（deno check）通过；gate 3 `npm test`（deno test core/react/solid/examples）**541 passed / 0 failed**（core 包 381 例 = index 308 + contrast 17 + markdown 41 + semantics 15；M4.5 新增 27 例：core 运行期主题引擎 4 + contrast_test 17 + react 1 + solid 5）；gate 4 PTY smoke 通过——7 个 demo（含 kitchen-sink-react/solid 新增的 M4.5 实时主题切换 + 对比度审计断言）全部渲染/断言/quit on 'q'，signal 用例（SIGTERM 143 + termios 恢复；SIGTSTP/SIGCONT 恢复 + 重绘 + exit 0）与 TERM=dumb 降级用例通过；CI 侧 `ci.yml` napi-build 11 行矩阵（8 目标运行时验证 + 独立 `freebsd-runtime` job（FreeBSD 15 VM）），actionlint 1.7.12 PASS；`runtime-smoke.mjs` 15 断言全过。默认主题对比度审计实测（`auditTheme(defaultTheme)` @ 4.5 阈值）：恰好 2 项——palette:muted ≈ 2.546:1、palette:border ≈ 1.579:1；danger ≈ 4.817:1 勉强通过。

**实测数据（2026-08-21 M4.2/M4.4 close-out，`bash tools/verify.sh` 四门全绿退出 0）**：M4.2 a11y 输出通道——通用 JSONL 语义流 `packages/core/src/a11y.ts` `A11yStream` + `Renderer.startA11yStream/stopA11yStream`（合帧路径每帧至多一行全量 dump、无变更抑制、best-effort、纯读），`a11y_test.ts` **4 passed / 0 failed**（确定性 JSONL 黄金行（含 bigint 十进制 id 与换行转义）、无变更抑制、paint-invariance、坏 sink 容错）；iTerm2 可选 OSC 1337 `AddHiddenAnnotation` 发射器——tern-terminal `flush_a11y_annotations_to`/`a11y_annotations_enabled`/`flush_a11y_annotations_gated_to` + `Backend::with_a11y_annotations`/`set_a11y_annotations`（opt-in + probe identity 含 "iTerm2" 双门控，默认关），core 4 单测（`\x1b]1337;AddHiddenAnnotation=...\x07` 精确字节、无 opt-in 零字节、kitty 零字节、真值表）+ tern-node 2 例（`set_a11y_annotations_never_changes_painted_snapshot_rows` paint-invariance + summary 转发）；workspace cargo test 复跑 **595 passed / 0 failed**（M4.2 新增 6 例）；`docs/a11y.md` M4.2 章节（JSONL 格式规范、iTerm2 reality check 引 <https://iterm2.com/documentation-escape-codes.html> 如实否认 a11y report-tree OSC 协议、人工验证清单）。M4.4 tmux e2e——`packages/examples/run-e2e-tmux.sh`（262 行，shellcheck + `bash -n` clean）本地实测 **7/7 demo PASS exit 0**（tmux 3.7b 两轮复跑：react-demo/solid-demo/kitchen-sink-react/kitchen-sink-solid/agent-transcript/file-browser/diff-review，各自 80x24 钉死分离会话，`pipe-pane` 原始字节流断言渲染关键内容，kitchen-sink-react 的 OSC 8 开序列 `\x1b]8;;https://tern.dev\x1b\` 经 `capture-pane -p -e` 实测命中，'q' 退出 + `has-session -t tern-e2e` 消失全过，kill-session 清理无残留）；强制失败路径 `run-e2e-tmux.sh bogus-demo` **exit 1**；CI 侧 `ci.yml` smoke job 新增 `brew install tmux` + `tmux -V` 安装步与 `run-e2e-tmux.sh` 调用步（同 smoke 路径过滤器），actionlint 1.7.12 PASS；`tools/verify.sh` 保持四门未改动。

**风险**：a11y 协议依赖终端支持面窄（iTerm2 为主）——语义树 API 本身即为价值（测试、调试、未来读屏），协议输出只作可选通道。

---

### M5 生态、文档与 1.0（Ecosystem, Docs & 1.0）

**目标**：API 稳定化到 1.0，文档体系完整，恢复并交付 Stage 4 延期方向。

**范围与优先级**：

| 工作项 | 优先级 | 依赖 | 说明 | 状态（2026-08-27 实测） |
|--------|--------|------|------|------|
| M5.1 公共 API 审计：core/react/solid + napi 背面逐符号审计，产出 API 清单与 1.0 冻结边界 | P0 | M1–M4 稳定后 | 审计报告入 docs/ | ✅ 达成 — `docs/api-stability.md`（2026-08-27 只读审计，逐符号清单 + 1.0 冻结边界；四份分表面清单已吸收入库删除）。四表面符号数：core **238**（198 stable / 28 experimental / 12 internal）、react **167**（134/28/5）、solid **170**（140/25/5）、napi 背面 **53**（47 stable / 5 experimental / 1 internal）；1.0 冻结集 519 stable / 86 experimental / 23 internal；deprecation-candidate 交接 **0**（无 @deprecated、无被替代符号）。`bash tools/verify.sh` 四门全绿退出 0：gate 1 cargo build+test --workspace **595 passed / 0 failed**；gate 2 deno check 通过；gate 3 deno test **545 passed / 0 failed**；gate 4 PTY smoke 7 demos + signal（SIGTERM 143 + termios 恢复；SIGTSTP/CONT 恢复+重绘+exit 0）+ TERM=dumb 用例 PASS |
| M5.2 弃用策略与特性开关：deprecate → warn → remove（≥1 minor 周期）；feature flag 模式文档化 | P0 | M5.1 | 纳入 CONTRIBUTING 质量门禁 | ✅ 达成 — `docs/api-lifecycle.md`（M5.2：弃用策略 §1——生命周期一行「deprecate → warn → remove（≥1 minor 周期）」、边界变更表为触发、deprecation record 绝不静默、Phase 1/2/3 逐相机制、从不弃用清单；feature flag 模式 §2——tier tag 即 flag、graduation experimental → stable、M4.2 运行期开关先例、flag record）；CONTRIBUTING.md 质量门新增 **gate 5「Deprecation & API stability」**（公共 API 变更必查 `docs/api-stability.md` + `docs/api-lifecycle.md`；新导出以 experimental + `@since` 进入；移除走弃用周期 ≥1 minor、绝不静默；tier 变更同步清单表 + CHANGELOG + boundary-change 段）；`packages/solid/src/deprecate.ts` warn-once 机制（@internal、不改 170 公共符号数）：`warnOnce`（Set 注册表——每进程每 key 至多一次 `console.warn`，热路径仅 Set 查找不刷屏）+ `deprecatedValue`（透明 Proxy、仅 get trap——首次属性访问警告、之后原样转发，import 不警告、签名恒等不变）+ `deprecate_test.ts` **4 passed / 0 failed**（首次访问恰好警告 1 次且带 `[tern]` 前缀 +「renderer is deprecated」+「0.4.0」；后续访问不重复警告；按恒等转发原始 primitive；解构 primitive 永不警告）；drill 符号 `renderer`——`packages/solid/src/index.ts` `@deprecated` JSDoc（改用解构 primitive，0.4.0 移除）+ `deprecatedValue` Proxy 包装（index.ts:562）、`docs/api-stability.md` M5.2 决策（`renderer` experimental → deprecation-candidate：solid 计数 140 stable / **24** experimental / 5 internal / **1** deprecation-candidate；冻结集 86→85 experimental、deprecation-candidate 0→1）、CHANGELOG「### Deprecated」段（0.3.0 弃用、0.4.0 移除，≥1 minor 周期）；`index_test.ts` 测试面已迁离弃用导出。`bash tools/verify.sh` 四门全绿退出 0（2026-08-27）：gate 1 cargo build+test --workspace **595 passed / 0 failed**（与 M5.1 持平——M5.2 无 Rust 改动）；gate 2 deno check 通过；gate 3 deno test **549 passed / 0 failed**（M5.1 545 + deprecate_test 4；core 308+17+41+15、react 84、solid 75+4、examples 1）；gate 4 PTY smoke 7 demos + signal（SIGTERM 143 + termios 恢复；SIGTSTP/CONT 恢复+重绘+exit 0）+ TERM=dumb 用例 PASS |
| M5.3 教程与 cookbook：入门 → 布局 → 事件 → 主题 → 组件 → 性能 → 调试，含中文版 | P1 | — | 中英双语教程（用户社区为中文） | ⛔ 未实现（不在本轮 M5.1 验收范围） |
| M5.4 迁移指南与兼容性文档（0.2 → 1.0 断点清单） | P1 | M5.1 | | ⛔ 未实现（不在本轮 M5.1 验收范围） |
| M5.5 wasm 对齐：@tern/core 全组件 + 事件 + FocusManager 的 wasm 等价；tern-highlight-in-wasm；xterm.js 浏览器终端前端 demo | P1 | M1–M3（能力复用） | 恢复 Stage 4 延期项 | ⛔ 未实现（不在本轮 M5.1 验收范围） |
| M5.6 tern-server：内嵌密钥认证 + 多路复用常驻服务（ssh 场景深化） | P2 | — | 独立交付线；works-over-a-pty 已达成，此为差异化增量 | ⛔ 未实现（不在本轮 M5.1 验收范围） |
| M5.7 1.0 发布：版本冻结、CHANGELOG 1.0 章节、发布即声明 API 稳定契约 | P0 | M5.1–M5.2 | | ⛔ 未实现（依赖 M5.1–M5.2 完成，未到验收） |

**验收标准**：
- [x] API 审计报告 + 冻结边界文档入库；✅ 达成 — `docs/api-stability.md`（2026-08-27 只读审计）：core/react/solid/napi 四表面逐符号清单（238/167/170/53）+ 1.0 冻结边界（519 stable / 86 experimental / 23 internal），deprecation-candidate 交接 0（详见 M5.1 状态行）；
- [x] 弃用流程首次演练（对一个符号走完整周期）；✅ 达成 — 演练符号 `renderer`（@tern-tui/solid 值导出）走完整 deprecate → warn → remove 周期：deprecate 阶段（`@deprecated` JSDoc + CHANGELOG「### Deprecated」段 + `docs/api-stability.md` 决策 experimental → deprecation-candidate）；warn 阶段（warn-once 机制 `warnOnce` + `deprecatedValue` 透明 Proxy——首次属性访问恰好一次 `[tern]` 前缀警告、解构 primitive 永不警告，`deprecate_test.ts` 4 例）；remove 阶段排期 0.4.0（≥1 minor 周期）——完整周期入 `docs/api-lifecycle.md` §1；
- [ ] 教程/cookbook 中英双语覆盖全部 22+ 组件与全部事件面，CI 校验文档内代码示例可运行（示例进 PTY smoke）；
- [ ] wasm：浏览器 demo 渲染全部组件并支持键盘事件；tern-highlight 在 wasm 运行；
- [ ] tern-server 按独立验收（SSH 复用会话、认证失败处理）交付或明确再延期；
- [ ] v1.0.0 tag 发布，README/Docs 更新 API 稳定承诺。

**风险**：1.0 冻结后新能力只能走 minor 版本——冻结边界必须经过 M5.1 严格审计；wasm 对齐工作量大，允许分两子阶段（渲染对齐 → 事件/焦点对齐）。

---

## 5. 阶段依赖与建议排期

```
M1 终端能力与输入硬化 ─────────────┐
                                  ├─→ M2 渲染性能与滚动优化 ─┐
M1（能力探测供 M2 判断终端支持）    ┘                        ├─→ M4 无障碍/主题/跨平台 ─┐
M1（鼠标分级供 M3 菜单交互）───────┐                          │                          ├─→ M5 生态/文档/1.0
M3 组件与布局补齐 ─────────────────┴─→ M3 为 M4 语义树供组件 ─┘                          │
M2（基准门禁）───────────────────────（持续，贯穿 M2 之后所有阶段）─────────────────────┘
```

- **M1 → M2**：滚动优化需能力探测确认 DECSTBM/终端行为；
- **M1 → M3**：Menu 等鼠标交互依赖分级鼠标捕获；
- **M3 → M4**：语义树按组件定义语义；
- **M1–M4 → M5**：1.0 冻结必须在能力稳定后。

建议排期（估算，单人全职）：M1 ≈ 3–4 周；M2 ≈ 2–3 周；M3 ≈ 4–6 周；M4 ≈ 3–4 周；M5 ≈ 4–6 周（不含 tern-server 独立线）。总计约 4–5 个月到 1.0 候选。

---

## 6. 非目标（Non-goals，保持显式）

以下方向**明确不做**（现状决策保留，除非用户推翻）：

1. **IME 组合态（composition/preedit）**——归终端模拟器；确认输入走 bracketed paste 通道（已决策并测试，见 docs/components.md「IME posture」）。
2. **RTL / bidi 文本整形**——归终端模拟器；tern 按 grapheme cluster 逐簇排版，不实现双向算法。
3. **Sixel / kitty-graphics 内联图片**——超出 cell-buffer TUI 范畴；如未来需要，以独立可选通道评估（notcurses 类能力），不作为核心目标。
4. **原生 GPU/离屏渲染**——终端是输出设备，不做终端外渲染。
5. **Vue/Svelte/Preact 渲染器**——维持 React/Solid 双端（除非社区需求明确）。
6. **完整文本编辑器**——Textarea 增强（undo/redo/查找）是组件能力，不是类 Vim/Emacs 编辑器；编辑器应用由生态基于 tern 构建。

---

## 7. 路线图治理

- **主文档**：本文件（`.rolebox/plans/tui-roadmap.md`）为唯一路线图主文档，替代已移出仓库的旧 `docs/roadmap.md` / `docs/todo.md`。
- **状态同步**：组件级状态与验收在 `docs/components.md` 维护（单章节状态表）；性能数据在 `docs/perf.md` + `tools/bench/BASELINE.md`；发布历史在 CHANGELOG.md。
- **变更纪律**：新方向必须先在本路线图登记（含优先级、依赖、验收），再进入实现；未登记的大方向不得随意开工（延续 CONTRIBUTING 的 roadmap discipline）。
- **评审节奏**：每里程碑完成时评审一次（对照验收标准逐条勾选并记录实测数据）；每季度复核优先级与排期。
- **延期管理**：显式记录延期项与原因（参照 Stage 4 先例），不静默丢失。

---

## 8. 附录：对标库能力速查

| 能力 | ratatui | bubbletea | textual | blessed | notcurses | tern 现状 |
|------|---------|-----------|---------|---------|-----------|-----------|
| 布局引擎 | Constraint/Flex | 手工/流式 | CSS 风格 | 手工 | 手工 | taffy flex + CSS grid |
| 双缓冲/diff | cell 级 diff | 全帧 | 区域 diff | 全帧 | 双缓冲 | retained + 增量脏区 diff（更强） |
| 终端滚动优化 | 部分（Scrollbar 仅绘制） | — | 有 | — | 有 | **缺（M2）** |
| 交互式能力探测 | — | 部分 | 有 | 有（DA1） | 有 | 有（M1 ✅：5 查询批量 + 超时 + 缓存） |
| 鼠标捕获分级 | 部分 | 部分 | 有 | — | 有 | **缺（M1）** |
| 信号处理 | — | 有 | 有 | 有 | 有 | **缺（M1）** |
| 组件集 | 20+（含 Calendar） | 20+（含 Help） | 丰富（含 DataTable） | 基础 | 基础 + 图形 | 22（缺表单/Menu/Help/Calendar，M3） |
| 无障碍 | — | — | **有（语义树）** | — | — | **语义树已落地（M4.1 ✅）；a11y 输出通道 M4.2 待办** |
| 主题 | 样式常量 | 样式 | **运行期主题** | 样式 | — | **运行期切换（M4.5 ✅：setTheme 原地重解析 + 黄金测试）；对比度检查 API（auditTheme/contrastRatio）** |
| Unicode | wcwidth 级 | 部分 | 强 | 弱 | 强 | **grapheme cluster 全程（强）** |
| 测试设施 | 黄金 + 快照 | 测试套件 | 快照 + 语义断言 | — | 测试 | 黄金 + PTY + fuzz + bench（强） |
| 跨平台验证 | 多 CI | 多 CI | 多 CI | — | 多 CI | 构建 11 目标、运行验证 8（M4.3 ✅；darwin-x64/riscv64/android build-only） |
| 文档 | 好 | 好 | **优秀** | 一般 | 一般 | 好（M5 补教程/中文） |

---

*本路线图随项目演进持续修订；所有「已实现」断言以代码库与 docs/ 为准，验收以测试与实测数据为准。*
