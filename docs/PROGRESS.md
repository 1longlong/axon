# Axon 当前进度

> 更新于 2026-10-09。只保留最新状态；从 [README](../README.md)、[工程约定](../AGENTS.md)、[核心设计](axon-project-design.md)和 [UI 实现](ui-design.md)继续。

## 当前状态

- 迭代 24 七阶段按源码运行范围完成，AGENTS.md 已勾选；正式桌面使用一个共享独立 app-server，不保留进程内业务回退。
- main，应用及 workspace 版本为 v0.1.4。本轮用户重新授权本地提交，范围为现有 UI、迭代 24 模块化、架构文档、升版及 Git/helper 测试夹具修复，提交标识以 Git 记录为准；不推送、打包或访问外部模型。
- 打包后 GUI/Keychain 验证仍按用户要求停止，不标记通过。TUI/exec/daemon/远程入口、Runtime 切换、Zima 宿主沙箱/快照与 Python 分发等后置能力未恢复。

## 已完成的文档整理

- README.md 补充精简整体架构/实际目录树，区分 core 业务库、app-server 协议库与 apps/app-server 可执行入口；给出两个可独立运行的最小示例和源码入口命令。
- 示例注明宿主 workspace 依赖、Bun/源码构建环境、默认 Pi adapter 装配、凭据与审批能力、独占数据目录及 dispose/drain/EOF 生命周期，不宣传为已发布 npm SDK。
- AGENTS.md 增加现行架构、目录职责、唯一业务写入者、跨进程契约和扩展纪律；原工程约束/迭代状态保持。
- docs/axon-project-design.md 接收 plan 中现行的装配、握手/身份/私有桥、传输/完整历史和退出故障契约；修正迭代表中仍写“验收待完成”的旧状态。
- 删除已完成的 docs/axon-backend-modularization-plan.md，不另存备份；现行契约归核心设计，所有引用已清理。未删除其他设计文档或核心迭代计划。
- 更新本进度，移除上轮操作流水账；后续只维护 README 的入口说明、核心设计的完整契约与 AGENTS 的工程边界。

## v0.1.4 提交整理

- 提交包含迭代 24 的 core/host-node/runtime-adapters/app-server 分包、独立 stdio 服务、Electron 固定桥接、运行与退出协调、历史读取、测试夹具及现行架构文档；保留最近的 UI 改动。
- 根目录与七个 workspace 的 package.json、bun.lock workspace 元数据同步为 0.1.4；README 独立复用示例同步版本。现有依赖版本不因本次升版再更新。
- 升版时七个 workspace 类型检查、Electron 源码 production build、暂存 diff 格式检查通过；构建仍有既有 renderer 大 chunk 提示。未重新进行 GUI 或打包验证。
- 升版首次全仓为 1147 通过/1 项 Git/helper 就绪失败；本轮夹具修复后的最新验证见下节，不把旧失败记录删除或用复跑替代改动。
- 日志目录：/tmp/axon-v0.1.4-checks.pAUqUf（tests.log、git-helper-recheck.log、build.log 及下节修复验证日志）。本轮本地提交附 Co-Authored-By；提交前复核暂存范围和 diff 格式，不重复运行上一轮已通过的源码回归，不创建 tag 或远端 release。

## 最近 Git/helper 测试夹具修复

- 改动文件：apps/app-server/src/server.integration.test.ts、packages/core/src/project/workspace-file-diff.test.ts；新增 packages/core/test-support/blocking-git-helper.ts 和 blocking-git-helper.mjs；同步核心设计与本进度。不改生产 Git 执行/退出逻辑。
- 旧同步依赖 /bin/sh 写 PID 文件及 existsSync 轮询；缺少文件时不能区分 Shell 阶段与写入失败，且关闭管道后立即要求 PID 消失也与系统回收时序不一致。临时 Shell trace 诊断又触发两项瞬时 PID 断言失败，诊断改动已移除。
- 共享 helper 仍由真实 Git 的 fsmonitor 启动，exec 保留直接父子关系；装好 TERM handler 后主动通过本机测试端口发送 Git/helper PID，维持原有 stdout/stderr 管道。就绪保留三秒期限，并与 Diff 提前结束竞争；测试不能把普通返回当作在途退出。
- core 测试主动给 helper 发 TERM，确认仍存活；仍检查 dispose 后响应取消、drain 不提前完成。管道 close 后只接受实际 PID 的 ESRCH，有界等待，权限错误或持续存活仍失败。原有 EOF/SIGTERM、数据恢复和旧/新订阅断言保留，测试总超时未放宽，finally 关闭就绪服务器。
- 无外部观察器、无重试的三组专项验证共九次通过；最新全仓 169 文件、1148 通过/0 失败、6689 次断言，83.06 秒；七个 workspace 类型检查与 diff 格式检查通过。纯测试改动未重跑 production build/GUI/打包。
- 日志仍在 /tmp/axon-v0.1.4-checks.pAUqUf：helper-fixed-1.log 至 helper-fixed-3.log、tests-helper-fixed.log。旧 observer、sample 与失败日志保留。原 Shell 偶发停顿的系统层原因仍未确定；此次是移除不可靠夹具同步路径，不宣称修复系统 Shell 或生产缺陷。

## SWE-bench 接入分析（未实施）

- Axon 已有独立 stdio 后端、external 客户端、项目/会话创建、事件/历史和停止链路，可作为评测驱动基础；完整运行应经过 core 运行协调，而非只调用 adapter.query。
- 当前缺少批量任务驱动、补丁导出、预算/失败归类和官方评测结果汇总。普通会话创建仍不接受独立提示词/工具/Skill 绑定，Agent Profile 草案未实施；隔离数据目录可固定全局设置，但严格工具组合对比仍需装配接口扩展。
- Pi 生产执行器仅支持 macOS Seatbelt；Linux/Docker 中现行装配报告 platformUnsupported，AgentService 会 fail closed。不能以关闭探测或裸执行替代隔离。
- 已查官方 sb-cli 文档及 submit.py：支持将 Verified/Lite 补丁提交云端，不要求本地判卷 Docker；使用 sb-cli submit/get-report/get-quotas，需生成并验证 API Key。文档中的额度表只是示例，账户授权/额度与服务实际可用性尚未验证，不能承诺免费或无限提交。
- 当前推荐最小路径调整为 Mac 原生 Axon 解题 → 导出补丁 → 外部 sb-cli 云端判卷 → 获取报告。容器工具执行仅在需要统一解题依赖环境时再考虑，不是生成补丁或云端判卷的前置要求，也未恢复为正式迭代。
- 推荐先固定少量 Verified 任务，隔离仓库/HOME/数据目录，在 base_commit 上解题并完整收集修改和新增文件。官方 CLI 接受 JSON 数组/映射，源码也支持按行 JSONL；同次提交必须统一 model_name_or_path，instance_id 不能重复。答案、测试补丁及判卷数据不进入模型上下文或工具可读范围。
- 评测须冻结源码/模型/提示词/任务与 harness 版本，记录工具/API/压缩/终态和基础设施错误；第一版关闭个人 Skills、项目记忆、MCP 和未纳入预算的协作，不能把有人工提示的结果作为无人干预指标。
- 本轮确认上传仅负责判卷，不替本地 Agent 安装依赖或运行解题期间的测试；本地环境差异仍需记录。上传后同一 run 的既有预测不会重新评测，修改补丁须使用新 run_id；远程评测不等于自动公开上榜。只提出方案，不新增迭代、下载任务或宣称评测通过。
- 单题操作说明：从 Verified 提取 instance_id/repo/base_commit/problem_statement，在独立评测目录准备只含指定提交的浅仓库；Axon 新项目绑定此仓库，用新 Pi 会话处理问题。结束后可信外部导出器对新增文件登记 intent-to-add，再基于题目 base_commit 生成无外部 diff/textconv 的完整补丁并用 JSON 序列化提交字段；输出放在工作区外，不能让 Agent 读取标准答案。题库客户端缓存可能含参考字段，严格无人干预评测还需真正的可读范围隔离，不能把文件放在工作区外就宣称不可读。

## 已有文档验证

- README 两个 TypeScript 示例均实际运行通过：core 在隔离目录创建 Chat 元数据后 dispose/drain；独立 app-server 经真实子进程完成握手、external 客户端登记、会话列表请求、EOF 和退出码 0。均不请求模型。
- 首次根目录执行无法解析 workspace 包，改为在 apps/app-server 中保存、从根目录执行；core 初始化需要默认 Pi adapter，不能用抛错路由代替，示例已据实际调用链修正。
- apps/app-server 类型检查通过；文档本地链接、删除文件引用与 diff 格式检查完成。临时验证脚本已删除，不新增生产源码或测试入口。
- 纯文档改动未重复运行全仓/GUI/打包测试，不把上轮结果说成本轮重测。

## 已有源码收尾证据（2026-10-08）

日志目录：/tmp/axon-source-validation.Y8yvEE。全仓 tests-source-closeout.log：169 文件、1148 通过/0 失败、6697 次断言，86.21 秒；7 workspace 类型、production build、diff 检查及六项源码 Electron 冒烟通过。

source-desktop-model-quit-complete.log 验证真实生产 app.quit 同时收束 Chat/Pi 流、MCP 和原生确认：逐条 TCP close、连接清零、队列不执行、唯一 stopped 终态/Chat 局部文本和窗口补丁落盘。其他资源的真实 EOF/信号/异常、SDK/Seatbelt 与重启恢复由生产入口测试覆盖，不宣称所有 GUI 排列组合都重演。Agent UI 使用中立事件 child，快捷键使用确定性注册器；Zima 是真实进程上的离线协议，不代表远端 SDK/Python 分发。

## 遗留风险与下次起点

1. Git/helper 测试已采用主动握手与有界 PID 回收检查，全仓通过；原 Shell 系统层停顿原因不据此认定已解决。此前 Zima accept 偶发超时仍未归因，不放宽期限。
2. 下一阶段由用户指定；若开始评测，先确认云端账户 Verified 额度、模型/预算及审批策略，再开发本地任务驱动和补丁导出；不自动安装/上传，不先做容器执行器、候选 Profile 或通用无头产品。
3. 未经授权不提交/推送/签名/发布、替换安装或请求外部模型。
