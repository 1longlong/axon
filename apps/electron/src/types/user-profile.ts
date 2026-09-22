/** 用户资料契约：独立于通用设置，供 Chat 与 Agent 后续共同消费。 */

export const DEFAULT_USER_AVATAR = '🧑‍💻'
export const DEFAULT_USER_NAME = '用户'
export const MAX_USER_NAME_LENGTH = 80
export const MAX_USER_AVATAR_LENGTH = 1_500_000

export interface UserProfile {
  userName: string
  /** emoji 字符串或 data:image/* URL。 */
  avatar: string
}

export const USER_PROFILE_IPC_CHANNELS = {
  GET: 'user-profile:get',
  UPDATE: 'user-profile:update',
} as const
