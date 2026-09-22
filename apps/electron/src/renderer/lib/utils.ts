import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Tailwind class 合并工具（条件 class + 冲突去重） */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
