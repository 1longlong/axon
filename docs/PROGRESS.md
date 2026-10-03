# Axon 当前进度

> 只保留当前可执行状态；新会话结合根目录 `AGENTS.md` 与 `docs/axon-project-design.md` 继续。

## 当前状态

- 当前本地发行版本为 v0.1.3，生成 macOS Apple Silicon DMG/ZIP 与 SHA-256 清单；只在本机交付，不上传、不推送。
- 迭代 23“Agent Shell 文件快照执行”的四阶段及关联权限修复已完成。Pi 支持用户 Shell 解析、会话初始化异步预热、私有快照原子发布、条件恢复、环境覆盖与原始命令审批归因。
- 会话删除、工作区改变和应用退出都会释放快照引用；初始化时异步清理无归属或三天不活跃的遗留缓存，排除在途预热与跨轮引用。
- 主会话无 Plan 模式；独立 plan 子 Agent 保留。Pi 受宿主保护的普通/复合 Bash 命令先进入 Seatbelt，不因未命中白名单提前申请审批；显式禁止规则及真实越界升级仍有效。
- Pi 仍为新会话默认 runtime；Zima 未接入宿主 Shell 快照/Seatbelt 委托，受控 Python 分发仍待完成。
- Pi 宿主沙箱不可用时拒绝本轮，不再退回原生工具；Zima 无沙箱副作用工具等待普通人工审批。explore/plan 创建和逐轮执行均收窄为只读，审批不能放宽角色边界。
- Runtime 切换、Automation、内嵌终端、完整发布链等扩展项仍暂不实施，本轮没有恢复或启动新迭代。

## 本次交付：最近更新整理、提交与 v0.1.3 本地安装包（2026-10-04）

- `shared/agent-provider.ts` 新增必填的 `toolExecution`：adapter 按实际工具实例声明 `sandbox / runtime / host`。宿主工具工厂可明确声明自行守卫的 `managed` 工具，默认普通审批；模型参数不能设置这些授权元信息。`shared/agent-sandbox.ts` 的宿主端口必须报告真实能力，`shared/agent-run.ts` 补充 `sandbox_unavailable` 错误码。
- `agent-sandbox-command-service.ts → agent-service-instance.ts → agent-service.ts → pi-agent-adapter.ts`：始终装配端口并传递实际探测结果；能力失败或模式不匹配时在 SDK/Shell 启动前拒绝。应用层保存用户消息和明确失败 result，UI/重启可恢复；没有无沙箱原生工具回退。
- `agent-permission-service.ts → zima-agent-adapter.ts`：Zima 原生 Bash/Write/Edit 等等待普通人工审批；内置读工具保持直接读取。宿主反向工具调用也先检查权限，拒绝或授权缺失时不执行。正常 Pi 内置工具仍先在真实沙箱中尝试，结构化越界才申请 Grant。
- 普通会话白名单按执行来源、名称和输入绑定。同名自定义 Read/Write/Bash 不继承内置工具待遇；可信标记来自工具实例而非名称。AskUserQuestion、ToolSearch、SkillRead、MemoryList/Read、Agent、TaskList/Output 工厂明确声明 managed；MemoryWrite、TaskStop 和 MCP 保持普通审批。
- `agent-collaboration-service.ts → agent-service.ts → agent-permission-service.ts`：explore/plan 创建及每轮运行都固定只读；只有只读宿主沙箱明确覆盖 Bash 才向 explore 提供它，plan 永不提供 Bash。禁止角色升级或复用旧 Grant 扩大权限。`agent-tool-guidance.ts` 同步说明 Bash 取决于实际可用工具列表。
- 新增/调整 permission、Pi/Zima adapter、编排、协作和宿主能力回归测试；真实 Shell 冒烟补充只读项目写入拒绝及角色升级拒绝，桌面冒烟补齐可信执行元信息。README、核心设计、协议示例和根 AGENTS 同步现行边界。
- 根 `package.json`、`apps/electron/package.json` 和 `bun.lock` 的应用版本统一为 0.1.3；内部 shared/core 包版本不变。新增 `docs/releases/v0.1.3.md`，README 补充本地安装包说明。
- 最近源码、测试和文档更新一并纳入本次发布提交，附 `Co-Authored-By: Codex <codex@openai.com>`；本地标签 `v0.1.3` 用于定位发行提交。用户明确只生成本地包，不创建 GitHub Release，不推送提交或标签。

## 本轮集中验证

- `bun test`：90 个测试文件、583 项通过、0 失败、2127 次断言。
- `bun run typecheck`：全仓通过。
- `bun run --cwd apps/electron build`：v0.1.3 production build 通过，仅有既有 renderer 大 chunk 提示。
- 同日修复收尾的 `test:agent:shell:smoke`：真实 Electron/Seatbelt 验证通过，覆盖初始化、PATH 恢复、正常写入、只读项目写入拒绝且不能升级、精确 Grant、环境覆盖、cwd 回退、输出流、超时/停止和清理。本次打包未重复运行。
- 同日修复收尾的 `test:agent:smoke`：真实桌面 UI 验证通过，包括权限卡、子 Agent、Skills/MCP/记忆、文件树/Diff、消息流及 state/JSONL 恢复。本次打包未重复运行；模型事件使用隔离夹具，不是外部 API 验收，未运行 Zima live 测试。
- Shell 测试只加载临时 HOME/ZDOTDIR 的启动配置，没有执行真实用户 rc 脚本。Shell 冒烟临时文件已删除；桌面截图保留在 `/var/folders/g_/9jwx4hbn38vbn9fn6cryjpmm0000gn/T/axon-agent-smoke-wV14Sb/`。
- `git diff --check`：通过。
- `electron-builder --config electron-builder.yml --mac --arm64 --publish never`：本地 DMG/ZIP 打包成功；`package:checksums` 生成并验证当前版本 SHA-256 清单。
- `hdiutil verify` 与 `unzip -tq`：安装包完整性检查通过；app.asar 版本为 0.1.3，主进程/preload/renderer 入口及 Pi/MCP 依赖存在，Info.plist 版本为 0.1.3。

## 本地发行产物

- `apps/electron/release/Axon-0.1.3-arm64.dmg`
- `apps/electron/release/Axon-0.1.3-arm64.zip`
- `apps/electron/release/SHA256SUMS.txt`
- 构建产物不进入 Git。安装包未进行 Developer ID 签名或公证；Zima Python 不随包分发。未测试外部模型 API，也未将本机安装的 Axon 替换为新版本。

## 当前关键决定与边界

- 快照只用于宿主执行缓存，不进入应用消息历史或 runtime artifact；重启后重新初始化，不将旧快照作为永久会话状态恢复。
- 工具不等待预热，首条命令可能仍走原登录路线。快照只匹配初始化 cwd、固定解释器及登录参数；条件不符不临时重建。
- 初始环境来自进程继承和 SDK 环境，当前没有独立过滤配置，普通导出声明不做二次过滤。恢复后显式覆盖、runtime 工具目录和受控临时目录仍优先；原始命令驱动规则、审批与归因。
- 普通 exec 路线不保证 alias/函数跨 Shell 保留，单条工具的 export/cd 不改变初始化基线。缓存清理失败只诊断，不扩大工具权限。
- 缺少明确 OS 拒绝证据时，不能把通用网络连接失败猜测为沙箱拒绝；已有模型请求错误与重试机制不受影响。
- 开发阶段格式修改不维护旧配置兼容；重要流程保留简洁中文注释。扩展能力只有用户明确恢复才推进。

## 下一步

v0.1.3 本地发行收尾，等待用户安装试用或指定下一阶段。可在明确授权后验证本机 Go/PATH 与真实模型工具循环；隔离验收不替代真实用户 rc 环境。外部发布与推送仍需授权；Zima 宿主委托、内存快照、PTY、常驻 Shell、凭据代理和域名网络代理继续后置，公开分发前仍需 Developer ID 签名和公证。
