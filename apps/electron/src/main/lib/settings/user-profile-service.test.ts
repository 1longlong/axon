import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_USER_AVATAR, DEFAULT_USER_NAME, MAX_USER_NAME_LENGTH } from '../../../types'
import {
  getDefaultUserProfile,
  getUserProfile,
  normalizeUserProfile,
  updateUserProfile,
} from './user-profile-service'

let testDirectory: string
let profilePath: string

beforeEach(() => {
  testDirectory = mkdtempSync(join(tmpdir(), 'axon-user-profile-'))
  profilePath = join(testDirectory, 'user-profile.json')
})

afterEach(() => {
  rmSync(testDirectory, { recursive: true, force: true })
})

describe('用户资料读取', () => {
  test('文件不存在时返回默认资料且不产生文件', () => {
    expect(getUserProfile(profilePath)).toEqual(getDefaultUserProfile())
    expect(existsSync(profilePath)).toBe(false)
  })

  test('读取时清洗空值和超长用户名', () => {
    writeFileSync(profilePath, JSON.stringify({
      userName: `  ${'a'.repeat(MAX_USER_NAME_LENGTH + 10)}  `,
      avatar: '   ',
    }))

    const profile = getUserProfile(profilePath)
    expect(profile.userName).toHaveLength(MAX_USER_NAME_LENGTH)
    expect(profile.avatar).toBe(DEFAULT_USER_AVATAR)
  })

  test('主文件损坏时从备份恢复', () => {
    updateUserProfile({ userName: '第一次' }, profilePath)
    updateUserProfile({ userName: '第二次' }, profilePath)
    writeFileSync(profilePath, '{ broken', 'utf-8')

    expect(getUserProfile(profilePath).userName).toBe('第一次')
  })
})

describe('用户资料更新', () => {
  test('部分更新保留其他字段并使用原子 JSON 写入', () => {
    updateUserProfile({ userName: '  Covenant  ', avatar: '🦊' }, profilePath)
    const result = updateUserProfile({ userName: 'Axon 用户' }, profilePath)

    expect(result).toEqual({ userName: 'Axon 用户', avatar: '🦊' })
    expect(JSON.parse(readFileSync(profilePath, 'utf-8'))).toEqual(result)
    expect(existsSync(`${profilePath}.tmp`)).toBe(false)
  })

  test('空更新值回退到默认值', () => {
    expect(updateUserProfile({ userName: '', avatar: '' }, profilePath)).toEqual({
      userName: DEFAULT_USER_NAME,
      avatar: DEFAULT_USER_AVATAR,
    })
  })
})

describe('用户资料输入清洗', () => {
  test('非对象输入返回默认资料', () => {
    expect(normalizeUserProfile(null)).toEqual(getDefaultUserProfile())
    expect(normalizeUserProfile('invalid')).toEqual(getDefaultUserProfile())
  })
})
