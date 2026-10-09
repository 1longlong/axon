/** 入口只公开实际 adapter 与中立连接校验；SDK 消息转换和私有传输留在实现文件。 */
export { PiAgentAdapter } from './pi-agent-adapter'
export { ZimaAgentAdapter, assertZimaConnection } from './zima-agent-adapter'
