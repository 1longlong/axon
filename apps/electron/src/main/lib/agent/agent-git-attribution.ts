/** Agent 代用户创建 Git commit 或 PR/MR 时使用的 Axon 标识规则。 */

export const AXON_COMMIT_TRAILER = 'Made-with: Axon'
export const AXON_PR_ATTRIBUTION = 'Made with Axon'

/** 构造受管 system prompt 片段；开关关闭时也明确禁止 runtime 自行添加标识。 */
export function buildGitAttributionPromptSection(enabled: boolean): string {
  if (!enabled) {
    return `## Git / PR 标识
用户已关闭 Axon 标识；除非用户在当前任务中明确要求，否则不要添加 Axon 归因。`
  }
  return `## Git / PR 标识
当你代用户创建 commit 或 PR/MR 时，除非用户在当前任务中明确拒绝：
- commit message 末尾追加唯一的 \`${AXON_COMMIT_TRAILER}\` trailer；不要使用 \`Co-Authored-By\`，不要修改 author 或 committer。
- PR/MR 描述末尾追加唯一的 \`${AXON_PR_ATTRIBUTION}\`。`
}

/** 合并用户 Agent 提示词与 Axon 受管约束，作为 AgentService 的 systemPrompt 上游。 */
export function buildAgentSystemPrompt(userPrompt: string | undefined, attributionEnabled: boolean): string {
  return [
    userPrompt?.trim(),
    buildGitAttributionPromptSection(attributionEnabled),
  ].filter((section): section is string => Boolean(section)).join('\n\n')
}
