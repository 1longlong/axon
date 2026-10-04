import * as React from 'react'
import { useAtom } from 'jotai'
import { Check, Loader2 } from 'lucide-react'
import { MAX_USER_AVATAR_LENGTH, MAX_USER_NAME_LENGTH } from '@/types/user-profile'
import { userProfileAtom } from '@/atoms/user-profile'
import { cn } from '@/lib/utils'

const AVATAR_SUGGESTIONS = ['🧑‍💻', '🦊', '🐼', '🧠', '🚀', '✨'] as const

/** 资料页编辑本地草稿，主进程保存成功后才更新共享资料原子；失败保留输入供重试。 */
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

  /** 将姓名和头像交给原资料 IPC；仅把已持久化的返回值发布给会话展示。 */
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
      <div className="rounded-md border border-border-subtle bg-[hsl(var(--input-surface))] p-4">
        <div className="flex items-center gap-3 border-b border-border-subtle pb-4">
          <AvatarPreview avatar={avatar.trim() || profile.avatar} />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium" title={userName.trim() || profile.userName}>{userName.trim() || profile.userName}</p>
            <p className="mt-1 text-[11px] leading-5 text-muted-foreground">资料保存在本机，不依赖云端账号。</p>
          </div>
        </div>

        <label className="mt-4 block">
          <span className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium">用户名</span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {userName.length}/{MAX_USER_NAME_LENGTH}
            </span>
          </span>
          <input
            value={userName}
            maxLength={MAX_USER_NAME_LENGTH}
            onChange={(event) => setUserName(event.target.value)}
            placeholder="输入你的名字"
            className="mt-1.5 h-8 w-full rounded-md border bg-[hsl(var(--input-surface))] px-2 text-[13px] outline-none focus:ring-1 focus:ring-ring"
          />
        </label>

        <div className="mt-4">
          <span className="text-xs font-medium">头像</span>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {AVATAR_SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                aria-label={`使用头像 ${suggestion}`}
                aria-pressed={avatar.trim() === suggestion}
                onClick={() => setAvatar(suggestion)}
                className={cn(
                  'flex size-8 items-center justify-center rounded-md border text-base hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  avatar.trim() === suggestion
                    ? 'border-indigo-500/40 bg-indigo-500/5 dark:border-indigo-400/50'
                    : 'border-border-subtle bg-[hsl(var(--input-surface))]',
                )}
              >
                {suggestion}
              </button>
            ))}
          </div>
          <input
            aria-label="头像内容"
            value={avatar}
            maxLength={MAX_USER_AVATAR_LENGTH}
            onChange={(event) => setAvatar(event.target.value)}
            placeholder="也可以输入 emoji 或 data:image URL"
            className="mt-2 h-8 w-full rounded-md border bg-[hsl(var(--input-surface))] px-2 font-mono text-[11px] outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        <div className="mt-4 flex items-center justify-between gap-3 border-t border-border-subtle pt-3">
          <p className="min-w-0 flex-1 break-words text-[11px] leading-5 text-muted-foreground" role="status">{message}</p>
          <button
            type="button"
            disabled={!isDirty || isSaving}
            onClick={() => void handleSave()}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-xs text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isSaving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            保存资料
          </button>
        </div>
      </div>
    </SettingsSection>
  )
}

function AvatarPreview({ avatar }: { avatar: string }): React.ReactElement {
  if (avatar.startsWith('data:image/')) {
    return <img src={avatar} alt="用户头像" className="size-12 shrink-0 rounded-md border border-border-subtle object-cover" />
  }
  return (
    <div className="flex size-12 shrink-0 items-center justify-center rounded-md border border-border-subtle bg-muted/50 text-2xl">
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
    <section className="max-w-2xl">
      <h1 className="text-sm font-semibold">{title}</h1>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
      <div className="mt-4">{children}</div>
    </section>
  )
}
