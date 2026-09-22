/** Agent IPC 通道名称；shared → main → preload → renderer 四层必须共用此定义。 */

export const AGENT_IPC_CHANNELS = {
  LIST_SESSIONS: 'axon:agent:sessions:list',
  LIST_ACTIVE_RUNS: 'axon:agent:runs:list-active',
  GET_SESSION: 'axon:agent:sessions:get',
  GET_REASONING_CAPABILITY: 'axon:agent:reasoning-capability:get',
  CREATE_SESSION: 'axon:agent:sessions:create',
  UPDATE_SESSION: 'axon:agent:sessions:update',
  DELETE_SESSION: 'axon:agent:sessions:delete',
  GET_MESSAGES: 'axon:agent:messages:list',
  SEND: 'axon:agent:send',
  STOP: 'axon:agent:stop',
  IS_ACTIVE: 'axon:agent:is-active',
  LIST_QUEUED_MESSAGES: 'axon:agent:queue:list',
  CANCEL_QUEUED_MESSAGE: 'axon:agent:queue:cancel',
  MOVE_QUEUED_MESSAGE: 'axon:agent:queue:move',
  QUEUE_EVENT: 'axon:agent:queue:event',
  PERMISSION_RESPOND: 'axon:agent:permission:respond',
  ASK_USER_RESPOND: 'axon:agent:ask-user:respond',
  EXIT_PLAN_MODE_RESPOND: 'axon:agent:exit-plan-mode:respond',
  CHECK_ENVIRONMENT: 'axon:agent:environment:check',
  EVENT: 'axon:agent:event',
} as const
