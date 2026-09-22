# 常见 LLM 文本生成 API 协议示例

> 协议核对日期：2026-09-01；Axon 完整 Chat 链路验证日期：2026-09-06；Agent 模型调用与自动重试链路记录日期：2026-09-11。本文面向直接 HTTP 集成，示例中的 ID、token 数和响应文本均为教学用虚构数据；为突出协议骨架，省略了许多可选字段。模型 ID 和可用能力会变化，实际调用前应通过对应厂商的模型目录确认。

## 1. 先理解共同的通信过程

一次支持工具调用的文本生成通常不是一个请求，而是一个循环：

1. 应用发送对话历史、生成参数和工具定义。
2. 模型返回正文，或者返回“请调用某工具”的结构化数据。
3. 应用执行工具，并把结果作为新的上下文发回模型。
4. 模型结合工具结果生成最终答案。

非流式响应通常是一个完整 JSON。流式响应通常采用 SSE（Server-Sent Events）：HTTP body 由多个事件组成，每个事件的 `data:` 后面才是一段独立 JSON。整个 SSE body 本身不是一个 JSON 文档。

本文统一使用这个工具定义作为对照：

```json
{
  "name": "get_weather",
  "description": "查询指定城市的当前天气",
  "parameters": {
    "type": "object",
    "properties": {
      "city": {
        "type": "string",
        "description": "城市名称"
      }
    },
    "required": ["city"],
    "additionalProperties": false
  }
}
```

## 2. 协议总览

| 协议 | 主要端点 | 消息容器 | 系统指令 | 工具参数 | 流结束信号 |
| --- | --- | --- | --- | --- | --- |
| OpenAI Responses | `POST /v1/responses` | `input` 项目数组 | `instructions` 或输入项 | `arguments` 字符串增量 | `response.completed` / `response.incomplete` / `response.failed` |
| OpenAI Chat Completions | `POST /v1/chat/completions` | `messages` | `developer`/`system` 消息 | `tool_calls[].function.arguments` 字符串增量 | `finish_reason`，随后通常有 `[DONE]` |
| Anthropic Messages | `POST /v1/messages` | `messages[].content[]` 内容块 | 顶层 `system` | `tool_use.input` 对象；流中为 `partial_json` 字符串 | `message_delta.stop_reason` + `message_stop` |
| Gemini generateContent | `POST .../{model}:generateContent` | `contents[].parts[]` | `systemInstruction` | `functionCall.args` 对象 | 最后候选的 `finishReason`；SSE 连接结束 |
| DeepSeek / Mistral | `/chat/completions` | 大体沿用 OpenAI `messages` | `system` 消息 | 大体沿用 OpenAI 工具调用 | 大体沿用 `finish_reason` + `[DONE]`，但扩展字段不同 |

最容易混淆的区别是：OpenAI Chat 和 Anthropic 的流式工具参数都是“尚未完成的 JSON 字符串”；Gemini 的 `functionCall.args` 则直接是 JSON 对象。任何字符串参数都必须先完整累计，再做 JSON 解析和 Schema 校验。

---

## 3. OpenAI Responses API

Responses API 将输入和输出都建模为“项目”（item），适合文本、推理、函数调用和内置工具混合的工作流。官方参考：[Create a model response](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/responses/methods/create)。

### 3.1 普通文本请求

HTTP：

```text
POST https://api.openai.com/v1/responses
Authorization: Bearer $OPENAI_API_KEY
Content-Type: application/json
```

请求 JSON：

```json
{
  "model": "YOUR_OPENAI_MODEL_ID",
  "instructions": "你是一个简洁的中文助手。",
  "input": [
    {
      "role": "user",
      "content": [
        {
          "type": "input_text",
          "text": "用一句话解释 SSE。"
        }
      ]
    }
  ],
  "max_output_tokens": 256,
  "store": false
}
```

也可以把纯文本 `input` 简写为字符串：

```json
{
  "model": "YOUR_OPENAI_MODEL_ID",
  "input": "用一句话解释 SSE。",
  "store": false
}
```

简化后的完整响应：

```json
{
  "id": "resp_example_001",
  "object": "response",
  "created_at": 1788192000,
  "status": "completed",
  "error": null,
  "incomplete_details": null,
  "model": "YOUR_OPENAI_MODEL_ID",
  "output": [
    {
      "id": "msg_example_001",
      "type": "message",
      "status": "completed",
      "role": "assistant",
      "content": [
        {
          "type": "output_text",
          "text": "SSE 是服务器通过一个长连接持续向客户端单向推送事件的 HTTP 协议。",
          "annotations": []
        }
      ]
    }
  ],
  "usage": {
    "input_tokens": 18,
    "output_tokens": 28,
    "output_tokens_details": {
      "reasoning_tokens": 0
    },
    "total_tokens": 46
  }
}
```

不要假设 `output[0]` 必然是文本消息，因为输出数组还可能包含推理项、函数调用和内置工具结果。

### 3.2 流式文本

请求中加入：

```json
{
  "model": "YOUR_OPENAI_MODEL_ID",
  "input": "用一句话解释 SSE。",
  "stream": true,
  "store": false
}
```

SSE 事件顺序示意。下面每个 `data:` 都是独立 JSON，为便于阅读省略了部分生命周期事件：

```text
event: response.created
data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_example_002","object":"response","status":"in_progress","output":[],"usage":null}}

event: response.output_item.added
data: {"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"id":"msg_example_002","type":"message","status":"in_progress","role":"assistant","content":[]}}

event: response.content_part.added
data: {"type":"response.content_part.added","sequence_number":2,"item_id":"msg_example_002","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":3,"item_id":"msg_example_002","output_index":0,"content_index":0,"delta":"SSE 是服务器"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":4,"item_id":"msg_example_002","output_index":0,"content_index":0,"delta":"持续推送事件的 HTTP 协议。"}

event: response.output_text.done
data: {"type":"response.output_text.done","sequence_number":5,"item_id":"msg_example_002","output_index":0,"content_index":0,"text":"SSE 是服务器持续推送事件的 HTTP 协议。"}

event: response.completed
data: {"type":"response.completed","sequence_number":9,"response":{"id":"resp_example_002","object":"response","status":"completed","output":[{"id":"msg_example_002","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"SSE 是服务器持续推送事件的 HTTP 协议。","annotations":[]}]}],"usage":{"input_tokens":12,"output_tokens":20,"total_tokens":32}}}
```

适配时应主要消费 `response.output_text.delta`；最终 `response.completed` 携带完整响应和累计用量。异常终态还可能是 `response.incomplete` 或 `response.failed`，不能把 HTTP 正常断开自动当作生成成功。

### 3.3 函数调用

请求 JSON：

```json
{
  "model": "YOUR_OPENAI_MODEL_ID",
  "input": "上海现在天气怎么样？",
  "tools": [
    {
      "type": "function",
      "name": "get_weather",
      "description": "查询指定城市的当前天气",
      "parameters": {
        "type": "object",
        "properties": {
          "city": {
            "type": "string"
          }
        },
        "required": ["city"],
        "additionalProperties": false
      },
      "strict": true
    }
  ],
  "tool_choice": "auto",
  "store": true
}
```

非流式函数调用输出：

```json
{
  "id": "resp_example_003",
  "object": "response",
  "status": "completed",
  "output": [
    {
      "type": "function_call",
      "id": "fc_example_001",
      "call_id": "call_example_001",
      "name": "get_weather",
      "arguments": "{\"city\":\"上海\"}",
      "status": "completed"
    }
  ],
  "usage": {
    "input_tokens": 80,
    "output_tokens": 16,
    "total_tokens": 96
  }
}
```

注意 `arguments` 是“装着 JSON 的字符串”，而不是已经解析的对象。

流式函数参数的关键事件：

```text
event: response.output_item.added
data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_example_002","type":"function_call","call_id":"call_example_002","name":"get_weather","arguments":"","status":"in_progress"}}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","item_id":"fc_example_002","output_index":0,"delta":"{\"city\":"}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","item_id":"fc_example_002","output_index":0,"delta":"\"上海\"}"}

event: response.function_call_arguments.done
data: {"type":"response.function_call_arguments.done","item_id":"fc_example_002","output_index":0,"arguments":"{\"city\":\"上海\"}"}
```

应用执行工具后，使用 `call_id` 关联结果：

```json
{
  "model": "YOUR_OPENAI_MODEL_ID",
  "previous_response_id": "resp_example_003",
  "input": [
    {
      "type": "function_call_output",
      "call_id": "call_example_001",
      "output": "{\"temperature_c\":26,\"condition\":\"多云\"}"
    }
  ],
  "store": true
}
```

这里为了使用 `previous_response_id`，前后两次请求都采用服务端状态模式。若使用 `store: false`，应用应把需要保留的先前输出项目连同 `function_call_output` 一起显式放进新请求。`output` 也通常作为字符串传递；它的内容可以是序列化后的 JSON。

---

## 4. OpenAI Chat Completions API

Chat Completions 使用经典的 `messages` 数组。大量第三方“OpenAI-compatible”接口以它为兼容目标，但兼容程度并不一致。官方参考：[Chat Completions](https://developers.openai.com/api/reference/cli/resources/chat/subresources/completions)。

### 4.1 普通文本请求与响应

```text
POST https://api.openai.com/v1/chat/completions
Authorization: Bearer $OPENAI_API_KEY
Content-Type: application/json
```

请求 JSON：

```json
{
  "model": "YOUR_OPENAI_MODEL_ID",
  "messages": [
    {
      "role": "developer",
      "content": "你是一个简洁的中文助手。"
    },
    {
      "role": "user",
      "content": "用一句话解释 SSE。"
    }
  ],
  "stream": false
}
```

简化响应：

```json
{
  "id": "chatcmpl_example_001",
  "object": "chat.completion",
  "created": 1788192000,
  "model": "YOUR_OPENAI_MODEL_ID",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "SSE 是服务器通过长连接持续向客户端推送事件的 HTTP 协议。",
        "refusal": null
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 20,
    "completion_tokens": 25,
    "total_tokens": 45
  }
}
```

### 4.2 流式文本

请求 JSON：

```json
{
  "model": "YOUR_OPENAI_MODEL_ID",
  "messages": [
    {
      "role": "user",
      "content": "用一句话解释 SSE。"
    }
  ],
  "stream": true,
  "stream_options": {
    "include_usage": true
  }
}
```

SSE body 是一连串 data-only 事件：

```text
data: {"id":"chatcmpl_example_002","object":"chat.completion.chunk","created":1788192000,"model":"YOUR_OPENAI_MODEL_ID","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl_example_002","object":"chat.completion.chunk","created":1788192000,"model":"YOUR_OPENAI_MODEL_ID","choices":[{"index":0,"delta":{"content":"SSE 是服务器"},"finish_reason":null}]}

data: {"id":"chatcmpl_example_002","object":"chat.completion.chunk","created":1788192000,"model":"YOUR_OPENAI_MODEL_ID","choices":[{"index":0,"delta":{"content":"持续推送事件的 HTTP 协议。"},"finish_reason":null}]}

data: {"id":"chatcmpl_example_002","object":"chat.completion.chunk","created":1788192000,"model":"YOUR_OPENAI_MODEL_ID","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: {"id":"chatcmpl_example_002","object":"chat.completion.chunk","created":1788192000,"model":"YOUR_OPENAI_MODEL_ID","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":20,"total_tokens":32}}

data: [DONE]
```

几个关键点：

- `delta.content` 是增量，必须按 `choices[].index` 累计。
- `finish_reason` 出现在某个 choice 的结束 chunk，而 `[DONE]` 是传输哨兵，两者不是同一层概念。
- 开启 `include_usage` 后，最终可能出现 `choices: []` 的用量 chunk；不要因为 choices 为空就丢弃它。
- 连接中断可能导致用量 chunk 和 `[DONE]` 缺失。

### 4.3 工具调用与参数分片

请求 JSON：

```json
{
  "model": "YOUR_OPENAI_MODEL_ID",
  "messages": [
    {
      "role": "user",
      "content": "上海现在天气怎么样？"
    }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "查询指定城市的当前天气",
        "parameters": {
          "type": "object",
          "properties": {
            "city": {
              "type": "string"
            }
          },
          "required": ["city"],
          "additionalProperties": false
        },
        "strict": true
      }
    }
  ],
  "tool_choice": "auto",
  "stream": true
}
```

关键流事件：

```text
data: {"id":"chatcmpl_example_003","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_example_003","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}

data: {"id":"chatcmpl_example_003","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"city\":"}}]},"finish_reason":null}]}

data: {"id":"chatcmpl_example_003","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"上海\"}"}}]},"finish_reason":null}]}

data: {"id":"chatcmpl_example_003","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}

data: [DONE]
```

工具调用必须通过 `tool_calls[].index` 关联分片。`id` 和 `function.name` 通常只在较早的分片中出现，后续分片可能只有 `arguments`。

执行工具后的下一次请求：

```json
{
  "model": "YOUR_OPENAI_MODEL_ID",
  "messages": [
    {
      "role": "user",
      "content": "上海现在天气怎么样？"
    },
    {
      "role": "assistant",
      "content": null,
      "tool_calls": [
        {
          "id": "call_example_003",
          "type": "function",
          "function": {
            "name": "get_weather",
            "arguments": "{\"city\":\"上海\"}"
          }
        }
      ]
    },
    {
      "role": "tool",
      "tool_call_id": "call_example_003",
      "content": "{\"temperature_c\":26,\"condition\":\"多云\"}"
    }
  ]
}
```

---

## 5. Anthropic Messages API

Anthropic 使用内容块数组表达文本、思考、工具调用和工具结果。`system` 是顶层字段，不存在输入消息的 `system` role。官方参考：[Create a Message](https://platform.claude.com/docs/en/api/messages/create) 与 [Streaming messages](https://platform.claude.com/docs/en/build-with-claude/streaming)。

### 5.1 普通文本请求与响应

```text
POST https://api.anthropic.com/v1/messages
x-api-key: $ANTHROPIC_API_KEY
anthropic-version: 2023-06-01
content-type: application/json
```

请求 JSON：

```json
{
  "model": "YOUR_CLAUDE_MODEL_ID",
  "system": "你是一个简洁的中文助手。",
  "messages": [
    {
      "role": "user",
      "content": "用一句话解释 SSE。"
    }
  ],
  "max_tokens": 256,
  "stream": false
}
```

简化响应：

```json
{
  "id": "msg_example_101",
  "type": "message",
  "role": "assistant",
  "model": "YOUR_CLAUDE_MODEL_ID",
  "content": [
    {
      "type": "text",
      "text": "SSE 是服务器通过长连接持续向客户端推送事件的 HTTP 协议。"
    }
  ],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 18,
    "output_tokens": 25
  }
}
```

常见 `stop_reason` 包括 `end_turn`、`max_tokens`、`stop_sequence` 和 `tool_use`；服务端工具还可能产生其他需要继续对话的原因，因此适配器应保留未知值。

### 5.2 流式文本、用量与思考块

请求加入：

```json
{
  "model": "YOUR_CLAUDE_MODEL_ID",
  "messages": [
    {
      "role": "user",
      "content": "用一句话解释 SSE。"
    }
  ],
  "max_tokens": 256,
  "stream": true
}
```

Anthropic 同时使用 SSE 的 `event:` 名称和 JSON 内部的 `type`：

```text
event: message_start
data: {"type":"message_start","message":{"id":"msg_example_102","type":"message","role":"assistant","content":[],"model":"YOUR_CLAUDE_MODEL_ID","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":18,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"SSE 是服务器"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"持续推送事件的 HTTP 协议。"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":25}}

event: message_stop
data: {"type":"message_stop"}
```

`message_delta.usage` 是累计值。流中还可能穿插 `ping` 和未来新增事件，未知事件必须安全忽略。

启用模型思考后，内容块可能是：

```text
event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"我需要先分析问题。"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"opaque-signature-fragment"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}
```

签名是不透明数据，应原样保存和传递，不能当作可显示文本或自行修改。

### 5.3 工具调用

请求 JSON：

```json
{
  "model": "YOUR_CLAUDE_MODEL_ID",
  "messages": [
    {
      "role": "user",
      "content": "上海现在天气怎么样？"
    }
  ],
  "tools": [
    {
      "name": "get_weather",
      "description": "查询指定城市的当前天气",
      "input_schema": {
        "type": "object",
        "properties": {
          "city": {
            "type": "string"
          }
        },
        "required": ["city"],
        "additionalProperties": false
      }
    }
  ],
  "tool_choice": {
    "type": "auto"
  },
  "max_tokens": 256
}
```

非流式工具调用响应：

```json
{
  "id": "msg_example_103",
  "type": "message",
  "role": "assistant",
  "model": "YOUR_CLAUDE_MODEL_ID",
  "content": [
    {
      "type": "text",
      "text": "我来查询一下。"
    },
    {
      "type": "tool_use",
      "id": "toolu_example_001",
      "name": "get_weather",
      "input": {
        "city": "上海"
      }
    }
  ],
  "stop_reason": "tool_use",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 75,
    "output_tokens": 22
  }
}
```

流式工具参数：

```text
event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_example_002","name":"get_weather","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"city\":"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"上海\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":22}}
```

应用执行工具后，必须把上一条 assistant 内容块完整放回历史，再追加包含 `tool_result` 的 user 消息：

```json
{
  "model": "YOUR_CLAUDE_MODEL_ID",
  "messages": [
    {
      "role": "user",
      "content": "上海现在天气怎么样？"
    },
    {
      "role": "assistant",
      "content": [
        {
          "type": "text",
          "text": "我来查询一下。"
        },
        {
          "type": "tool_use",
          "id": "toolu_example_001",
          "name": "get_weather",
          "input": {
            "city": "上海"
          }
        }
      ]
    },
    {
      "role": "user",
      "content": [
        {
          "type": "tool_result",
          "tool_use_id": "toolu_example_001",
          "content": "{\"temperature_c\":26,\"condition\":\"多云\"}"
        }
      ]
    }
  ],
  "max_tokens": 256
}
```

流中错误也是 SSE 事件，而不一定表现为非 2xx HTTP：

```text
event: error
data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}
```

---

## 6. Google Gemini generateContent API

Gemini 使用 `Content`/`Part` 两层结构。消息 role 通常是 `user` 或 `model`，文本、函数调用和函数结果都放在 `parts` 中。官方参考：[Generating content](https://ai.google.dev/api/generate-content)。

### 6.1 普通文本请求与响应

```text
POST https://generativelanguage.googleapis.com/v1beta/models/{MODEL_ID}:generateContent
x-goog-api-key: $GEMINI_API_KEY
Content-Type: application/json
```

请求 JSON：

```json
{
  "systemInstruction": {
    "parts": [
      {
        "text": "你是一个简洁的中文助手。"
      }
    ]
  },
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "用一句话解释 SSE。"
        }
      ]
    }
  ],
  "generationConfig": {
    "maxOutputTokens": 256,
    "temperature": 0.3
  }
}
```

简化响应：

```json
{
  "candidates": [
    {
      "content": {
        "role": "model",
        "parts": [
          {
            "text": "SSE 是服务器通过长连接持续向客户端推送事件的 HTTP 协议。"
          }
        ]
      },
      "finishReason": "STOP",
      "index": 0,
      "safetyRatings": []
    }
  ],
  "usageMetadata": {
    "promptTokenCount": 18,
    "candidatesTokenCount": 25,
    "totalTokenCount": 43
  },
  "modelVersion": "YOUR_GEMINI_MODEL_VERSION",
  "responseId": "response_example_201"
}
```

不要只读取 `candidates[0].content.parts[0].text`：候选可能因为安全策略没有正文，parts 也可能包含函数调用、思考签名或其他模态。

### 6.2 SSE 流式文本

流式端点在方法名和查询参数上不同：

```text
POST https://generativelanguage.googleapis.com/v1beta/models/{MODEL_ID}:streamGenerateContent?alt=sse
x-goog-api-key: $GEMINI_API_KEY
Content-Type: application/json
```

请求 body 与 `generateContent` 相同。返回为 data-only SSE；每个 data 是一个 `GenerateContentResponse` 片段：

```text
data: {"candidates":[{"content":{"role":"model","parts":[{"text":"SSE 是服务器"}]},"index":0}],"modelVersion":"YOUR_GEMINI_MODEL_VERSION","responseId":"response_example_202"}

data: {"candidates":[{"content":{"role":"model","parts":[{"text":"持续推送事件的 HTTP 协议。"}]},"index":0,"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":20,"totalTokenCount":32},"modelVersion":"YOUR_GEMINI_MODEL_VERSION","responseId":"response_example_202"}
```

Gemini REST SSE 没有 OpenAI 风格的 `[DONE]`。最后一个响应片段通常携带 `finishReason` 和用量，随后连接结束；实现仍应区分“收到了合法终态”和“网络意外断开”。

### 6.3 函数调用

请求 JSON：

```json
{
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "上海现在天气怎么样？"
        }
      ]
    }
  ],
  "tools": [
    {
      "functionDeclarations": [
        {
          "name": "get_weather",
          "description": "查询指定城市的当前天气",
          "parameters": {
            "type": "object",
            "properties": {
              "city": {
                "type": "string"
              }
            },
            "required": ["city"]
          }
        }
      ]
    }
  ],
  "toolConfig": {
    "functionCallingConfig": {
      "mode": "AUTO"
    }
  }
}
```

函数调用响应：

```json
{
  "candidates": [
    {
      "content": {
        "role": "model",
        "parts": [
          {
            "functionCall": {
              "id": "call_example_201",
              "name": "get_weather",
              "args": {
                "city": "上海"
              }
            }
          }
        ]
      },
      "finishReason": "STOP",
      "index": 0
    }
  ],
  "usageMetadata": {
    "promptTokenCount": 60,
    "candidatesTokenCount": 12,
    "totalTokenCount": 72
  }
}
```

这里的 `args` 已经是对象，不要再次把它当 JSON 字符串拼接。

执行工具后的请求要保留模型的函数调用 part，再追加函数结果：

```json
{
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "上海现在天气怎么样？"
        }
      ]
    },
    {
      "role": "model",
      "parts": [
        {
          "functionCall": {
            "id": "call_example_201",
            "name": "get_weather",
            "args": {
              "city": "上海"
            }
          }
        }
      ]
    },
    {
      "role": "user",
      "parts": [
        {
          "functionResponse": {
            "id": "call_example_201",
            "name": "get_weather",
            "response": {
              "temperature_c": 26,
              "condition": "多云"
            }
          }
        }
      ]
    }
  ]
}
```

某些模型会在 part 上附带不透明的思考签名。进行多轮或工具回传时应原样保留厂商要求的签名字段。

---

## 7. DeepSeek Chat Completions

DeepSeek 的核心接口沿用 OpenAI Chat Completions 形状，官方参考：[Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/)。但“兼容”不代表字段全集、结束原因和模型能力完全相同。

```text
POST https://api.deepseek.com/chat/completions
Authorization: Bearer $DEEPSEEK_API_KEY
Content-Type: application/json
```

请求 JSON：

```json
{
  "model": "deepseek-chat",
  "messages": [
    {
      "role": "system",
      "content": "你是一个简洁的中文助手。"
    },
    {
      "role": "user",
      "content": "用一句话解释 SSE。"
    }
  ],
  "stream": true,
  "stream_options": {
    "include_usage": true
  }
}
```

思考模型的流式 choice 可能额外包含 `reasoning_content`，正文仍在 `content`：

```text
data: {"id":"example_301","object":"chat.completion.chunk","model":"YOUR_DEEPSEEK_MODEL_ID","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"我需要先定义 SSE。","content":null},"finish_reason":null}]}

data: {"id":"example_301","object":"chat.completion.chunk","model":"YOUR_DEEPSEEK_MODEL_ID","choices":[{"index":0,"delta":{"reasoning_content":null,"content":"SSE 是服务器持续推送事件的 HTTP 协议。"},"finish_reason":null}]}

data: {"id":"example_301","object":"chat.completion.chunk","model":"YOUR_DEEPSEEK_MODEL_ID","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

DeepSeek 还定义了 `insufficient_system_resource` 等扩展结束原因。适配器应把未知原始原因映射到中立的 `other` 或 `error`，同时保留原始值用于诊断。

---

## 8. Mistral Chat Completions

Mistral 也提供 OpenAI 风格的 `/v1/chat/completions`，支持 `messages`、`tools`、`tool_calls` 和 data-only SSE。官方参考：[Mistral Chat API](https://docs.mistral.ai/api)。

```text
POST https://api.mistral.ai/v1/chat/completions
Authorization: Bearer $MISTRAL_API_KEY
Content-Type: application/json
```

请求 JSON：

```json
{
  "model": "mistral-large-latest",
  "messages": [
    {
      "role": "user",
      "content": "上海现在天气怎么样？"
    }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "查询指定城市的当前天气",
        "parameters": {
          "type": "object",
          "properties": {
            "city": {
              "type": "string"
            }
          },
          "required": ["city"]
        }
      }
    }
  ],
  "tool_choice": "auto",
  "parallel_tool_calls": true,
  "stream": true
}
```

典型流事件仍是 OpenAI 风格：

```text
data: {"id":"example_401","object":"chat.completion.chunk","model":"mistral-large-latest","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_example_401","type":"function","function":{"name":"get_weather","arguments":"{\"city\":\"上海\"}"}}]},"finish_reason":null}]}

data: {"id":"example_401","object":"chat.completion.chunk","model":"mistral-large-latest","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}

data: [DONE]
```

Mistral 还支持 `tool_choice: "any"`、数组形式的多类型 content 和厂商自己的工具。只应在实际响应中按判别字段处理，不能把类型强制收窄成 OpenAI 文本字符串。

---

## 9. 常见错误响应

错误发生在两层：HTTP 非 2xx 响应，以及已经建立流以后出现的协议内错误事件。应用必须分别处理。

### 9.1 OpenAI 风格

```json
{
  "error": {
    "message": "Invalid API key",
    "type": "invalid_request_error",
    "param": null,
    "code": "invalid_api_key"
  }
}
```

第三方兼容服务可能省略或更改其中字段，因此不要直接把整份错误 body 透传到界面或日志；它可能包含敏感请求信息。

### 9.2 Anthropic 风格

```json
{
  "type": "error",
  "error": {
    "type": "authentication_error",
    "message": "invalid x-api-key"
  },
  "request_id": "req_example_001"
}
```

### 9.3 Google RPC 风格

```json
{
  "error": {
    "code": 400,
    "message": "Invalid request payload.",
    "status": "INVALID_ARGUMENT",
    "details": []
  }
}
```

生产代码应把这些结构归一化为稳定的本地错误码，例如鉴权、权限、限流、超时、服务器错误、无效响应和用户取消；原始 message 仅用于经过脱敏的诊断。

---

## 10. 映射到 Axon 中立流协议

Axon 的 SSE 解析层只负责把字节流转换成 `{ event, data, id, retry }`，然后由各 Provider 适配器进行以下转换：

| 厂商原始数据 | Axon 中立事件 |
| --- | --- |
| OpenAI Chat `delta.content` | `text_delta` |
| OpenAI Responses `response.output_text.delta` | `text_delta` |
| Anthropic `text_delta.text` | `text_delta` |
| Gemini `parts[].text` | `text_delta` |
| Anthropic `thinking_delta` / DeepSeek `reasoning_content` | `reasoning_delta` |
| Anthropic `signature_delta` | `reasoning_signature` |
| OpenAI `tool_calls[].index` / Responses `call_id` | `tool_call_start/delta/end` |
| Anthropic `tool_use` + `partial_json` | `tool_call_start/delta/end` |
| Gemini `functionCall` | 一次性展开成 `tool_call_start/delta/end` |
| 各厂商 token usage | `usage` 累计快照 |
| 各厂商 stop/finish/status | `finish` + 中立 reason |

一个理想化的中立事件序列如下：

```json
[
  {
    "type": "tool_call_start",
    "callKey": "0",
    "callId": "call_example_001",
    "name": "get_weather"
  },
  {
    "type": "tool_call_delta",
    "callKey": "0",
    "argumentsDelta": "{\"city\":"
  },
  {
    "type": "tool_call_delta",
    "callKey": "0",
    "argumentsDelta": "\"上海\"}"
  },
  {
    "type": "tool_call_end",
    "callKey": "0"
  },
  {
    "type": "usage",
    "usage": {
      "inputTokens": 80,
      "outputTokens": 16,
      "totalTokens": 96
    }
  },
  {
    "type": "finish",
    "reason": "tool_use",
    "providerReason": "tool_calls"
  }
]
```

这样 Chat 编排层只认识一套事件，不需要知道原始数据来自哪家厂商。

## 11. 实现时必须防守的边界

1. SSE 可能在任意字节位置切分，包括一个中文 UTF-8 字符中间，不能直接对每个网络 chunk 独立转字符串。
2. 一个网络 chunk 可能包含多个 SSE 事件，一个 SSE 事件也可能跨多个网络 chunk。
3. 工具参数字符串在结束前通常不是合法 JSON；只累计，不提前执行。
4. 同一轮可能并行产生多个工具调用，必须按 index、block index、item ID 或 call ID 分别累计。
5. 工具 ID、名称、finish reason 和 usage 不保证与正文出现在同一事件。
6. 未知事件和未知结束原因应可诊断但不能让解析器崩溃；协议会增加新事件。
7. 收到 HTTP 200 不等于生成成功，SSE 中仍可能出现 error/failed/incomplete。
8. 网络 EOF 不等于合法 finish；只有收到厂商终态后才能提交完整 assistant 消息。
9. 工具参数必须做 JSON 解析、Schema 校验、权限确认和大小限制，不能信任模型输出。
10. 不要记录 API Key、Authorization header、完整敏感提示词或未经脱敏的错误 body。

## 12. 官方资料入口

- [OpenAI Responses API](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/responses/methods/create)
- [OpenAI Chat Completions API](https://developers.openai.com/api/reference/cli/resources/chat/subresources/completions)
- [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages/create)
- [Anthropic Streaming Messages](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Google Gemini generateContent](https://ai.google.dev/api/generate-content)
- [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)
- [Mistral Chat API](https://docs.mistral.ai/api)

## 13. Axon 一次 Chat 的完整数据流（OpenAI Chat 格式）

本节对应当前已经过真实 Electron + 本地 SSE 冒烟验证的实现。先看完整主线：

```text
TipTap → ChatInput → ChatRendererController → preload → Chat IPC
  → ChatService → ChannelManager / ConversationManager
  → Provider 请求编码 → fetch → SSE 解析 → OpenAI 适配器
  → 中立流事件 → 定向 IPC → Jotai 流式草稿 → ChatMessages
  → assistant 终态 JSONL → 消息回读 → Markdown / Shiki
```

### 13.1 每层只负责什么

| 层 | 输入 | 处理 | 输出/下游 |
| --- | --- | --- | --- |
| `RichTextInput` / `ChatInput` | 用户富文本操作 | 转成 Markdown，检查空白、长度、模型与生成状态 | `ChatSendInput` |
| `ChatRendererController` | `ChatSendInput` | 管理发送状态、订阅流事件、终态后回读磁盘 | preload Chat API / Jotai |
| preload + Chat IPC | renderer 不可信参数 | contextBridge 隔离、主框架校验、负载校验、窗口所有权 | `ChatIpcController` |
| `ChatService` | 已校验的发送参数 | 解析渠道、用户消息预落盘、构造历史、累计流、保存助手终态 | Provider 层 / JSONL / Chat 事件 |
| Provider 请求层 | 中立 `ProviderStreamRequest` | 生成 URL/header/body，执行 fetch，解析 SSE | 供应商 adapter |
| OpenAI Chat adapter | 原始 SSE JSON | 把正文、工具、用量、结束原因转成中立事件 | `ChatService` 与 renderer |
| `ChatMessages` | JSONL 消息 + 内存 generation | 合并完整历史和流式草稿 | Markdown/GFM/Shiki 消息列表 |

这些边界的关键价值是：renderer 不接触 API Key，Provider adapter 不读取会话文件，消息组件也不知道供应商协议。

### 13.2 从富文本输入到 IPC

假设用户在 TipTap 中把“第一轮请求”设为粗体。编辑器对外输出的是 Markdown：

```json
{
  "editorMarkdown": "**第一轮请求**"
}
```

`ChatInput` 校验后调用控制器，跨 IPC 的负载只有业务字段：

```json
{
  "conversationId": "conversation_example_001",
  "text": "**第一轮请求**"
}
```

实际调用关系：

```text
ChatInput.send
  → ChatRendererController.send
  → window.axon.chat.send
  → ipcRenderer.invoke("axon:chat:send", input)
  → ipcMain handler
  → ChatIpcController.send
```

这里同时存在两条异步通道：

1. `invoke("axon:chat:send")` 会一直等待整轮生成结束，最终返回成功或稳定错误。
2. `axon:chat:event` 在等待期间持续推送 `started → stream* → completed/stopped/failed`，负责即时更新界面。

因此，不能等 `send()` Promise 完成后才显示 token；那样会把流式请求退化成非流式体验。

### 13.3 主进程先落用户消息，再构造请求

`ChatService` 先通过会话元数据找到 `channelId + modelId`，再由 `ChannelManager.resolve()` 在主进程解密凭据。renderer 看到的渠道 DTO 只有：

```json
{
  "id": "channel_example_001",
  "name": "OpenAI 主渠道",
  "provider": "openai",
  "baseUrl": "https://api.openai.com/v1",
  "hasApiKey": true,
  "models": [
    {
      "id": "YOUR_OPENAI_MODEL_ID",
      "name": "主模型",
      "enabled": true
    }
  ],
  "enabled": true
}
```

明文和密文凭据都不会进入 renderer DTO。

目标可用后，用户消息先写入 JSONL，然后发出 `started`：

```json
{
  "type": "started",
  "conversationId": "conversation_example_001",
  "generationId": "generation_example_001",
  "assistantMessageId": "message_assistant_001",
  "userMessage": {
    "id": "message_user_001",
    "role": "user",
    "content": [
      {
        "type": "text",
        "text": "**第一轮请求**"
      }
    ],
    "createdAt": 1788624000000,
    "status": "complete"
  }
}
```

这样即使随后断网，用户输入也能在重开应用后恢复。请求历史只从刚落盘并重新校验过的消息构造，不直接信任 renderer 的消息列表。

### 13.4 最终发给 OpenAI Chat API 的 HTTP 内容

URL 和请求头由 Provider 请求层统一生成：

```text
POST https://api.openai.com/v1/chat/completions
Authorization: Bearer <仅主进程可见的 API Key>
Accept: text/event-stream
Content-Type: application/json
User-Agent: Axon/<版本号>
```

第一轮请求体：

```json
{
  "model": "YOUR_OPENAI_MODEL_ID",
  "messages": [
    {
      "role": "user",
      "content": "**第一轮请求**"
    }
  ],
  "stream": true,
  "stream_options": {
    "include_usage": true
  },
  "max_completion_tokens": 4096
}
```

若渠道类型是自定义 OpenAI Chat 兼容服务，结构相同，但为了兼容更多旧服务，输出长度字段使用：

```json
{
  "max_tokens": 4096
}
```

请求层强制 `redirect: "manual"`，限制请求体大小和总生成时间；API Key 只进入 header，不进入 URL、日志或错误消息。

### 13.5 从供应商 SSE 到中立事件

供应商可能分三帧返回 Markdown 正文：

```text
data: {"id":"chatcmpl_example_001","choices":[{"index":0,"delta":{"content":"## 流式回答\n\n"},"finish_reason":null}]}

data: {"id":"chatcmpl_example_001","choices":[{"index":0,"delta":{"content":"| 项目 | 状态 |\n| --- | --- |\n| Chat | 正常 |\n\n"},"finish_reason":null}]}

data: {"id":"chatcmpl_example_001","choices":[{"index":0,"delta":{"content":"```ts\nconst value = 42\n```"},"finish_reason":null}]}

data: {"id":"chatcmpl_example_001","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: {"id":"chatcmpl_example_001","choices":[],"usage":{"prompt_tokens":8,"completion_tokens":16,"total_tokens":24}}

data: [DONE]
```

`sse-parser` 先解决任意网络分片、UTF-8、多行 data 和取消；OpenAI Chat adapter 再输出供应商无关事件：

```json
[
  {
    "type": "text_delta",
    "delta": "## 流式回答\n\n"
  },
  {
    "type": "text_delta",
    "delta": "| 项目 | 状态 |\n| --- | --- |\n| Chat | 正常 |\n\n"
  },
  {
    "type": "text_delta",
    "delta": "```ts\nconst value = 42\n```"
  },
  {
    "type": "usage",
    "usage": {
      "inputTokens": 8,
      "outputTokens": 16,
      "totalTokens": 24
    }
  },
  {
    "type": "finish",
    "reason": "stop",
    "providerReason": "stop"
  }
]
```

每个事件被 ChatService 包成带会话和 generation 身份的 IPC 事件：

```json
{
  "type": "stream",
  "conversationId": "conversation_example_001",
  "generationId": "generation_example_001",
  "event": {
    "type": "text_delta",
    "delta": "## 流式回答\n\n"
  }
}
```

`generationId` 不匹配的迟到事件会被 renderer reducer 丢弃，旧请求不能污染后续生成。

### 13.6 流式草稿如何进入消息列表

`started` 到达后，renderer 立即把用户消息加入列表，并创建一个仅在内存中的助手 generation：

```json
{
  "messagesByConversation": {
    "conversation_example_001": [
      {
        "id": "message_user_001",
        "role": "user",
        "content": [
          {
            "type": "text",
            "text": "**第一轮请求**"
          }
        ],
        "createdAt": 1788624000000,
        "status": "complete"
      }
    ]
  },
  "generationsByConversation": {
    "conversation_example_001": {
      "conversationId": "conversation_example_001",
      "generationId": "generation_example_001",
      "assistantMessageId": "message_assistant_001",
      "blocks": [
        {
          "type": "text",
          "text": "## 流式回答\n\n| 项目 | 状态 |"
        }
      ]
    }
  },
  "sendingByConversation": {
    "conversation_example_001": true
  }
}
```

`ChatMessages` 按下面的方式组合，而不是把未完成内容假装成完整历史：

```text
已落盘 messages
+ 当前 generation 流式草稿
= 用户眼前的消息列表
```

正文块由 `react-markdown + remark-gfm` 渲染；围栏代码交给 Shiki。原始 HTML不执行，危险链接被过滤，远程图片降级为普通链接。

### 13.7 完成后用 JSONL 替换内存草稿

只有 adapter 收到合法终态、ChatService 验证所有内容块已经闭合后，助手消息才以 `complete` 写入 JSONL：

```json
{
  "id": "message_assistant_001",
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "## 流式回答\n\n| 项目 | 状态 |\n| --- | --- |\n| Chat | 正常 |\n\n```ts\nconst value = 42\n```"
    }
  ],
  "createdAt": 1788624001200,
  "status": "complete",
  "modelId": "YOUR_OPENAI_MODEL_ID",
  "finishReason": "stop",
  "usage": {
    "inputTokens": 8,
    "outputTokens": 16,
    "totalTokens": 24
  }
}
```

随后发出 `completed` 事件：

```json
{
  "type": "completed",
  "conversationId": "conversation_example_001",
  "generationId": "generation_example_001",
  "message": {
    "id": "message_assistant_001",
    "role": "assistant",
    "content": [
      {
        "type": "text",
        "text": "## 流式回答\n\n..."
      }
    ],
    "createdAt": 1788624001200,
    "status": "complete",
    "modelId": "YOUR_OPENAI_MODEL_ID",
    "finishReason": "stop"
  }
}
```

renderer 删除对应 generation 和 sending 状态，插入终态消息，并通过 `getMessages` 再读一次 JSONL。即使某个流事件漏失或 renderer 中途重载，磁盘快照仍是最终真相。

磁盘中的文件实际上是“一行一条 JSON”，而不是一个 JSON 数组：

```jsonl
{"id":"message_user_001","role":"user","content":[{"type":"text","text":"**第一轮请求**"}],"createdAt":1788624000000,"status":"complete"}
{"id":"message_assistant_001","role":"assistant","content":[{"type":"text","text":"## 流式回答\n\n..."}],"createdAt":1788624001200,"status":"complete","modelId":"YOUR_OPENAI_MODEL_ID","finishReason":"stop","usage":{"inputTokens":8,"outputTokens":16,"totalTokens":24}}
```

### 13.8 第二轮请求如何携带历史

用户继续发送“第二轮问题”时，ChatService 重新读取 JSONL，并编码为：

```json
{
  "model": "YOUR_OPENAI_MODEL_ID",
  "messages": [
    {
      "role": "user",
      "content": "**第一轮请求**"
    },
    {
      "role": "assistant",
      "content": "## 流式回答\n\n| 项目 | 状态 |\n| --- | --- |\n| Chat | 正常 |\n\n```ts\nconst value = 42\n```"
    },
    {
      "role": "user",
      "content": "第二轮问题"
    }
  ],
  "stream": true,
  "stream_options": {
    "include_usage": true
  },
  "max_completion_tokens": 4096
}
```

只有完整的助手消息会回送给模型。`stopped` 或 `error` 的局部助手输出会保留在本地用于展示和审计，但不会污染下一轮上下文。

### 13.9 停止、失败和窗口销毁

用户点击停止时：

```text
ChatInput.stop
  → axon:chat:stop
  → renderer owner 校验
  → ChatService.stopGeneration
  → AbortSignal
  → fetch / SSE reader 取消
  → partial assistant 以 stopped 写入 JSONL
  → stopped 事件替换流式草稿
```

停止后的助手终态示例：

```json
{
  "id": "message_assistant_002",
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "这是一段会被停止的内容"
    }
  ],
  "createdAt": 1788624002400,
  "status": "stopped",
  "modelId": "YOUR_OPENAI_MODEL_ID",
  "finishReason": "other"
}
```

主要失败边界：

- 同一会话只允许一个 active generation；第二次发送返回 `already_active`。
- 只有发起生成的 renderer owner 可以停止；其他窗口不能越权取消。
- renderer 重载、崩溃或销毁会取消它拥有的生成，避免向失效窗口继续投递。
- 用户消息落盘失败时不会联网；联网后失败则尽量写入 `error` 助手终态。
- HTTP 200、自然 EOF、半截工具参数都不算成功；必须经过 adapter 合法终态校验。
- SSE reader 的底层取消 Promise 即使拒绝，也不能制造未处理 rejection 或覆盖统一的 `cancelled` 语义。

### 13.10 当前工具调用边界

四种 adapter 已能把工具调用映射为 `tool_call_start/delta/end`，ChatService 也能累计并保存完整工具调用块。但是当前 Chat MVP 不执行工具，也不自动发起“工具结果 → 模型”的下一次请求。工具注册、权限、执行和多轮工具循环属于后续 Chat 工具阶段。

### 13.11 本链路如何验证

可在 `apps/electron` 目录执行：

```text
bun run test:chat:smoke
```

该测试使用临时目录、虚构密钥和仅监听 `127.0.0.1` 的 SSE 服务，真实运行 Electron main、preload、renderer、IPC、Provider fetch 和 JSONL。当前覆盖：

- 渠道与默认模型选择、会话创建和改名。
- TipTap 粗体转 Markdown，并验证最终 HTTP 请求体。
- 正文分片、usage 和终态适配。
- GFM 表格、Shiki 高亮、代码复制和整条消息复制。
- 第二轮请求历史顺序。
- AbortSignal 停止及局部助手消息落盘。
- renderer 重载后从 settings + JSONL 恢复对话。

---

## 14. Axon 一次 Agent 对话的模型调用、工具循环与错误恢复

Agent 和普通 Chat 的最大区别是：一条用户消息可能在同一轮内发生多次模型 API 调用。模型先请求工具，runtime 执行后把 `tool_result` 加回上下文，再请求模型继续。

### 14.1 完整模块链路

```text
AgentInput
  → AgentRendererController
  → preload / Agent IPC
  → AgentService
  → ChannelManager + AgentSessionManager + AgentProjectManager
  → AgentProviderAdapter
  → Agent Runtime
  → Provider HTTP/SSE API
  → runtime 工具循环/自动重试
  → SDKMessage + delta + retry_status
  → AgentService 持久化/广播
  → Jotai 流式草稿
  → AgentMessages
```

各层边界：

| 层 | 输入 | 处理 | 下游 |
| --- | --- | --- | --- |
| renderer | `sessionId + text` | 展示输入与运行状态 | IPC |
| AgentService | 已校验输入 | 用户消息预落盘、解析渠道/项目工作区、消费 adapter 流 | adapter、JSONL、事件总线 |
| adapter | 中立 `AgentQueryInput` | 创建或恢复 runtime 会话，转换消息、错误和重试事件 | runtime / AgentService |
| runtime | prompt、历史、工具 | 多次调用模型、执行工具、压缩、模型调用级自动重试 | Provider API / adapter |
| Provider | 厂商协议 JSON | 流式生成正文、推理和工具调用 | runtime |

### 14.2 renderer 到主进程的输入

renderer 只发送业务标识与本次文本：

```json
{
  "sessionId": "agent_session_001",
  "text": "读取 package.json，并告诉我应用名称。"
}
```

主进程解析会话后构造中立查询。下面是便于理解的等价 JSON；真实对象还包含不可 JSON 化的 `AbortSignal`、权限回调和 runtime 会话回调：

```json
{
  "sessionId": "agent_session_001",
  "prompt": "读取 package.json，并告诉我应用名称。",
  "model": "YOUR_OPENAI_MODEL_ID",
  "cwd": "/absolute/project/workspace",
  "connection": {
    "provider": "openai",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "仅存在于主进程内"
  },
  "systemPrompt": "你是 Axon Agent……",
  "permissionMode": "default",
  "resumeSessionId": "runtime_session_001",
  "runtimeSessionFile": "/absolute/runtime/session.jsonl"
}
```

项目工作区来自 `session.projectId → project.workspace`，renderer 不能直接向 Agent 查询注入任意 `cwd`；API Key 同样不会跨到 renderer。

### 14.3 OpenAI Chat 格式下的两次模型请求

第一次请求携带用户消息和工具定义：

```json
{
  "model": "YOUR_OPENAI_MODEL_ID",
  "messages": [
    {
      "role": "system",
      "content": "你是 Axon Agent……"
    },
    {
      "role": "user",
      "content": "读取 package.json，并告诉我应用名称。"
    }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "read",
        "description": "读取工作区文件",
        "parameters": {
          "type": "object",
          "properties": {
            "path": { "type": "string" }
          },
          "required": ["path"]
        }
      }
    }
  ],
  "stream": true
}
```

模型返回工具调用后，runtime 先经过权限判断，再执行工具。第二次请求不是新用户轮次，而是在同一轮上下文末尾加入 assistant 工具调用与工具结果：

```json
{
  "model": "YOUR_OPENAI_MODEL_ID",
  "messages": [
    {
      "role": "system",
      "content": "你是 Axon Agent……"
    },
    {
      "role": "user",
      "content": "读取 package.json，并告诉我应用名称。"
    },
    {
      "role": "assistant",
      "content": null,
      "tool_calls": [
        {
          "id": "call_read_001",
          "type": "function",
          "function": {
            "name": "read",
            "arguments": "{\"path\":\"package.json\"}"
          }
        }
      ]
    },
    {
      "role": "tool",
      "tool_call_id": "call_read_001",
      "content": "{\"name\":\"@axon/electron\"}"
    }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "read",
        "description": "读取工作区文件",
        "parameters": {
          "type": "object",
          "properties": {
            "path": { "type": "string" }
          },
          "required": ["path"]
        }
      }
    }
  ],
  "stream": true
}
```

第二次响应的正文最终转换为完整 `SDKAssistantMessage`。工具调用、工具结果和最终回答会进入 Axon JSONL；流式 delta 只存在于内存。

### 14.4 模型 API 临时失败时的 runtime 事件

假设工具已经成功读取文件，但第二次模型请求遇到 503。runtime 的概念事件序列为：

```json
[
  {
    "type": "message_end",
    "message": {
      "role": "assistant",
      "stopReason": "error",
      "errorMessage": "503 service unavailable"
    }
  },
  {
    "type": "agent_end",
    "willRetry": true
  },
  {
    "type": "auto_retry_start",
    "attempt": 1,
    "maxAttempts": 3,
    "delayMs": 2000,
    "errorMessage": "503 service unavailable"
  }
]
```

`errorMessage` 是 adapter 内部的 runtime 数据，不会直接进入 renderer 或 Axon JSONL。adapter 输出的中立瞬时状态为：

```json
{
  "kind": "retry_status",
  "status": {
    "phase": "scheduled",
    "attempt": 1,
    "maxAttempts": 3,
    "delayMs": 2000,
    "discardedAssistantUuid": "assistant_failed_draft_001"
  }
}
```

renderer 据此删除失败的流式草稿，并显示“模型请求暂时失败，2.0 秒后自动重试（1/3）”。该状态不落盘。

runtime 重试时只移除失败 assistant，保留此前已经提交的 `tool_result`，然后执行 `continue()`。因此上例中的 `read` 不会再次执行；新的模型请求直接携带已经得到的文件内容。

默认语义重试最多 3 次，退避为 2、4、8 秒。每当某次模型调用成功时，计数清零，所以下一处独立的模型请求错误重新从第 1 次开始计算。当前没有叠加低层 Provider 请求重试，避免两层次数相乘。

### 14.5 为什么只有 `agent_settled` 能生成 result

一次用户轮次中，`agent_end` 可能因自动重试或上下文压缩续跑而出现多次；它只表示某一段 agent loop 结束。最终 `agent_settled` 才表示 prompt、工具循环、自动重试和压缩恢复全部结束。

```text
agent_end(willRetry=true)
  → auto_retry_start
  → continue
  → agent_end(willRetry=false)
  → agent_settled
  → 唯一 SDKResultMessage
```

成功 result 示例：

```json
{
  "type": "result",
  "subtype": "success",
  "usage": {
    "input_tokens": 4200,
    "output_tokens": 180,
    "cache_read_input_tokens": 1200,
    "cache_creation_input_tokens": 0
  },
  "total_cost_usd": 0.012,
  "terminal_reason": "completed",
  "session_id": "runtime_session_001"
}
```

这里的 usage 累计本轮所有 prompt/continue 段，包括已经计费用量的失败模型调用；但整轮只有一个 result。

### 14.6 重试耗尽与不可重试错误

重试耗尽后的 503 会转换为稳定错误，不保存原始 Provider body：

```json
{
  "type": "result",
  "subtype": "error_during_execution",
  "usage": {
    "input_tokens": 4200,
    "output_tokens": 0
  },
  "terminal_reason": "failed",
  "errors": ["模型服务暂时不可用，自动重试后仍未恢复"],
  "error": {
    "code": "provider_unavailable",
    "category": "provider",
    "message": "模型服务暂时不可用，自动重试后仍未恢复",
    "retryable": true
  },
  "session_id": "runtime_session_001"
}
```

认证错误不会等待重试：

```json
{
  "code": "provider_authentication_error",
  "category": "configuration",
  "message": "模型服务认证或访问权限无效，请检查渠道配置",
  "retryable": false
}
```

当前最终分类包括：

| 类型 | code | runtime 自动重试 |
| --- | --- | --- |
| 网络、DNS、超时、流提前结束 | `network_error` | 是 |
| 429、限流、节流 | `provider_rate_limited` | 是 |
| 5xx、过载、服务不可用 | `provider_unavailable` | 是 |
| API Key、401/403、访问权限 | `provider_authentication_error` | 否 |
| 额度、余额、账单 | `provider_quota_exhausted` | 否 |
| 模型不存在或无权访问 | `provider_model_not_found` | 否 |
| 404、服务地址或路由不存在 | `provider_endpoint_not_found` | 否 |
| 内容/安全策略拒绝 | `provider_content_rejected` | 否 |
| 请求参数或协议不兼容 | `provider_request_invalid` | 否 |
| 上下文超限且压缩恢复失败 | `context_overflow` | 否 |
| 无法解析 Provider 响应 | `protocol_error` | 否 |

### 14.7 最终的 JSONL 与消息列表

一次“工具成功 → 模型 503 → 自动重试成功”的 Axon JSONL 概念结果如下：

```jsonl
{"type":"user","message":{"content":[{"type":"text","text":"读取 package.json，并告诉我应用名称。"}]},"parent_tool_use_id":null,"uuid":"user_001"}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"call_read_001","name":"Read","input":{"file_path":"package.json"}}]},"parent_tool_use_id":null,"uuid":"assistant_tool_001"}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"call_read_001","content":"{\"name\":\"@axon/electron\"}","is_error":false}]},"parent_tool_use_id":null,"uuid":"tool_result_001"}
{"type":"assistant","message":{"content":[{"type":"text","text":"应用名称是 @axon/electron。"}]},"parent_tool_use_id":null,"uuid":"assistant_final_001"}
{"type":"result","subtype":"success","usage":{"input_tokens":4200,"output_tokens":180},"terminal_reason":"completed","session_id":"runtime_session_001"}
```

其中不会出现：

- 503 的失败 assistant。
- `retry_status`。
- 第二份用户消息。
- 重复的工具调用或工具结果。
- 中间 `agent_end` 对应的多个 result。

renderer 在运行时把完整 JSONL 消息与内存 delta 合并；自动重试时移除失败草稿；`run_finished` 后重新读取 JSONL 校准。因此窗口重载后只能看到稳定历史，不会恢复出“重试中”或中间失败状态。

### 14.8 主要失败边界

- 用户消息必须先成功写入 Axon JSONL，才允许创建模型请求。
- 工具权限拒绝以工具错误结果回给模型，不等同于 Provider 请求失败。
- Provider 错误只由 runtime 在当前模型调用位置自动恢复；AgentService 不重投原始用户 prompt。
- 认证、额度、参数、内容策略与上下文错误不会套用网络/5xx 重试。
- 上下文超限走 runtime 压缩恢复，不占用普通 Provider 重试预算。
- 上下文超限的失败 assistant 会一直暂存到 `agent_settled`；如果 runtime 开始 overflow 压缩，adapter 只发送 `discard_assistant` 清理 UI 草稿，不把该错误写入 JSONL。
- 用户在退避等待中停止时，最终结果强制为 `terminal_reason: "stopped"`。
- 用户在 runtime 初始化完成前停止时，adapter 直接输出 stopped result，且不会在 abort 之后继续调用 `prompt()` 或发起 Provider 请求。
- adapter/runtime 初始化异常归为不可重试的 runtime 错误，不能伪装成 Provider 抖动。
- 任何 API Key、Authorization、完整错误 body 和未经脱敏的 `errorMessage` 都不得进入 renderer、JSONL 或普通日志。
