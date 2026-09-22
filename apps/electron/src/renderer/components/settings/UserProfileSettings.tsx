import * as React from 'react'
import { useAtom } from 'jotai'
import { Check, Loader2 } from 'lucide-react'
import { MAX_USER_AVATAR_LENGTH, MAX_USER_NAME_LENGTH } from '@/types/user-profile'
import { userProfileAtom } from '@/atoms/user-profile'

const AVATAR_SUGGESTIONS = ['🧑‍💻', '🦊', '🐼', '🧠', '🚀', '✨'] as const

export function UserProfileSettings(): React.ReactElement {
  const [profile, setProfile] = useAtom(userProfileAtom)
  const [userName, setUserName] = React.useState(profile.userName)
  const [avatar, setAvatar] = React.useState(profile.avatar)
  const [isSaving, setIsSaving] = React.useState(false)
  const [message, setMessage] = React.useState<string | null>(null)

  React.useEffect(() => {
    setUserName(profile.userName)
    setAvatar(profile.avatar)
  }, [profile])

  const isDirty = userName.trim() !== profile.userName || avatar.trim() !== profile.avatar

  const handleSave = async (): Promise<void> => {
    if (isSaving) return
    setIsSaving(true)
    setMessage(null)
    try {
      const updated = await window.axon.userProfile.update({ userName, avatar })
      setProfile(updated)
      setMessage('用户资料已保存')
    } catch (error: unknown) {
      setMessage(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <SettingsSection
      title="用户资料"
      description="这份资料会在后续 Chat 和 Agent 会话中作为你的显示身份。"
    >
      <div className="rounded-xl border bg-card p-5 shadow-sm">
        <div className="flex items-center gap-4 border-b pb-5">
          <AvatarPreview avatar={avatar.trim() || profile.avatar} />
          <div className="min-w-0">
            <p className="truncate text-base font-medium">{userName.trim() || profile.userName}</p>
            <p className="mt-1 text-xs text-muted-foreground">资料保存在本机，不依赖云端账号。</p>
          </div>
        </div>

        <label className="mt-5 block">
          <span className="text-sm font-medium">用户名</span>
          <input
            value={userName}
            maxLength={MAX_USER_NAME_LENGTH}
            onChange={(event) => setUserName(event.target.value)}
            placeholder="输入你的名字"
            className="mt-2 h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none transition-shadow focus:ring-2 focus:ring-ring/30"
          />
          <span className="mt-1 block text-right text-[11px] text-muted-foreground">
            {userName.length}/{MAX_USER_NAME_LENGTH}
          </span>
        </label>

        <div className="mt-4">
          <span className="text-sm font-medium">头像</span>
          <div className="mt-2 flex flex-wrap gap-2">
            {AVATAR_SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                aria-label={`使用头像 ${suggestion}`}
                onClick={() => setAvatar(suggestion)}
                className="flex h-10 w-10 items-center justify-center rounded-lg border bg-background text-xl hover:bg-muted"
              >
                {suggestion}
              </button>
            ))}
          </div>
          <input
            value={avatar}
            maxLength={MAX_USER_AVATAR_LENGTH}
            onChange={(event) => setAvatar(event.target.value)}
            placeholder="也可以输入 emoji 或 data:image URL"
            className="mt-3 h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none transition-shadow focus:ring-2 focus:ring-ring/30"
          />
        </div>

        <div className="mt-6 flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground" role="status">{message}</p>
          <button
            type="button"
            disabled={!isDirty || isSaving}
            onClick={() => void handleSave()}
            className="flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm text-primary-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isSaving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
            保存资料
          </button>
        </div>
      </div>
    </SettingsSection>
  )
}

function AvatarPreview({ avatar }: { avatar: string }): React.ReactElement {
  if (avatar.startsWith('data:image/')) {
    return <img src={avatar} alt="用户头像" className="h-16 w-16 shrink-0 rounded-2xl border object-cover" />
  }
  return (
    <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border bg-muted text-3xl">
      {avatar}
    </div>
  )
}

function SettingsSection({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <section>
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      <div className="mt-6">{children}</div>
    </section>
  )
}
