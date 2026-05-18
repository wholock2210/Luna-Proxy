
export interface OverflowSanitizerConfig {
  enabled: boolean;
  mode: 'generic' | 'generic-plus-client-rules';
  preserveRawDebugFile: boolean;
  maxEnvironmentFileList: number;
  maxMessageChars: number;
  maxToolResultChars: number;
  maxToolResultCount: number;
  stripClientToolProtocol: boolean;
  stripAutomatedClientErrors: boolean;
  stripAssistantToolFailureEcho: boolean;
  stripAssistantThinking: boolean;
  stripAssistantContainerConfusion: boolean;
  dedupeAssistantMessages: boolean;
  assistantSimilarityThreshold: number;
  assistantDedupeMode: 'normalized-token-jaccard' | 'exact' | 'prefix-trim-jaccard';
  assistantKeepStrategy: 'latest-clean' | 'keep-first' | 'keep-last';
  maxAssistantMessages: number;
  prioritizeUserMessages: boolean;
  includeProjectSnapshot: boolean;
}

export interface IgnoredReason {
  messageIndex: number;
  reason: string;
  partial?: boolean;
}

export interface SanitizedOverflowResult {
  client: string;
  clientResponseContract: string;
  activeTask: string;
  activeTaskSource: string;
  fileContent: string;
  ignoredReasons: IgnoredReason[];
  keptMessageCount: number;
  strippedMessageCount: number;
  activeTaskMessageIndex: number;
  sanitizerMeta: {
    activeTask: {messageIndex: number; confidence: string; source: string; isIgnored: boolean; fromPartIndex?: number};
    clientRetryDetected: boolean;
    clientRetrySource: string;
    clientResponseContract: string;
    partialNoise: Array<{messageIndex: number; partIndex: number; reason: string}>;
    removedCounts: {containerConfusion: number; automatedReminder: number; partialAutomatedReminder: number; assistantFailureEcho: number; duplicateAssistant: number; otherNoise: number};
    projectSnapshotIncluded: boolean;
  };
}

interface MessageTextPart {
  index: number;
  text: string;
  type: 'text' | 'unknown';
}

interface ClassifiedMessage {
  index: number;
  role: string;
  content: any;
  contentText: string;
  classification: 'active_task' | 'user_feedback_task' | 'user_message_task' | 'plain_user_task' | 'relevant_context' | 'tool_result_or_observation' | 'environment_summary' | 'client_protocol_noise' | 'automated_error_noise' | 'assistant_failure_echo' | 'assistant_container_confusion';
  reason?: string;
  partialNoiseReasons?: string[];
}

const PROJECT_KEYWORDS = [/project/i, /code/i, /file/i, /folder/i, /lỗi/i, /sửa/i, /fix/i, /implement/i, /plan/i];

const CLIENT_TOOL_SIGNATURES = [
  '## execute_command', '## read_file', '## write_to_file', '## replace_in_file',
  '## attempt_completion', '## plan_mode_respond', '## ask_followup_question',
  'execute_command', 'read_file', 'write_to_file', 'replace_in_file',
  'attempt_completion', 'plan_mode_respond', 'ask_followup_question',
  'Tool Use Guidelines',
];

const AUTOMATED_ERROR_PATTERNS = [
  /^\[ERROR]\s+You did not use a tool/i,
  /^\[ERROR]\s+You did not use a tool in your previous response/i,
  /# task_progress\s+RECOMMENDED/i,
  /^Checkpoint$/i,
  /^Compare$/i,
  /^Restore$/i,
  /^Tool \w+ does not (?:exist|exists)/i,
  /^The user denied this operation/i,
  /^Something went wrong/i,
];

const CONTAINER_CONFUSION_PATTERNS = [
  /đây không phải là mã nguồn/i,
  /ngữ cảnh tràn bộ đệm/i,
  /overflow context/i,
  /sanitized overflow/i,
  /file nhật ký.*khử trùng/i,
  /this file is .*overflow/i,
  /not a software project/i,
  /không thể xác định.*project/i,
  /file chỉ chứa thông tin siêu dữ liệu/i,
  /ngữ cảnh tràn bộ nhớ/i,
  /không chứa mã nguồn/i,
  /không chứa.*cấu trúc thư mục/i,
  /với chỉ file.*không có đủ thông tin/i,
];

const CLINE_RETRY_PATTERNS = [
  /You did not use a tool in your previous response/i,
  /please retry with a tool use/i,
];

const TOOL_RESULT_SHAPE_PATTERNS = [
  /^\[[\w_]+\s*(?:for\s+['"][^'"]+['"])?\s*\]\s*Result:/i,
  /^\[error\]\s+you did not use a tool/i,
];

const PROTOCOL_INSTRUCTION_PATTERNS = [
  /^Tool Use Guidelines/i,
  /^# task_progress/i,
  /^(Plan Mode|Checkpoint|Compare|Restore)$/i,
  /you did not use a tool/i,
  /^<environment_details>/i,
];

const TASK_RESUMPTION_PATTERNS = [
  /\[TASK RESUMPTION\]/i,
  /This task was interrupted/i,
  /New message to respond to with/i,
  /Current Mode\s+PLAN MODE/i,
  /TODO LIST UPDATE REQUIRED/i,
  /While in PLAN MODE/i,
  /plan_mode_respond/i,
];


function extractMessageTextParts(msg: any): MessageTextPart[] {
  const content = msg?.content;
  if (!content) return [{index: 0, text: '', type: 'text'}];

  if (typeof content === 'string') {
    return [{index: 0, text: content, type: 'text'}];
  }

  if (Array.isArray(content)) {
    return content.map((p, i) => {
      if (typeof p === 'string') return {index: i, text: p, type: 'text' as const};
      if (p?.type === 'text' && typeof p.text === 'string') {
        return {index: i, text: p.text, type: 'text' as const};
      }
      return {index: i, text: '', type: 'unknown' as const};
    }).filter(p => p.text.trim().length > 0);
  }

  if (content && typeof content === 'object') {
    const text = typeof content.text === 'string' ? content.text
      : typeof content.content === 'string' ? content.content
      : JSON.stringify(content);
    return [{index: 0, text, type: 'text'}];
  }

  return [{index: 0, text: String(content ?? ''), type: 'text'}];
}

function extractMessageText(msg: any): string {
  return extractMessageTextParts(msg).map(p => p.text).join('\n');
}

export function stripThinkingBlocks(text: string): string {
  return text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();
}

export function isAssistantFailureEcho(text: string): boolean {
  const cleaned = stripThinkingBlocks(text);
  const failures = [
    /Tool \w+ does not (?:exist|exists)/i,
    /Something went wrong/i,
    /The user denied this operation/i,
    /^Tool \w+ is not (?:accessible|available)/i,
  ];
  return failures.some(p => p.test(cleaned));
}

function isContainerConfusion(text: string): boolean {
  return CONTAINER_CONFUSION_PATTERNS.some(p => p.test(text));
}

function isAutomatedError(text: string): boolean {
  return AUTOMATED_ERROR_PATTERNS.some(p => p.test(text.trim()));
}

function isClientProtocolNoise(text: string): boolean {
  const sigCount = CLIENT_TOOL_SIGNATURES.filter(s => text.includes(s)).length;
  if (sigCount >= 3) return true;
  if (/<environment_details>[\s\S]*?<\/environment_details>/i.test(text)) return false;
  if (/^## \w+/.test(text.trim())) return true;
  return false;
}

function isRetryReminder(text: string): boolean {
  return CLINE_RETRY_PATTERNS.some(p => p.test(text));
}

function extractTagContent(text: string, tagName: string): string | null {
  const regex = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = text.match(regex);
  return match ? match[1].trim() : null;
}

function extractFeedbackTag(text: string): string | null {
  return extractTagContent(text, 'feedback');
}

function extractTaskTag(text: string): string | null {
  return extractTagContent(text, 'task');
}

function isToolResultLike(text: string): boolean {
  const cleaned = text.trim();
  if (TOOL_RESULT_SHAPE_PATTERNS.some(p => p.test(cleaned))) return true;
  if (/^##\s+\w+[\s\S]*?Result:/i.test(cleaned.slice(0, 200))) return true;
  if (/^Tool\s+\w+\s+(?:completed|finished|succeeded)/i.test(cleaned)) return true;
  if (/^Here['']s the (?:content|result) of/i.test(cleaned)) return true;
  return false;
}

function isClientProtocolInstruction(text: string): boolean {
  const cleaned = text.trim();
  if (cleaned.startsWith('Tool Use Guidelines')) return true;
  if (PROTOCOL_INSTRUCTION_PATTERNS.some(p => p.test(cleaned))) return true;
  return false;
}

function isEnvironmentOnly(text: string): boolean {
  const cleaned = text.trim();
  const envMatch = cleaned.match(/<environment_details>[\s\S]*?<\/environment_details>/i);
  if (!envMatch) return false;
  const stripped = cleaned.replace(/<environment_details>[\s\S]*?<\/environment_details>/gi, '').trim();
  return stripped.length === 0;
}

function stripClientProtocolSections(text: string): string {
  let result = text;
  result = result.replace(/<environment_details>[\s\S]*?<\/environment_details>/gi, '');
  result = result.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
  result = result.replace(/Tool Use Guidelines[\s\S]*?(?=\n##|$)/gi, '');
  result = result.replace(/^# task_progress\s+(?:RECOMMENDED|List|Update).*/im, '');
  result = result.replace(/^\[TASK RESUMPTION\].*$/im, '');
  result = result.replace(/^This task was interrupted.*$/im, '');
  result = result.replace(/^New message to respond to with.*$/im, '');
  result = result.replace(/^Current Mode\s+PLAN MODE.*$/im, '');
  result = result.replace(/^TODO LIST UPDATE REQUIRED.*$/im, '');
  result = result.replace(/^While in PLAN MODE.*$/im, '');
  result = result.replace(/^plan_mode_respond.*$/im, '');
  result = result.replace(/^<user_message>[\s\S]*?<\/user_message>/im, '');
  return result.trim();
}

function isTaskResumptionWrapper(text: string): boolean {
  return TASK_RESUMPTION_PATTERNS.some(p => p.test(text));
}

function extractUserMessageTag(text: string): string | null {
  return extractTagContent(text, 'user_message');
}

function detectPartialProtocolNoise(text: string): string[] {
  const reasons: string[] = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (/# task_progress/i.test(trimmed)) reasons.push('task_progress');
    else if (isRetryReminder(trimmed)) reasons.push('Cline retry reminder');
    else if (/^\[ERROR\]/i.test(trimmed)) reasons.push('automated error');
    else if (/^(Checkpoint|Compare|Restore)$/i.test(trimmed)) reasons.push('UI control artifact');
    else if (/Current Mode\s+PLAN MODE/i.test(trimmed)) reasons.push('plan mode indicator');
    else if (/TODO LIST UPDATE REQUIRED/i.test(trimmed)) reasons.push('plan mode instruction');
    else if (/While in PLAN MODE/i.test(trimmed)) reasons.push('plan mode instruction');
    else if (/plan_mode_respond/i.test(trimmed)) reasons.push('plan mode instruction');
    else if (/^\[TASK RESUMPTION\]/i.test(trimmed)) reasons.push('task resumption wrapper');
  }
  return reasons;
}

function isMeaningfulPlainUserTask(text: string): boolean {
  const cleaned = stripClientProtocolSections(text);
  if (!cleaned || cleaned.length < 3) return false;
  if (isToolResultLike(cleaned)) return false;
  if (isClientProtocolInstruction(cleaned)) return false;
  if (isEnvironmentOnly(cleaned)) return false;
  return true;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<task>[\s\S]*?<\/task>/gi, '')
    .replace(/<\/?[a-zA-Z_][\w]*>/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 0 && !/^\d+$/.test(t));
}

function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

export function messageSimilarity(a: string, b: string, mode: string): number {
  if (mode === 'exact') return a.trim() === b.trim() ? 1 : 0;
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  return jaccardSimilarity(tokensA, tokensB);
}

function reduceEnvironmentDetails(text: string, maxFileList: number): string {
  const envMatch = text.match(/<environment_details>([\s\S]*?)<\/environment_details>/i);
  if (!envMatch) return text;

  let envBlock = envMatch[1];

  const fileMatch = envBlock.match(/# Working Directory.*?\n([\s\S]*?)(?=\n#|$)/);
  if (fileMatch) {
    const fileLines = fileMatch[1].split('\n').map(l => l.trim()).filter(Boolean);
    const kept = fileLines.slice(0, maxFileList);
    const total = fileLines.length;
    if (total > maxFileList) {
      kept.push(`(... and ${total - maxFileList} more files)`);
    }
    envBlock = envBlock.replace(fileMatch[1], kept.join('\n'));
  }

  const overflowMatch = envBlock.match(/(overflow-.*?\.txt|wire-logs\/)/gi);
  if (overflowMatch && overflowMatch.length > 10) {
    envBlock = envBlock.replace(/data\/overflow\/.*/g, `data/overflow/ (${overflowMatch.length} overflow files)`);
  }

  return text.replace(envMatch[0], `<environment_details>\n${envBlock.trim()}\n</environment_details>`);
}

function classifyMessage(msg: any, index: number, config: OverflowSanitizerConfig): ClassifiedMessage {
  const role = msg?.role || 'unknown';

  const result: ClassifiedMessage = {
    index,
    role,
    content: msg.content,
    contentText: '',
    classification: 'relevant_context',
  };

  if (role === 'system') {
    const text = extractMessageText(msg);
    result.contentText = text;
    if (!text.trim()) {
      result.classification = 'client_protocol_noise';
      result.reason = 'empty content';
      return result;
    }
    const sigCount = CLIENT_TOOL_SIGNATURES.filter(s => text.includes(s)).length;
    const isToolHeavy = sigCount >= 3 || /## execute_command[\s\S]*## attempt_completion/.test(text);
    if (isToolHeavy && config.stripClientToolProtocol) {
      result.classification = 'client_protocol_noise';
      result.reason = `system prompt with ${sigCount} tool signatures`;
      return result;
    }
    if (text.length > config.maxMessageChars && !text.includes('<task>')) {
      result.classification = 'client_protocol_noise';
      result.reason = `system prompt exceeds ${config.maxMessageChars} chars without task marker`;
      return result;
    }
    result.classification = 'relevant_context';
    return result;
  }

  if (role === 'user') {
    const parts = extractMessageTextParts(msg);
    const joinedText = parts.map(p => p.text).join('\n');
    result.contentText = joinedText;

    if (!joinedText.trim()) {
      result.classification = 'client_protocol_noise';
      result.reason = 'empty content';
      return result;
    }

    const feedbackPart = parts.find(p => /<feedback>[\s\S]*?<\/feedback>/i.test(p.text));
    const taskPart = parts.find(p => /<task>[\s\S]*?<\/task>/i.test(p.text));
    const userMsgPart = parts.find(p => /<user_message>[\s\S]*?<\/user_message>/i.test(p.text));
    const envPart = parts.find(p => /<environment_details>[\s\S]*?<\/environment_details>/i.test(p.text));
    const noiseParts = parts.filter(p => isAutomatedError(p.text));
    const realParts = parts.filter(p => !isAutomatedError(p.text));

    const partialNoiseDetected = detectPartialProtocolNoise(joinedText);

    if (feedbackPart) {
      const feedbackMatch = feedbackPart.text.match(/<feedback>([\s\S]*?)<\/feedback>/i);
      result.classification = 'user_feedback_task';
      result.contentText = feedbackMatch ? feedbackMatch[1].trim() : '';
      if (noiseParts.length > 0 || partialNoiseDetected.length > 0) {
        result.partialNoiseReasons = [...new Set([
          ...noiseParts.map(p => {
            if (/# task_progress/i.test(p.text)) return 'task_progress reminder';
            if (isRetryReminder(p.text)) return 'Cline retry reminder';
            return 'automated reminder';
          }),
          ...partialNoiseDetected,
        ])];
        result.reason = 'user feedback with stripped partial noise';
      }
      return result;
    }

    if (userMsgPart) {
      const userMsgContent = extractUserMessageTag(userMsgPart.text) || '';
      if (userMsgContent.length > 0) {
        result.classification = 'user_message_task';
        result.contentText = userMsgContent.slice(0, 20000);
        result.reason = 'task resumption wrapper with user_message tag';
        if (noiseParts.length > 0 || partialNoiseDetected.length > 0) {
          result.partialNoiseReasons = [...new Set([
            ...noiseParts.map(p => {
              if (/# task_progress/i.test(p.text)) return 'task_progress reminder';
              return 'automated reminder';
            }),
            ...partialNoiseDetected,
          ])];
        }
        return result;
      }
    }

    if (taskPart) {
      const taskMatch = taskPart.text.match(/<task>([\s\S]*?)<\/task>/i);
      result.classification = 'active_task';
      result.contentText = (taskMatch ? taskMatch[1].trim() : '').slice(0, 20000);
      if (noiseParts.length > 0 || partialNoiseDetected.length > 0) {
        result.partialNoiseReasons = [...new Set([
          ...noiseParts.map(p => {
            if (/# task_progress/i.test(p.text)) return 'task_progress reminder';
            if (isRetryReminder(p.text)) return 'Cline retry reminder';
            return 'automated reminder';
          }),
          ...partialNoiseDetected,
        ])];
        result.reason = 'active task with stripped partial noise';
      }
      return result;
    }

    if (noiseParts.length === parts.length && parts.length > 0) {
      result.classification = 'automated_error_noise';
      result.reason = 'automated client error/reminder';
      result.contentText = joinedText;
      return result;
    }

    if (isToolResultLike(joinedText)) {
      result.classification = 'tool_result_or_observation';
      result.contentText = joinedText;
      return result;
    }

    if (envPart && realParts.length === 1) {
      result.classification = 'environment_summary';
      result.contentText = joinedText;
      if (noiseParts.length > 0 || partialNoiseDetected.length > 0) {
        result.partialNoiseReasons = [...new Set([
          ...noiseParts.map(p => {
            if (/# task_progress/i.test(p.text)) return 'task_progress reminder';
            return 'automated reminder';
          }),
          ...partialNoiseDetected,
        ])];
      }
      return result;
    }

    if (isClientProtocolInstruction(joinedText) || isTaskResumptionWrapper(joinedText)) {
      result.classification = 'client_protocol_noise';
      result.reason = isTaskResumptionWrapper(joinedText) ? 'task resumption wrapper without user_message' : 'client protocol instruction';
      return result;
    }

    if (realParts.length > 0) {
      const realText = realParts.map(p => p.text).join('\n').trim();
      if (realText.length > 0) {
        const cleaned = stripClientProtocolSections(realText);
        if (isMeaningfulPlainUserTask(cleaned)) {
          result.classification = 'plain_user_task';
          result.contentText = cleaned.slice(0, 20000);
          if (noiseParts.length > 0 || partialNoiseDetected.length > 0) {
            result.partialNoiseReasons = [...new Set([
              ...noiseParts.map(p => {
                if (/# task_progress/i.test(p.text)) return 'task_progress reminder';
                if (isRetryReminder(p.text)) return 'Cline retry reminder';
                return 'automated reminder';
              }),
              ...partialNoiseDetected,
            ])];
            result.reason = 'plain user task with stripped partial noise';
          }
          return result;
        }
      }
    }

    if (envPart) {
      result.classification = 'environment_summary';
      result.contentText = joinedText;
      return result;
    }

    result.classification = 'relevant_context';
    return result;
  }

  if (role === 'assistant') {
    const text = extractMessageText(msg);
    result.contentText = text;

    if (!text.trim()) {
      result.classification = 'client_protocol_noise';
      result.reason = 'empty content';
      return result;
    }

    const cleanedText = config.stripAssistantThinking ? stripThinkingBlocks(text) : text.trim();

    if (isAssistantFailureEcho(cleanedText) && config.stripAssistantToolFailureEcho) {
      result.classification = 'assistant_failure_echo';
      result.reason = 'assistant tool failure echo';
      return result;
    }

    if (isContainerConfusion(cleanedText) && config.stripAssistantContainerConfusion) {
      result.classification = 'assistant_container_confusion';
      result.reason = 'assistant described overflow container instead of task';
      return result;
    }

    if (/^(Checkpoint|Compare|Restore)$/i.test(cleanedText)) {
      result.classification = 'client_protocol_noise';
      result.reason = 'UI control artifact';
      return result;
    }
    result.classification = 'relevant_context';
    return result;
  }

  if (role === 'tool') {
    const text = extractMessageText(msg);
    result.contentText = text;
    result.classification = 'tool_result_or_observation';
    return result;
  }

  result.contentText = extractMessageText(msg);
  return result;
}

function extractActiveUserTaskFromClassified(
  classified: ClassifiedMessage[],
  config: OverflowSanitizerConfig,
): {task: string; messageIndex: number; confidence: 'high' | 'medium' | 'low'; source: 'feedback_tag' | 'user_message_tag' | 'explicit_task_tag' | 'plain_user_text' | 'fallback'; isIgnored: boolean; fromPartIndex?: number} {
  const realUserMessages = classified.filter(
    c => c.role === 'user' && c.classification !== 'automated_error_noise' && c.classification !== 'client_protocol_noise',
  );

  for (let i = realUserMessages.length - 1; i >= 0; i--) {
    const c = realUserMessages[i];

    const feedbackContent = extractFeedbackTag(c.contentText) || (c.classification === 'user_feedback_task' ? c.contentText : null);
    if (feedbackContent) {
      return {task: feedbackContent.slice(0, 20000), messageIndex: c.index, confidence: 'high', source: 'feedback_tag', isIgnored: false};
    }

    const userMsgContent = extractUserMessageTag(c.contentText) || (c.classification === 'user_message_task' ? c.contentText : null);
    if (userMsgContent) {
      return {task: userMsgContent.slice(0, 20000), messageIndex: c.index, confidence: 'high', source: 'user_message_tag', isIgnored: false};
    }

    const taskContent = extractTaskTag(c.contentText);
    if (taskContent) {
      return {task: taskContent.slice(0, 20000), messageIndex: c.index, confidence: 'high', source: 'explicit_task_tag', isIgnored: false};
    }

    if (c.classification === 'plain_user_task' || c.classification === 'active_task') {
      return {task: c.contentText.slice(0, 20000), messageIndex: c.index, confidence: 'medium', source: 'plain_user_text', isIgnored: false};
    }
  }

  return {task: '(no reliable active user task found)', messageIndex: -1, confidence: 'low', source: 'fallback', isIgnored: false};
}

function buildSanitizedFileContent(
  classified: ClassifiedMessage[],
  activeTask: {task: string; messageIndex: number; confidence: string; source: string; isIgnored: boolean},
  config: OverflowSanitizerConfig,
  projectSnapshotText?: string,
): {
  content: string;
  ignoredReasons: IgnoredReason[];
  keptCount: number;
  strippedCount: number;
  removedCounts: {containerConfusion: number; automatedReminder: number; partialAutomatedReminder: number; assistantFailureEcho: number; duplicateAssistant: number; otherNoise: number};
  clientRetryDetected: boolean;
  partialNoise: Array<{messageIndex: number; partIndex: number; reason: string}>;
} {
  const kept: ClassifiedMessage[] = [];
  const ignoredReasons: IgnoredReason[] = [];
  const removedCounts = {containerConfusion: 0, automatedReminder: 0, partialAutomatedReminder: 0, assistantFailureEcho: 0, duplicateAssistant: 0, otherNoise: 0};
  const partialNoise: Array<{messageIndex: number; partIndex: number; reason: string}> = [];
  let clientRetryDetected = false;

  for (const c of classified) {
    if (c.partialNoiseReasons && c.partialNoiseReasons.length > 0) {
      for (const pnr of c.partialNoiseReasons) {
        partialNoise.push({messageIndex: c.index, partIndex: 0, reason: pnr});
        removedCounts.partialAutomatedReminder++;
        if (/retry/i.test(pnr)) clientRetryDetected = true;
      }
      ignoredReasons.push({messageIndex: c.index, reason: c.reason || 'partial noise stripped from kept message', partial: true});
    }

    if (c.classification === 'client_protocol_noise' || c.classification === 'automated_error_noise' || c.classification === 'assistant_failure_echo' || c.classification === 'assistant_container_confusion') {
      ignoredReasons.push({messageIndex: c.index, reason: c.reason || c.classification});
      if (c.classification === 'assistant_container_confusion') removedCounts.containerConfusion++;
      else if (c.classification === 'automated_error_noise') {
        removedCounts.automatedReminder++;
        if (isRetryReminder(c.contentText)) clientRetryDetected = true;
      } else if (c.classification === 'assistant_failure_echo') removedCounts.assistantFailureEcho++;
      else removedCounts.otherNoise++;
    } else {
      kept.push(c);
    }
  }

  const envDetails = kept.find(c => c.classification === 'environment_summary');
  let otherKept = kept.filter(c => c.classification !== 'environment_summary');

  if (config.dedupeAssistantMessages) {
    const deduped: ClassifiedMessage[] = [];
    const keptAssistants: string[] = [];
    for (const c of otherKept) {
      if (c.role === 'assistant' && c.classification === 'relevant_context') {
        const cleanedText = config.stripAssistantThinking ? stripThinkingBlocks(c.contentText) : c.contentText;
        let isDuplicate = false;
        for (const keptText of keptAssistants) {
          const sim = messageSimilarity(keptText, cleanedText, config.assistantDedupeMode || 'normalized-token-jaccard');
          if (sim >= (config.assistantSimilarityThreshold || 0.85)) {
            ignoredReasons.push({messageIndex: c.index, reason: `duplicate assistant message (jaccard=${sim.toFixed(3)})`});
            removedCounts.duplicateAssistant++;
            isDuplicate = true;
            break;
          }
        }
        if (isDuplicate) continue;
        keptAssistants.push(config.assistantKeepStrategy === 'latest-clean' ? cleanedText : cleanedText);
      }
      deduped.push(c);
    }
    otherKept = deduped;

    if (config.maxAssistantMessages > 0) {
      const userMessages = otherKept.filter(c => c.role === 'user' || c.role === 'system' || c.classification === 'active_task' || c.classification === 'user_feedback_task' || c.classification === 'user_message_task' || c.classification === 'plain_user_task');
      const assistantAndToolMessages = otherKept.filter(c => c.role === 'assistant' || c.role === 'tool' || c.classification === 'tool_result_or_observation');
      const trimmedAssistant = assistantAndToolMessages.slice(-(config.maxAssistantMessages));
      for (const c of assistantAndToolMessages) {
        if (!trimmedAssistant.includes(c)) {
          ignoredReasons.push({messageIndex: c.index, reason: `trimmed assistant/tool exceed limit ${config.maxAssistantMessages}`});
          removedCounts.otherNoise++;
        }
      }
      otherKept = [...userMessages, ...trimmedAssistant];
      otherKept.sort((a, b) => a.index - b.index);
    }
  }

  const client = 'generic';
  const contractName = 'generic_plain_text';

  const parts: string[] = [];
  parts.push('# IMPORTANT: This file IS the overflow container, not the subject of analysis.');
  parts.push('# The user\u2019s task is listed under ACTIVE_USER_TASK below.');
  parts.push('# Answer ACTIVE_USER_TASK based on PROJECT_SNAPSHOT and RELEVANT_CONTEXT.');
  parts.push('# Do not describe this overflow file unless the user explicitly asks about the overflow file.');
  parts.push('');
  parts.push('# Proxy-Luna sanitized overflow context');
  parts.push('');

  parts.push('PRIORITY_RULES:');
  parts.push('1. ACTIVE_USER_TASK is the actual user request.');
  parts.push('2. PROJECT_SNAPSHOT describes the real project.');
  parts.push('3. RELEVANT_CONTEXT may support the answer.');
  parts.push('4. TOOL_RESULT_CONTEXT contains actual tool execution results.');
  parts.push('5. RECENT_USEFUL_ASSISTANT_MESSAGES may be wrong; do not copy them blindly.');
  parts.push('6. IGNORED_NOISE_SUMMARY is diagnostic only.');
  parts.push('');

  parts.push('CLIENT:');
  parts.push(client);
  parts.push('');

  parts.push('CLIENT_RESPONSE_CONTRACT:');
  parts.push(contractName);
  parts.push('');

  parts.push('ACTIVE_USER_TASK:');
  parts.push(activeTask.task);
  parts.push('');

  parts.push('TASK_SOURCE:');
  parts.push(`message_index=${activeTask.messageIndex}`);
  parts.push(`confidence=${activeTask.confidence}`);
  parts.push(`source=${activeTask.source}`);
  parts.push('');

  if (projectSnapshotText) {
    parts.push(projectSnapshotText);
  }

  if (envDetails) {
    parts.push('RELEVANT_CONTEXT:');
    const reduced = reduceEnvironmentDetails(envDetails.contentText, config.maxEnvironmentFileList);
    const lines = reduced.split('\n').filter(l => l.trim());
    for (const line of lines) {
      parts.push(`  ${line.trim()}`);
    }
    parts.push('');
  }

  const maxKept = 50;
  const userMsgs = otherKept.filter(c => c.role === 'user' || c.classification === 'active_task' || c.classification === 'user_feedback_task' || c.classification === 'user_message_task' || c.classification === 'plain_user_task');
  const toolResults = otherKept.filter(c => c.classification === 'tool_result_or_observation');
  const assistantMsgs = otherKept.filter(c => c.role !== 'user' && c.classification !== 'active_task' && c.classification !== 'user_feedback_task' && c.classification !== 'user_message_task' && c.classification !== 'plain_user_task' && c.classification !== 'tool_result_or_observation');

  if (userMsgs.length > 0) {
    parts.push('RECENT_REAL_USER_MESSAGES:');
    parts.push('');
    const keepUsers = config.prioritizeUserMessages
      ? userMsgs.slice(-Math.min(userMsgs.length, Math.ceil(maxKept * 0.6)))
      : userMsgs.slice(-maxKept);
    for (const c of keepUsers) {
      let label = '[USER]';
      if (c.classification === 'active_task') label = '[TASK]';
      else if (c.classification === 'user_feedback_task') label = '[FEEDBACK]';
      else if (c.classification === 'user_message_task') label = '[USER_MSG]';
      else if (c.classification === 'plain_user_task') label = '[TASK]';
      const contentStr = typeof c.contentText === 'string' ? c.contentText.slice(0, config.maxMessageChars) : JSON.stringify(c.content).slice(0, config.maxMessageChars);
      parts.push(`----- ${label} index=${c.index} role=${c.role}`);
      parts.push(contentStr);
      parts.push('');
    }
  }

  if (toolResults.length > 0) {
    const maxCount = config.maxToolResultCount || 5;
    const maxChars = config.maxToolResultChars || 12000;
    const trimmedResults = toolResults.slice(-maxCount);
    parts.push('TOOL_RESULT_CONTEXT:');
    parts.push('');
    for (const c of trimmedResults) {
      const contentStr = typeof c.contentText === 'string' ? c.contentText.slice(0, maxChars) : JSON.stringify(c.content).slice(0, maxChars);
      parts.push(`----- [TOOL] index=${c.index} role=${c.role}`);
      parts.push(contentStr);
      parts.push('');
    }
  }

  if (assistantMsgs.length > 0) {
    parts.push('RECENT_USEFUL_ASSISTANT_MESSAGES:');
    parts.push('');
    const keepOthers = config.prioritizeUserMessages
      ? assistantMsgs.slice(-(maxKept - Math.min(userMsgs.length, Math.ceil(maxKept * 0.6))))
      : assistantMsgs.slice(-maxKept);
    for (const c of keepOthers) {
      const label = '[ASSISTANT]';
      const contentStr = typeof c.contentText === 'string' ? c.contentText.slice(0, config.maxMessageChars) : JSON.stringify(c.content).slice(0, config.maxMessageChars);
      parts.push(`----- ${label} index=${c.index} role=${c.role}`);
      parts.push(contentStr);
      parts.push('');
    }
  }

  if (ignoredReasons.length > 0) {
    parts.push('IGNORED_NOISE_SUMMARY:');
    const reasonCounts = new Map<string, number>();
    for (const ir of ignoredReasons) {
      const key = ir.reason || 'unknown';
      const prefix = ir.partial ? 'partial: ' : '';
      reasonCounts.set(prefix + key, (reasonCounts.get(prefix + key) || 0) + 1);
    }
    for (const [reason, count] of reasonCounts) {
      parts.push(`- stripped ${count}x: ${reason}`);
    }
    parts.push('');

    parts.push('SANITIZER_DECISIONS:');
    for (const ir of ignoredReasons) {
      const tag = ir.partial ? ' (partial)' : '';
      parts.push(`- msg[${ir.messageIndex}]: ${ir.reason}${tag}`);
    }
    parts.push('');
  }

  return {
    content: parts.join('\n'),
    ignoredReasons,
    keptCount: kept.length,
    strippedCount: ignoredReasons.length,
    removedCounts,
    clientRetryDetected,
    partialNoise,
  };
}

export function buildSanitizedOverflow(
  messages: any[],
  config: Partial<OverflowSanitizerConfig>,
  projectSnapshotText?: string,
): SanitizedOverflowResult {
  const cfg: OverflowSanitizerConfig = {
    enabled: config.enabled !== false,
    mode: config.mode || 'generic-plus-client-rules',
    preserveRawDebugFile: config.preserveRawDebugFile || false,
    maxEnvironmentFileList: config.maxEnvironmentFileList || 120,
    maxMessageChars: config.maxMessageChars || 12000,
    maxToolResultChars: config.maxToolResultChars || 12000,
    maxToolResultCount: config.maxToolResultCount || 5,
    stripClientToolProtocol: config.stripClientToolProtocol !== false,
    stripAutomatedClientErrors: config.stripAutomatedClientErrors !== false,
    stripAssistantToolFailureEcho: config.stripAssistantToolFailureEcho !== false,
    stripAssistantThinking: config.stripAssistantThinking !== false,
    stripAssistantContainerConfusion: config.stripAssistantContainerConfusion !== false,
    dedupeAssistantMessages: config.dedupeAssistantMessages !== false,
    assistantSimilarityThreshold: config.assistantSimilarityThreshold || 0.85,
    assistantDedupeMode: config.assistantDedupeMode || 'normalized-token-jaccard',
    assistantKeepStrategy: config.assistantKeepStrategy || 'latest-clean',
    maxAssistantMessages: config.maxAssistantMessages || 1,
    prioritizeUserMessages: config.prioritizeUserMessages !== false,
    includeProjectSnapshot: config.includeProjectSnapshot !== false,
  };

  const client = 'generic';
  const clientContractName = 'generic_plain_text';
  const classified = messages.map((msg, i) => classifyMessage(msg, i, cfg));
  const activeTask = extractActiveUserTaskFromClassified(classified, cfg);
  const result = buildSanitizedFileContent(classified, activeTask, cfg, projectSnapshotText);

  return {
    client,
    clientResponseContract: clientContractName,
    activeTask: activeTask.task,
    activeTaskSource: activeTask.source,
    fileContent: result.content,
    ignoredReasons: result.ignoredReasons,
    keptMessageCount: result.keptCount,
    strippedMessageCount: result.strippedCount,
    activeTaskMessageIndex: activeTask.messageIndex,
    sanitizerMeta: {
      activeTask: {
        messageIndex: activeTask.messageIndex,
        confidence: activeTask.confidence,
        source: activeTask.source,
        isIgnored: activeTask.isIgnored,
        fromPartIndex: activeTask.fromPartIndex,
      },
      clientRetryDetected: false,
      clientRetrySource: 'disabled',
      clientResponseContract: clientContractName,
      partialNoise: result.partialNoise,
      removedCounts: result.removedCounts,
      projectSnapshotIncluded: !!projectSnapshotText,
    },
  };
}
