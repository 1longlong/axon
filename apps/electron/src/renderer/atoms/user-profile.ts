import { atom } from 'jotai'
import { DEFAULT_USER_AVATAR, DEFAULT_USER_NAME } from '@axon/shared'
import type { UserProfile } from '@axon/shared'

export const userProfileAtom = atom<UserProfile>({
  userName: DEFAULT_USER_NAME,
  avatar: DEFAULT_USER_AVATAR,
})
