/** Agent 分类附件契约；页面只提交草稿/附件标识，不自行指定可信文件路径。 */
import type { AgentSkillActivation } from './agent-message'
import type { AgentSkillSource } from './agent-provider'

export const MAX_AGENT_ATTACHMENTS = 10

/** 用户输入的显示/语义顺序；Skill 只引用同一草稿的真实附件，不携带自报名称或路径。 */
export type AgentInputPart = { type: 'text'; text: string } | { type: 'skill'; attachmentId: string }
export const MAX_AGENT_ATTACHMENT_BYTES = 100 * 1024 * 1024
export const MAX_AGENT_ATTACHMENT_CHUNK_BYTES = 256 * 1024
export const MAX_AGENT_IMAGE_SOURCE_BYTES = 20 * 1024 * 1024
export const MAX_AGENT_IMAGE_PIXELS = 40_000_000
export const MAX_AGENT_IMAGE_PREPARED_BYTES = 5 * 1024 * 1024
export const MAX_AGENT_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024
export const MAX_AGENT_IMAGE_THUMBNAIL_BYTES = 128 * 1024
export const AGENT_PASTED_TEXT_THRESHOLD = 8_000
export const MAX_AGENT_SELECTION_CHARS = 20_000
export const MAX_AGENT_ATTACHMENT_CONTEXT_CHARS = 100_000

export type AgentAttachmentKind = 'image' | 'file' | 'directory' | 'pastedText' | 'selection' | 'skill'

export interface AgentAttachmentBase {
  id: string
  name: string
  createdAt: number
}

/** 托管副本按根会话保存；localPath 是相对附件根的引用，不是页面可自由读取的路径。 */
export interface AgentManagedAttachment extends AgentAttachmentBase {
  kind: 'image' | 'file' | 'pastedText'
  storage: 'managed'
  localPath: string
  mediaType: string
  size: number
  image?: AgentPreparedImageReference
  pastedText?: { characterCount: number; preview: string }
}

export interface AgentImageVariant {
  localPath: string
  mediaType: 'image/png' | 'image/jpeg'
  size: number
  sha256: string
  width: number
  height: number
}

export interface AgentPreparedImageReference extends AgentImageVariant {
  thumbnail: AgentImageVariant
  note?: string
}

/** 图片字节只在后端/adapter 内存传递；应用 JSONL 保存上面的文件引用，不存 Base64。 */
export interface AgentPreparedImage {
  attachmentId: string
  data: string
  mediaType: 'image/png' | 'image/jpeg'
}

export interface AgentRecoveryAttachmentInput {
  context: string
  images: AgentPreparedImage[]
  warnings: string[]
}

export interface AgentImageCapability {
  support: 'supported' | 'unsupported' | 'unknown'
  maxImages?: number
  maxImageBytes?: number
  maxTotalBytes?: number
}

/** 宿主图片准备端口；不带文件权限，输入是 core 已核对的原件字节。 */
export interface AgentImagePreparationResult {
  bytes: Uint8Array
  originalMediaType: string
  mediaType: 'image/png' | 'image/jpeg'
  width: number
  height: number
  note?: string
  thumbnail: { bytes: Uint8Array; width: number; height: number }
}

export type AgentImageSource = { kind: 'draft'; draftId: string }
  | { kind: 'history'; sessionId: string; messageId: string }

export interface AgentImageChunk {
  attachmentId: string
  variant: 'image' | 'thumbnail'
  offset: number
  totalBytes: number
  sha256: string
  mediaType: 'image/png' | 'image/jpeg'
  data: string
}

/** 本地引用只由可信选择入口登记；文件内容以后续实际读取为准。 */
export interface AgentLocalAttachment extends AgentAttachmentBase {
  kind: 'file' | 'directory'
  storage: 'reference'
  path: string
  size: number
  modifiedAt: number
}

export interface AgentSelectionAttachment extends AgentAttachmentBase {
  kind: 'selection'
  text: string
  source?: string
  startLine?: number
  endLine?: number
}

/** 来源标识由后端目录生成；相同名称并不足以确定用户选中的 Skill。 */
export interface AgentSkillAttachment extends AgentAttachmentBase {
  kind: 'skill'
  sourceId: string
}

export interface AgentSkillChoice {
  sourceId: string
  name: string
  description: string
  directoryKind: AgentSkillSource['directoryKind']
  relativeInstructionPath: string
  argumentHint?: string
}

export interface AgentSkillChoices { skills: AgentSkillChoice[] }

export type AgentInputAttachment = AgentManagedAttachment | AgentLocalAttachment
  | AgentSelectionAttachment | AgentSkillAttachment

export interface AgentAttachmentDraft {
  id: string
  sessionId: string
  status: 'draft' | 'accepted' | 'committed'
  attachments: AgentInputAttachment[]
  uploads: AgentAttachmentUpload[]
}

/** 后端准备的本轮上下文；正文与 UI 的原始输入分开保存，不作为额外用户消息显示。 */
export interface AgentPreparedAttachmentInput {
  attachments: AgentInputAttachment[]
  context: string
  images?: AgentPreparedImage[]
  skillActivations?: AgentSkillActivation[]
  /** 仅后端单轮使用的确切来源，不能由页面提交；历史保存实际 context 和激活摘要。 */
  explicitSkillSources?: AgentSkillSource[]
}

export interface AgentAttachmentUpload {
  id: string
  draftId: string
  receivedBytes: number
  size: number
}

/** 固定附件命令，不包含任意读取路径或任意调用后端方法的能力。 */
export type AgentAttachmentCommand =
  | { action: 'createDraft'; sessionId: string }
  | { action: 'getDraft'; draftId: string }
  | { action: 'getImageCapability'; sessionId: string }
  | { action: 'listSkills'; sessionId: string }
  | { action: 'addSkill'; draftId: string; sourceId: string }
  | { action: 'addSelection'; draftId: string; text: string; source?: string; startLine?: number; endLine?: number }
  | { action: 'readImage'; source: AgentImageSource; attachmentId: string; variant: 'image' | 'thumbnail'; offset: number }
  | { action: 'beginUpload'; draftId: string; name: string; mediaType: string; size: number; kind: 'image' | 'file' | 'pastedText' }
  | { action: 'getUpload'; uploadId: string }
  | { action: 'cancelUpload'; uploadId: string }
  | { action: 'uploadChunk'; uploadId: string; offset: number; data: string }
  | { action: 'finishUpload'; uploadId: string }
  | { action: 'remove'; draftId: string; attachmentId: string }
  | { action: 'discardDraft'; draftId: string }

export type AgentAttachmentCommandResult = AgentAttachmentDraft | AgentAttachmentUpload | AgentImageCapability | AgentImageChunk | AgentSkillChoices | boolean

export const AGENT_ATTACHMENT_IPC_CHANNELS = {
  COMMAND: 'axon:agent:attachments:command',
  PICK: 'axon:agent:attachments:pick',
  ADD_NATIVE_FILES: 'axon:agent:attachments:add-native-files',
} as const
