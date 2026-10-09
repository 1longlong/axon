/**
 * 用户资料服务
 *
 * 用户资料存放在入口指定的独立文件，并沿用 safe-file 的原子写与恢复链。
 */

import { existsSync } from 'node:fs'
import {
  DEFAULT_USER_AVATAR,
  DEFAULT_USER_NAME,
  MAX_USER_AVATAR_LENGTH,
  MAX_USER_NAME_LENGTH,
} from '@axon/shared'
import type { UserProfile } from '@axon/shared'
import { readJsonFileSafe, writeJsonFileAtomic } from '../storage/safe-file'

export function getDefaultUserProfile(): UserProfile {
  return {
    userName: DEFAULT_USER_NAME,
    avatar: DEFAULT_USER_AVATAR,
  }
}

function normalizeField(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== 'string') return fallback
  const normalized = value.trim()
  if (!normalized) return fallback
  return normalized.slice(0, maxLength)
}

/** 清洗磁盘或 IPC 输入，避免空值和无限尺寸内容进入持久化。 */
export function normalizeUserProfile(value: unknown): UserProfile {
  if (!value || typeof value !== 'object') return getDefaultUserProfile()
  const candidate = value as Record<string, unknown>
  return {
    userName: normalizeField(candidate.userName, DEFAULT_USER_NAME, MAX_USER_NAME_LENGTH),
    avatar: normalizeField(candidate.avatar, DEFAULT_USER_AVATAR, MAX_USER_AVATAR_LENGTH),
  }
}

/** 读取入口指定的资料文件；缺失或恢复失败时返回新安装默认值。 */
export function getUserProfile(filePath: string): UserProfile {
  if (!existsSync(filePath)) return getDefaultUserProfile()

  const data = readJsonFileSafe<unknown>(filePath)
  if (!data) {
    console.error('[用户资料] 读取失败（主文件/.tmp/.bak 均不可用），使用默认资料')
    return getDefaultUserProfile()
  }
  return normalizeUserProfile(data)
}

/** 合并用户输入并原子保存到指定文件；不隐式选择应用的数据目录。 */
export function updateUserProfile(
  updates: Partial<UserProfile>,
  filePath: string,
): UserProfile {
  const current = getUserProfile(filePath)
  const updated = normalizeUserProfile({
    userName: updates.userName ?? current.userName,
    avatar: updates.avatar ?? current.avatar,
  })

  try {
    writeJsonFileAtomic(filePath, updated)
    console.log(`[用户资料] 已更新: ${updated.userName}`)
  } catch (error) {
    console.error('[用户资料] 写入失败:', error)
    throw new Error('写入用户资料失败')
  }

  return updated
}
