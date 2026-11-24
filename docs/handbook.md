# Incredibox Composer · 自动化作曲工作台

为 Steam 版《Incredibox / 节奏盒子》（Electron/Chromium）做的一套**外接自动化作曲系统**：
在浏览器里用 7×N 网格编曲，通过 CDP 注入到游戏内部，由游戏自己的 `AudioContext` 循环时钟驱动，
换装、静音、拍内切分全部踩在小节边界上，并支持「一键自动出带」直接调用游戏原生录制。

实现依据 `design.md` 的三层架构：

```
[Host Web UI (React+Vite)]  <-- WebSocket -->  [Node.js CDP Bridge]  <-- CDP(9222) -->  [Incredibox Electron 进程]
  7×N 网格编曲矩阵                              监听构建产物热注入                          [Guest Bundle (Vite IIFE)]
  段落复制 / 局部跳转                            转发乐谱 JSON 与指令                        Hook AudioContext 硬件时钟
  乐谱持久化 (JSON)                             管理连接生命周期                            前瞻调度器 (Lookahead Scheduler)
```

---

## 1. 快速开始

```bash
npm install

# A) 没有装游戏：用内置模拟舞台验证整条链路（会自动拉起一个 Chrome 打开 /sim）
npm run sim

# B) 装了 Steam 版 Incredibox：先给游戏加启动参数 --remote-debugging-port=9222
#    （Steam 库 → 右键 Incredibox → 属性 → 启动选项），启动游戏后：
IC_NO_SIM=1 npm run dev
```

| 入口 | 地址 |
| --- | --- |
| Host UI（生产模式，Bridge 直接托管） | `http://127.0.0.1:9451/` |
| Host UI（开发模式，Vite HMR） | `http://127.0.0.1:5173/` |
| 内置模拟舞台 | `http://127.0.0.1:9451/sim/` |
| 健康检查 / 状态 / 页面求值 | `/health` · `/state` · `POST /eval` |

`npm run sim` 做的事情：构建 Guest → 启动 Bridge → 拉起 Chrome（带 `--remote-debugging-port`）
打开模拟器 → 1 秒内自动注入 `dist/guest.bundle.js`。打开 `http://127.0.0.1:9451/` 就是作曲台。

---

## 2. 目录结构

```text
incredibox-composer/
├── packages/
│   ├── shared/          领域模型、状态推演、调度编译、网格编辑、乐谱序列化（+27 个单测）
│   ├── guest/           注入游戏内部的运行时（Vite lib → IIFE 单文件 dist/guest.bundle.js）
│   │   ├── adapter/     dom / sim / api 三种 GameAdapter 实现
│   │   ├── audio-clock  AudioContext + AudioBufferSourceNode.start 打桩，重建循环时钟
│   │   ├── transport    前瞻调度器（相位模型 + 提前量 + 批次下发）
│   │   └── mixer        一键自动出带时序
│   ├── bridge/          CDP 连接/目标定位/热注入/WS Hub/静态托管/断线重连
│   └── host/            React 7×N 网格 DAW UI（Tailwind v4）
├── sim/                 内置模拟游戏页（开发与验收用，非官方）
├── scripts/
│   ├── dev.mjs          开发编排（guest watch + bridge + vite dev）
│   └── e2e.mjs          端到端验收（headless Chrome，32 项断言）
└── dist/guest.bundle.js 注入产物（Bridge 监听它的变更做热注入）
```

---

## 3. 游戏内控制台

注入后页面上会有 `window.__INCREDIBOX_AGENT__`，可在 DevTools 里直接玩：

```js
__INCREDIBOX_AGENT__.status()                        // 适配层 / 循环时长 / 进度 / 时钟来源
__INCREDIBOX_AGENT__.adapter.equipIcon(0, 3)         // 槽位 0 换图标 3（下一个小节头生效）
__INCREDIBOX_AGENT__.adapter.setMute(0, true)        // 即时静音
__INCREDIBOX_AGENT__.adapter.clearSlot(0)            // 清空槽位
__INCREDIBOX_AGENT__.probe()                         // 打印探测报告（槽位/图标/循环候选/全局对象）
__INCREDIBOX_AGENT__.receive(JSON.stringify({ type: 'probe' }))
```

---

## 4. 时序模型（和游戏机制严格对齐）

| 机制 | 游戏行为 | 本系统的处理 |
| --- | --- | --- |
| `EQUIP` 换装 | **队列**：调用后下一个循环小节第 1 拍才发声 | 编译期把 `bar=N` 的换装改写成 `fireBar=N-1`、`fireFraction=1-leadBeats/beatsPerBar`（默认提前 1 拍）；`bar=1` 的换装交给「舞台预热」 |
| `MUTE` / `UNMUTE` | **即时** | 直接按 `bar + beat` 定位到拍内比例派发，可做半拍切分与骤停 |
| 小节时钟 | 游戏自己的音乐循环 | 打桩 `AudioBufferSourceNode.prototype.start`，记录 `when / offset / buffer.duration / loop`，反推出 **单循环时长** 与 **循环边界**，小节网格直接钉在游戏时钟上（零累积漂移） |
| 时钟短暂消失 | 无人登台时游戏静音 | 用最后一次观测到的相位（`knownAnchor + k*duration`）外推，音乐回来后重新锚定 |
| 同一拍多角色 | 需要完全同步 | `fireFraction` 相同的指令被聚成一个 group，在同一个同步块里一次性下发（实测 Δt = 0.000ms） |

调度参数（UI「校准」页可改）：`offsetMs`（−50~+50ms 硬件缓冲补偿）、`equipLeadBeats`（默认 1 拍）、
`lookaheadMs`（默认 50ms）、`tickMs`（默认 15ms）。调度器还会用滑动平均补偿 `setTimeout`
相对音频时钟的系统性迟到。

---

## 5. 在真实游戏里适配

游戏内部对象无法预先逆向，Guest 侧做了三层降级，`adapterMode=auto` 时自动挑选：

1. **`api`**：页面存在 `window.__INCREDIBOX_GAME_API__`（自己写的注入脚本可暴露 `equip/clear/setMute/setSolo/setRecord/getClock`）。
2. **`dom`**：纯 DOM 兜底。按 `[data-slot]` / `[data-icon]` 约定先找；找不到就用「一排尺寸相近的兄弟元素」启发式推断；
   换装走完整指针 + HTML5 拖拽序列（`pointerdown → pointermove → dragstart/dragover → drop → pointerup`），
   静音/清空走点击。选择器可以在 UI「校准 → DOM 选择器画像」里手工指定。
3. 时钟实在抓不到时，可在「校准 → 循环时长覆盖」里手填实测值（例如对着游戏测一个小节的秒数）。

排查流程：点「◎ 探测游戏」→ 「探测」面板会列出 7 个槽位选择器、20 个图标选择器、所有
`loop=true` 的循环候选（时长/是否在播/已跑多久）以及 window 上可疑的全局对象名。

---

## 5.1 真机实测记录（Steam 版 Incredibox 1.2.9）

已在真实游戏上跑通完整链路，环境：**Incredibox 1.2.9 / Electron 24.1.2 / Chromium 112 / appid 1545450**。
启动方式：Steam 库 → 右键 Incredibox → 属性 → 通用 → 启动选项填 `--remote-debugging-port=9222`
（或用 `steam://run/1545450//--remote-debugging-port=9222/`）。

实测结论（都已固化成代码）：

| # | 现象 | 处理 |
| --- | --- | --- |
| 1 | `AudioContext` 在页面加载时就创建好了，注入发生在那之后 → 只 patch 构造器永远抓不到 | Bridge 用 **`Page.addScriptToEvaluateOnNewDocument`** 在文档创建时（游戏脚本之前）注入 hook；刷新/导航后自动生效 |
| 2 | 音色 source **不是 `loop=true`**：每个循环重新 `start` 一次（V9 实测间隔 **5.0526s**） | hook 记录 `buffer.duration`（非循环也记），取**最近的 startTime** 作相位锚点；`loopDuration` 取最短的簇 |
| 3 | 槽位/图标识别 | `.polo[data-polo-id="0..6"]`、`.picto[data-picto-num="0..19"]`（数值即 iconId）、角色自带 `.cbt.icon-game-bt-mute/solo/delete`、拖拽热区 `.hitzone` |
| 4 | `.polo` 容器是 `visibility:hidden`（角色图形画在子元素上） | `isVisible()` 不再检查 `visibility`，否则 7 个槽位全被误杀 |
| 5 | **CDP 输入要求游戏窗口在前台**（被遮挡/最小化时 Electron 直接丢弃输入） | 调 `/screenshot` 会先 `Page.bringToFront`；脚本化操作前需把窗口切到前台 |
| 6 | 全屏遮罩会吞掉指针事件：`#lock-all`（z-index 999）、`.biglist.show` 等 | 操作前用 `elementFromPoint` 校验命中的是 `.hitzone` 而不是遮罩；`/eval` 可读 `#lock-all` 的 class 判断 |
| 7 | 直接跑 `Incredibox_steam.exe` 会因 Steam 校验在 1~2 分钟内退出 | 通过 Steam 启动（启动选项方式最稳） |

真机验收（3 小节乐谱，含换装 + 拍内切分）：

```
t+1.5s  arming    slots 0,2,-           舞台预热（等循环边界）
t+4.5s  playing   slots 0,2,-    bar 1  bar1 换装生效
t+7.5s  playing   slots 0,2,10          bar2 换装（提前 1 拍派发）生效
t+12.0s playing   slots 0m,2,10  bar 3  bar3 的 MUTE 即时生效
t+15.0s playing   slots 0,2,10          beat 5 的 UNMUTE 生效
t+16.5s idle                            3 小节播完自动停止
```

**切版本（UI 一键）**：顶栏「⇄ 切到游戏」会把游戏切到乐谱选定的版本，流程是
`回版本选择页 → 点对应版本图标 → 点封面 ▶ → 等 mix 界面（20 个图标）`，完成后自动重新探测回填 `loopDuration`。
注意游戏有**三个界面**（版本选择页 / 版本封面页 / mix 界面），DOM 极其相似，所以实现里不猜界面，
而是「点图标 → 读页面标题校验 → 不对就换导航入口重试」，最多试 4 个入口；全失败会明确提示你手动切。

配套调试接口（真机排障用）：`GET /screenshot`（截游戏画面）、`POST /input`
（`{kind:"click",x,y}` / `{kind:"drag",from,to}` / `{kind:"touch",...}`）、`POST /eval`、`POST /reload`。

## 6. 验收结果

`npm test`（27 项单测）与 `npm run test:e2e`（33 项端到端断言，headless Chrome + 模拟器 + 真实 Bridge）覆盖：

```
✓ CDP 1 秒内自动连上目标页并注入 bundle，适配层自动识别 sim
✓ 时钟来源 = AudioContext hook，单循环实测 4.000s
✓ equipIcon 在下一个循环头生效；setMute < 400ms 即时生效；clearSlot 正常
✓ 整曲 8 小节：25 条指令一次且仅一次执行，无重复
✓ 指令误差：中位 10.7ms / 最大 21.3ms（浏览器定时器抖动）
✓ 小节网格最小二乘斜率 3.9986s/小节（无累积漂移），首 3 与末 3 小节偏移均值差 -2.7ms
✓ 同一拍多角色静音 Δt = 0.000ms（无拉链式延迟）
✓ 跨小节换装提前量 = 0.500s（正好 1 拍）
✓ 从第 6 小节跳转试听：小节号正确 + 前置状态 100% 还原
✓ 一键自动出带：首小节边界按下 REC、末小节自动停止、录制时长 16s 符合预期
✓ 页面刷新后自动重新注入；bundle 变更触发热注入（不重启游戏）
```

> 注：单条指令的毫秒级误差来自浏览器 `setTimeout` 抖动，和「节拍漂移」是两件事 ——
> 小节网格直接钉在游戏的 `AudioContext` 循环上，误差不会随小节数累积（斜率 ≈ 4.000s/小节）。

---

## 7. 常用脚本

| 命令 | 作用 |
| --- | --- |
| `npm run sim` | 构建 Guest + 起 Bridge + 拉起模拟器（无游戏时的入口） |
| `npm run dev` | 开发编排：Guest watch + Bridge + Host HMR（`IC_NO_SIM=1` 可跳过模拟器） |
| `npm run bridge` | 只起 Bridge（`--port --cdp-port --bundle --no-watch --launch-sim --headless`） |
| `npm run build` | 构建 Guest（IIFE 单文件）+ Host（静态站点） |
| `npm run typecheck` | 四个包的严格模式类型检查 |
| `npm test` | shared 单测 |
| `npm run test:e2e` | 端到端验收（需要本机有 Chrome/Edge） |
| `npm run verify` | typecheck + 单测 + 构建 + e2e 全跑一遍 |

---

## 8. 已知限制

- **真机已打通，但自动化操作要求游戏窗口在前台**：Electron 在窗口被遮挡时会丢弃 CDP 注入的输入事件，
  脚本化驱动前必须先把窗口切到前台（GUI 里点一下即可）。
- 真机的循环长度来自「音色 source 每循环重新 start」的间隔 —— 实测 **V9 = 5.0526s、V5 Brazil = 8.000s**，
  不同曲目差别很大；读取 `loopDuration` 就能拿到当前版本的精确值，不需要任何配置。
- **清空舞台会让游戏停音，从而暂时失去循环时钟**（音乐不响就没有 source）。
  这时调度器会退化成「按 BPM 推算」并打警告，相位可能偏 1 个小节；音乐重新响起后会自动重新锚定。
- **游戏掉帧会跨过多个循环边界**（实测卡 421ms 就跳过了整个 8s 小节）；
  调度器现在按「实际跨过的循环数」推进小节号，不会与小节对齐永久错位，但被跳过的小节里的指令会丢。
- **一键切版本依赖 UI 自动化**（点图标 / 点播放），游戏窗口在最前台时成功率最高；
  若游戏正在转场或版本列表没渲染好，会退化为「提示你手动切」。手动切只需两步：≡ → 点版本图标 → 点 ▶。
- **模拟器不是官方游戏**：它复刻的是 design.md 里记录的游戏机制（队列换装、即时静音、全局循环、原生 REC）。
  其余曲目（V1~V8）的选择器与循环长度建议按第 5 节先跑一次「探测」确认。
- 浏览器定时器抖动是误差主因（实测中位 8ms、最大约 12–20ms）。节拍本身不漂移（钉在游戏时钟上），
  但单条指令可能有毫秒级抖动；追求更小误差需要把调度下沉到 AudioWorklet 或用游戏自身的音频调度接口。
- 「拍内换装」（`EQUIP` 且 `beat > 1`）在游戏侧只能在下个循环头生效，编译时会标记 `approximate`。
- `SOLO` 在纯 DOM 模式下无法驱动游戏原生行为，会退化为仅更新影子状态（`api`/`sim` 模式下正常）。
- 录制上限依赖游戏自身（模拟器按 180s 复刻），超长乐谱会收到红线预警但不会自动分段。
