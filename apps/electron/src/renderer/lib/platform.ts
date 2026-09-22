/** 平台检测工具 */

export function detectIsWindows(): boolean {
  return navigator.userAgent.includes('Windows')
}
