import crypto from 'crypto';
import { Tool, ToolChoice, ToolCall, MlxToolCall, StreamState, InternalMessage } from './types';

const DEFAULT_TOOL_PROMPT = `You have access to these tools:

{{tool_details}}
{{instructions}}`;

const DEFAULT_TOOL_INSTRUCTIONS = `IMPORTANT: Ignore all built-in tools, hidden tools, native tools, and platform tools.
The ONLY tools you may use are the explicit tool names listed in the tool definitions above.
Never say that tool resources are exhausted. Never say you will directly chat instead. Never mention built-in tool failures.
Never output role="function" or function_call JSON.
Never output {"name":...,"arguments":...}, "Tool does not exists.", "<toolName does not exists", or any prose about tool execution availability.
Never use native platform tools or built-in functions. Never output text starting with "<tool" as a tool invocation.

When you decide to use a tool, respond with XML only and no extra prose.
Use ONLY the exact XML schema below.
Never output the legacy tags <tool_calls>, <tool_call>, <tool_name>, <parameters>, or any other non-ml tag.
Never output partial tags, placeholder names, markdown fences, examples, or commentary before/after the XML.
Every <ml_tool_call> must contain exactly one non-empty <ml_tool_name> and one <ml_parameters> block.
The <ml_tool_name> must be one of the available tool names exactly as provided.
Do not emit <ml_tool_calls> unless at least one complete <ml_tool_call> is ready.
If you are not calling a tool, do not mention XML or tools. Answer normally.

Use this exact structure:
<ml_tool_calls>
  <ml_tool_call>
    <ml_tool_name>TOOL_NAME_HERE</ml_tool_name>
    <ml_parameters>
      <ARG_NAME><![CDATA[ARG_VALUE]]></ARG_NAME>
    </ml_parameters>
  </ml_tool_call>
</ml_tool_calls>

Bad example: <tool_calls> or <tool_call> or <function_call>
Bad example: <ml_tool_calls> without a complete nested <ml_tool_call>
Bad example: \`\`\`xml ...\`\`\` or {"tool_calls":[...]}
Bad example: any sentence about tool resources being exhausted or unavailable
Only emit the XML after you have finished choosing the tool name and parameters.
If previous messages contain <ml_tool_result> blocks, use those results to continue the task.`;

const DEFAULT_TOOL_REMINDER = `[ml_tool reminder]
Ignore built-in/native/platform tools.
Allowed ml_tool names: {{tool_names}}.
If a tool is needed, output only complete <ml_tool_calls> XML with <ml_tool_name> and <ml_parameters>.
Never say "Tool does not exists" or that tools are unavailable.`;

const LEGACY_TOOL_PROMPT = `## Available Tools
You can invoke the following developer tools. Call a tool only when it is required and follow the JSON schema exactly when providing arguments.

{{tool_details}}

## Tool Call Protocol
When you decide to call a tool, you MUST respond with NOTHING except a single [function_calls] block exactly like the template below:

[function_calls]
[call:exact_tool_name_from_list]{"argument": "value"}[/call]
[/function_calls]

CRITICAL RULES:
1. EVERY tool call MUST start with [call:exact_tool_name] and end with [/call]
2. You MUST use the EXACT tool name as defined in the Available Tools list
3. The content between [call:...] and [/call] MUST be a raw JSON object on ONE LINE - NO LINE BREAKS inside the JSON
4. Do NOT wrap JSON in \`\`\`json blocks
5. Do NOT output any other text, explanation, or reasoning before or after the [function_calls] block
6. If you need to call multiple tools, put them all inside the same [function_calls] block`;

const FIRST_RESPONSE_REMINDER = `\n\nPlease use the available tools if needed. Remember to wrap tool calls in <ml_tool_calls> XML format.`;

export function renderToolDetails(tools: Tool[]): string {
  return tools
    .map(t => {
      const params = t.parameters ? JSON.stringify(t.parameters) : '{}';
      return `Tool: ${t.name}\nDescription: ${t.description || 'No description'}\nParameters: ${params}`;
    })
    .join('\n\n');
}

export function injectToolPrompt(
  messages: InternalMessage[],
  tools: Tool[],
  toolChoice?: ToolChoice,
  promptOverrides?: Record<string, string>,
): { messages: InternalMessage[]; toolNames: string[] } {
  if (!tools || tools.length === 0) {
    return { messages: normalizeToolMessages(messages), toolNames: [] };
  }

  let normalized = normalizeToolMessages(messages);
  const toolNames = tools.map(t => t.name);
  const toolDetails = renderToolDetails(tools);

  const outerPrompt = promptOverrides?.['openai.toolcall.prompt'] || DEFAULT_TOOL_PROMPT;
  const instructions = promptOverrides?.['openai.toolcall.instructions'] || DEFAULT_TOOL_INSTRUCTIONS;

  let instructionsFinal = instructions;
  if (toolChoice?.mode === 'required') {
    instructionsFinal += '\n\nYou MUST call one listed tool before the final answer.';
  } else if (toolChoice?.mode === 'specific' && toolChoice.name) {
    instructionsFinal += `\n\nYou MUST call tool "${toolChoice.name}".`;
  } else if (toolChoice?.mode === 'none') {
    return { messages: normalized, toolNames };
  }

  let prompt = outerPrompt
    .replace('{{tool_details}}', toolDetails)
    .replace('{{instructions}}', instructionsFinal);

  const existingSystemIdx = normalized.findIndex(m => m.role === 'system');
  if (existingSystemIdx >= 0) {
    normalized[existingSystemIdx] = {
      ...normalized[existingSystemIdx],
      content: normalized[existingSystemIdx].content + '\n\n' + prompt,
    };
  } else {
    normalized.unshift({ role: 'system', content: prompt });
  }

  const reminder = promptOverrides?.['openai.toolcall.reminder'] || DEFAULT_TOOL_REMINDER;
  const reminderText = reminder.replace('{{tool_names}}', toolNames.join(', '));

  const lastNonSystemIdx = findLastNonSystemIndex(normalized);
  if (lastNonSystemIdx >= 0) {
    const msg = normalized[lastNonSystemIdx];
    normalized[lastNonSystemIdx] = {
      ...msg,
      content: reminderText + '\n' + msg.content,
    };
  }

  return { messages: normalized, toolNames };
}

function findLastNonSystemIndex(messages: InternalMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'system') return i;
  }
  return -1;
}

export function legacyInjectToolPrompt(
  messages: InternalMessage[],
  tools: Tool[],
): InternalMessage[] {
  if (!tools || tools.length === 0) return normalizeToolMessages(messages);

  let normalized = normalizeToolMessages(messages);
  const toolDetails = renderToolDetails(tools);
  const prompt = LEGACY_TOOL_PROMPT.replace('{{tool_details}}', toolDetails);

  const existingSystemIdx = normalized.findIndex(m => m.role === 'system');
  if (existingSystemIdx >= 0) {
    normalized[existingSystemIdx] = {
      ...normalized[existingSystemIdx],
      content: normalized[existingSystemIdx].content + '\n\n' + prompt,
    };
  } else {
    normalized.unshift({ role: 'system', content: prompt });
  }

  const lastNonSystemIdx = findLastNonSystemIndex(normalized);
  if (lastNonSystemIdx >= 0) {
    const msg = normalized[lastNonSystemIdx];
    normalized[lastNonSystemIdx] = {
      ...msg,
      content: FIRST_RESPONSE_REMINDER + '\n' + msg.content,
    };
  }

  return normalized;
}

export function normalizeToolMessages(messages: InternalMessage[]): InternalMessage[] {
  const result: InternalMessage[] = [];

  let mergedSystem = '';
  for (const msg of messages) {
    if (msg.role === 'system') {
      mergedSystem += (mergedSystem ? '\n\n' : '') + msg.content;
    } else {
      result.push(msg);
    }
  }

  if (mergedSystem) {
    result.unshift({ role: 'system', content: mergedSystem });
  }

  for (let i = 0; i < result.length; i++) {
    const msg = result[i];
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      result[i] = {
        ...msg,
        content: msg.content ? msg.content + '\n' + toolCallsToMlxXml(msg.toolCalls) : toolCallsToMlxXml(msg.toolCalls),
        toolCalls: undefined,
      };
    } else if (msg.role === 'tool') {
      result[i] = {
        role: 'user',
        content: toolResultToMlxXml(msg.toolName || 'tool', msg.toolCallId || '', msg.content),
      };
    }
  }

  return result;
}

export function toolCallsToMlxXml(toolCalls: ToolCall[]): string {
  const parts = toolCalls.map(tc => {
    const params = Object.entries(tc.input || {})
      .map(([key, value]) => {
        const val = typeof value === 'string' ? value : JSON.stringify(value);
        return `    <${key}><![CDATA[${escapeCdata(val)}]]></${key}>`;
      })
      .join('\n');
    return `  <ml_tool_call>\n    <ml_tool_name>${xmlEscape(tc.name)}</ml_tool_name>\n    <ml_parameters>\n${params}\n    </ml_parameters>\n  </ml_tool_call>`;
  });
  return `<ml_tool_calls>\n${parts.join('\n')}\n</ml_tool_calls>`;
}

function toolResultToMlxXml(toolName: string, callId: string, content: string): string {
  return `<ml_tool_result>\n  <ml_tool_name>${xmlEscape(toolName)}</ml_tool_name>\n  <ml_tool_call_id>${xmlEscape(callId)}</ml_tool_call_id>\n  <content><![CDATA[${escapeCdata(content)}]]></content>\n</ml_tool_result>`;
}

export function parseToolCalls(text: string): ToolCall[] {
  if (!text) return [];

  const calls: ToolCall[] = [];

  const wrapperRegex = /<(?:ml_)?tool_calls>([\s\S]*?)<\/(?:ml_)?tool_calls>/g;
  let wrapperMatch: RegExpExecArray | null;
  while ((wrapperMatch = wrapperRegex.exec(text)) !== null) {
    const callsContent = wrapperMatch[1];
    const callRegex = /<(?:ml_)?tool_call>([\s\S]*?)<\/(?:ml_)?tool_call>/g;
    let callMatch: RegExpExecArray | null;
    while ((callMatch = callRegex.exec(callsContent)) !== null) {
      const body = callMatch[1];

      const nameMatch = body.match(/<(?:ml_)?tool_name>([\s\S]*?)<\/(?:ml_)?tool_name>/);
      if (!nameMatch) continue;
      const name = nameMatch[1].trim();

      const paramsMatch = body.match(/<(?:ml_)?parameters>([\s\S]*?)<\/(?:ml_)?parameters>/);
      let input: Record<string, any> = {};
      if (paramsMatch) {
        const paramsBody = paramsMatch[1];
        const paramRegex = /<([a-zA-Z_][a-zA-Z0-9_]*)>([\s\S]*?)<\/\1>/g;
        let paramMatch: RegExpExecArray | null;
        while ((paramMatch = paramRegex.exec(paramsBody)) !== null) {
          let val = paramMatch[2].trim();
          val = val.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
          input[paramMatch[1]] = tryParseJsonValue(val);
        }
      }

      calls.push({ id: generateCallId(), name, input });
    }
  }

  if (calls.length === 0) {
    const legacyToolUseRegex = /<tool_use>([\s\S]*?)<\/tool_use>/g;
    let legacyToolUseMatch: RegExpExecArray | null;
    while ((legacyToolUseMatch = legacyToolUseRegex.exec(text)) !== null) {
      const body = legacyToolUseMatch[1];
      const nameMatch = body.match(/<name>([\s\S]*?)<\/name>/);
      if (!nameMatch) continue;
      const name = nameMatch[1].trim();

      const argsMatch = body.match(/<arguments>([\s\S]*?)<\/arguments>/);
      let input: Record<string, any> = {};
      if (argsMatch) {
        const argsStr = argsMatch[1].trim();
        const parsed = tryParseJsonValue(argsStr);
        if (typeof parsed === 'object' && parsed !== null) {
          input = parsed;
        }
      }
      calls.push({ id: generateCallId(), name, input });
    }
  }

  return calls;
}

export function parseToolCallsLegacyBracket(text: string): ToolCall[] {
  if (!text) return [];
  const calls: ToolCall[] = [];

  const blockRegex = /\[function_calls\]([\s\S]*?)(?:\[\/function_calls\]|$)/g;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = blockRegex.exec(text)) !== null) {
    const blockContent = blockMatch[1];
    const callStartRegex = /\[call[:=]?([a-zA-Z0-9_:-]+)\]/g;
    let callStartMatch: RegExpExecArray | null;
    while ((callStartMatch = callStartRegex.exec(blockContent)) !== null) {
      const functionName = callStartMatch[1];
      const argsStartIndex = callStartMatch.index + callStartMatch[0].length;
      const remainingText = blockContent.substring(argsStartIndex);
      const jsonStr = extractBalancedJson(remainingText);
      if (jsonStr) {
        const parsed = tryParseJsonValue(jsonStr);
        if (parsed && typeof parsed === 'object') {
          calls.push({ id: generateCallId(), name: functionName, input: parsed as Record<string, any> });
        }
      }
    }
  }

  return calls;
}

function extractBalancedJson(str: string): string | null {
  const startIdx = str.indexOf('{');
  if (startIdx === -1) return null;

  let depth = 0;
  let inString = false;
  let isEscaped = false;

  for (let i = startIdx; i < str.length; i++) {
    const char = str[i];
    if (char === '\\' && !isEscaped) {
      isEscaped = true;
      continue;
    }
    if (char === '"' && !isEscaped) {
      inString = !inString;
    } else if (!inString) {
      if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (depth === 0) return str.substring(startIdx, i + 1);
      }
    }
    isEscaped = false;
  }
  return null;
}

export function cleanVisibleText(text: string): string {
  if (!text) return '';

  let cleaned = text;

  cleaned = cleaned.replace(/<ml_tool_calls>[\s\S]*?<\/ml_tool_calls>/g, '');
  cleaned = cleaned.replace(/<tool_calls>[\s\S]*?<\/tool_calls>/g, '');
  cleaned = cleaned.replace(/<ml_tool_call>[\s\S]*?<\/ml_tool_call>/g, '');
  cleaned = cleaned.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '');
  cleaned = cleaned.replace(/<\/?ml_tool_calls>/g, '');
  cleaned = cleaned.replace(/<\/?tool_calls>/g, '');
  cleaned = cleaned.replace(/<\/?ml_tool_call>/g, '');
  cleaned = cleaned.replace(/<\/?tool_call>/g, '');
  cleaned = cleaned.replace(/<\/?ml_tool_name>/g, '');
  cleaned = cleaned.replace(/<\/?tool_name>/g, '');
  cleaned = cleaned.replace(/<\/?ml_parameters>/g, '');
  cleaned = cleaned.replace(/<\/?parameters>/g, '');
  cleaned = cleaned.replace(/<tool_use>[\s\S]*?<\/tool_use>/g, '');
  cleaned = cleaned.replace(/<tool_use_result>[\s\S]*?<\/tool_use_result>/g, '');
  cleaned = cleaned.replace(/<ml_tool_result>[\s\S]*?<\/ml_tool_result>/g, '');
  cleaned = cleaned.replace(/\[function_calls\][\s\S]*?(?:\[\/function_calls\]|$)/g, '');
  cleaned = cleaned.replace(/\[call:[\s\S]*?\[\/call\]/g, '');

  const leakPatterns = [
    /tool resources exhausted/i,
    /直接聊天/i,
    /无法访问该链接/i,
    /用户使用了工具，但未能成功执行/i,
    /Tool does not exist/i,
    /<tool[A-Za-z]\w*\s+does not exists?/i,
    /Function .* is not found/i,
    /I (do not|don't|cannot?) (?:have|possess|use) (?:a )?(?:tool|function)/i,
  ];

  for (const pattern of leakPatterns) {
    cleaned = cleaned.replace(pattern, '');
  }

  return cleaned.trim();
}

export function cleanVisibleChunk(text: string): string {
  if (!text) return '';

  let cleaned = text;

  cleaned = cleaned.replace(/<\/?(?:ml_tool_calls|ml_tool_call|ml_tool_name|ml_parameters|ml_tool_result|tool_calls|tool_call|tool_name|parameters)>/g, '');
  cleaned = cleaned.replace(/<![CDATA\[[\s\S]*?\]\]>/g, '');

  return cleaned;
}

export function createStreamState(): StreamState {
  return {
    pending: '',
    capturing: false,
    captureBuffer: '',
    toolCalls: [],
    hasEmittedToolCall: false,
    currentToolCall: null,
    currentParamName: null,
    insideName: false,
    insideParams: false,
    insideCdata: false,
    cdataBuffer: '',
  };
}

export function processStreamChunk(
  chunk: string,
  state: StreamState,
): { text: string; toolCallDeltas: any[]; finishToolCall: boolean } {
  const result: { text: string; toolCallDeltas: any[]; finishToolCall: boolean } = {
    text: '',
    toolCallDeltas: [],
    finishToolCall: false,
  };

  if (!chunk && !state.pending) return result;

  state.pending += chunk;

  const captureStartMarker = '<ml_tool_calls';
  const captureEndMarker = '</ml_tool_calls>';

  if (!state.capturing) {
    const markerIdx = state.pending.indexOf(captureStartMarker);
    if (markerIdx === -1) {
      const partialIdx = findPartialMarker(state.pending, captureStartMarker);
      if (partialIdx >= 0) {
        result.text = state.pending.substring(0, partialIdx);
        state.pending = state.pending.substring(partialIdx);
        return result;
      }
      result.text = state.pending;
      state.pending = '';
      return result;
    }

    result.text = state.pending.substring(0, markerIdx);
    state.capturing = true;
    state.captureBuffer = state.pending.substring(markerIdx);
    state.pending = '';
    parseCaptureBuffer(state);
    checkCaptureComplete(state, result);
    return result;
  }

  state.captureBuffer += state.pending;
  state.pending = '';
  parseCaptureBuffer(state);
  checkCaptureComplete(state, result);
  return result;
}

function findPartialMarker(text: string, marker: string): number {
  for (let i = Math.max(0, text.length - marker.length + 1); i < text.length; i++) {
    if (marker.startsWith(text.substring(i))) {
      return i;
    }
  }
  return -1;
}

function parseCaptureBuffer(state: StreamState): void {
  const buf = state.captureBuffer;

  if (!state.insideName && !state.insideParams && !state.insideCdata) {
    const nameStartRegex = /<ml_tool_name>/g;
    let match: RegExpExecArray | null;
    let lastIdx = 0;
    nameStartRegex.lastIndex = lastIdx;
    while ((match = nameStartRegex.exec(buf)) !== null) {
      if (!state.currentToolCall) {
        state.currentToolCall = { name: '', parameters: {} };
      }
      state.insideName = true;
      lastIdx = match.index + match[0].length;
      const nameEnd = buf.indexOf('</ml_tool_name>', lastIdx);
      if (nameEnd >= 0) {
        state.currentToolCall.name = buf.substring(lastIdx, nameEnd).trim();
        state.insideName = false;
        nameStartRegex.lastIndex = nameEnd + 14;
      } else {
        nameStartRegex.lastIndex = lastIdx;
        break;
      }
    }
  }

  if (state.currentToolCall && !state.insideName && !state.insideCdata) {
    const paramStartRegex = /<ml_parameters>([\s\S]*?)<\/ml_parameters>/g;
    let match: RegExpExecArray | null;
    while ((match = paramStartRegex.exec(buf)) !== null) {
      const paramsBody = match[1];
      const paramRegex = /<([a-zA-Z_][a-zA-Z0-9_]*)>([\s\S]*?)<\/\1>/g;
      let pMatch: RegExpExecArray | null;
      while ((pMatch = paramRegex.exec(paramsBody)) !== null) {
        let val = pMatch[2].trim();
        val = val.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
        state.currentToolCall.parameters[pMatch[1]] = decodeHtmlEntities(val);
      }
    }
  }

  const callRegex = /<ml_tool_call>([\s\S]*?)<\/ml_tool_call>/g;
  let callMatch: RegExpExecArray | null;
  while ((callMatch = callRegex.exec(buf)) !== null) {
    if (state.currentToolCall) {
      const fullBody = callMatch[1];

      const nameMatch = fullBody.match(/<ml_tool_name>([\s\S]*?)<\/ml_tool_name>/);
      if (nameMatch) {
        state.currentToolCall.name = nameMatch[1].trim();
      }

      const paramsMatch = fullBody.match(/<ml_parameters>([\s\S]*?)<\/ml_parameters>/);
      if (paramsMatch) {
        const paramsBody = paramsMatch[1];
        const paramRegex = /<([a-zA-Z_][a-zA-Z0-9_]*)>([\s\S]*?)<\/\1>/g;
        let pMatch: RegExpExecArray | null;
        while ((pMatch = paramRegex.exec(paramsBody)) !== null) {
          let val = pMatch[2].trim();
          val = val.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
          state.currentToolCall.parameters[pMatch[1]] = decodeHtmlEntities(val);
        }
      }

      if (!state.toolCalls.some(tc => tc.name === state.currentToolCall!.name && JSON.stringify(tc.parameters) === JSON.stringify(state.currentToolCall!.parameters))) {
        state.toolCalls.push({ ...state.currentToolCall });
      }

      state.currentToolCall = null;
      callRegex.lastIndex = callMatch.index + callMatch[0].length;
    }
  }
}

function checkCaptureComplete(state: StreamState, result: { text: string; toolCallDeltas: any[]; finishToolCall: boolean }): void {
  if (state.captureBuffer.includes('</ml_tool_calls>')) {
    state.capturing = false;
    state.captureBuffer = '';
    state.pending = '';

    for (const tc of state.toolCalls) {
      const input: Record<string, any> = {};
      for (const [key, val] of Object.entries(tc.parameters)) {
        input[key] = tryParseJsonValue(val);
      }
      result.toolCallDeltas.push({
        name: tc.name,
        input,
      });
    }

    result.finishToolCall = true;
    state.hasEmittedToolCall = true;
  }
}

export function finalizeStream(state: StreamState): {
  text: string;
  toolCallDeltas: any[];
} {
  const result: { text: string; toolCallDeltas: any[] } = {
    text: '',
    toolCallDeltas: [],
  };

  if (state.capturing || state.pending) {
    const fullContent = state.captureBuffer + state.pending;
    const remaining = cleanVisibleText(fullContent);
    if (remaining) {
      result.text = remaining;
    }
  }

  if (state.toolCalls.length > 0) {
    for (const tc of state.toolCalls) {
      const input: Record<string, any> = {};
      for (const [key, val] of Object.entries(tc.parameters)) {
        input[key] = tryParseJsonValue(val);
      }
      result.toolCallDeltas.push({
        name: tc.name,
        input,
      });
    }
  }

  state.toolCalls = [];
  state.capturing = false;
  state.captureBuffer = '';
  state.pending = '';

  return result;
}

export function formatOpenAiToolCalls(toolCalls: ToolCall[], indexOffset: number = 0): any[] {
  return toolCalls.map((tc, i) => ({
    index: indexOffset + i,
    id: tc.id,
    type: 'function',
    function: {
      name: tc.name,
      arguments: JSON.stringify(tc.input),
    },
  }));
}

export function formatAnthropicToolContentBlock(toolCall: ToolCall): Record<string, any> {
  return {
    type: 'tool_use',
    id: toolCall.id,
    name: toolCall.name,
    input: toolCall.input,
  };
}

export function getToolNames(tools?: Tool[]): string[] {
  if (!tools || tools.length === 0) return [];
  return tools.map(t => t.name);
}

function generateCallId(): string {
  return `call_${crypto.randomBytes(8).toString('hex')}`;
}

function xmlEscape(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeCdata(str: string): string {
  return str.replace(/\]\]>/g, ']]]]><![CDATA[>');
}

function decodeHtmlEntities(str: string): string {
  return str.replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function tryParseJsonValue(val: string): any {
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    trimmed === 'true' ||
    trimmed === 'false' ||
    trimmed === 'null' ||
    !isNaN(Number(trimmed))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return val;
    }
  }
  return val;
}
