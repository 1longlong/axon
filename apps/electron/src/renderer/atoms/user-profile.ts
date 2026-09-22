import { atom } from 'jotai'
import { DEFAULT_USER_AVATAR, DEFAULT_USER_NAME } from '@/types/user-profile'
import type { UserProfile } from '@/types/user-profile'

export const userProfileAtom = atom<UserProfile>({
  userName: DEFAULT_USER_NAME,
  avatar: DEFAULT_USER_AVATAR,
})
