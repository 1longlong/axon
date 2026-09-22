import { describe, expect, test } from 'bun:test'
import type { IpcMainInvokeEvent } from 'electron'
import { assertMainFrame } from './assert-main-frame'

function eventFromMainFrame(isMainFrame: boolean): IpcMainInvokeEvent {
  const mainFrame = {}
  return {
    senderFrame: isMainFrame ? mainFrame : {},
    sender: { mainFrame },
  } as unknown as IpcMainInvokeEvent
}

describe('IPC 主框架边界', () => {
  test('允许主框架调用', () => {
    expect(() => assertMainFrame(eventFromMainFrame(true), '测试功能')).not.toThrow()
  })

  test('拒绝子框架调用并保留功能名称', () => {
    expect(() => assertMainFrame(eventFromMainFrame(false), '测试功能'))
      .toThrow('不允许从子框架请求测试功能')
  })
})
