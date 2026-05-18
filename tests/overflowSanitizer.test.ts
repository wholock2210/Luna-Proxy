import path from 'path';
import { describe, it, assertEqual, assertTrue, assertFalse, assertMatch, assertNotMatch, printSummary } from './utils';

process.env.NODE_ENV = 'test';
process.chdir(path.join(__dirname, '..'));

const {
  buildSanitizedOverflow,
  isAssistantFailureEcho,
  stripThinkingBlocks,
  messageSimilarity,
} = require('../src/main/proxy/overflowSanitizer');

const BASE_CFG = {
  enabled: true,
  mode: 'generic-plus-client-rules',
  preserveRawDebugFile: false,
  maxEnvironmentFileList: 50,
  maxMessageChars: 10000,
  maxToolResultChars: 12000,
  maxToolResultCount: 5,
  stripClientToolProtocol: true,
  stripAutomatedClientErrors: true,
  stripAssistantToolFailureEcho: true,
  stripAssistantThinking: true,
  stripAssistantContainerConfusion: true,
  stripTaskResumptionWrap: true,
  dedupeAssistantMessages: true,
  assistantSimilarityThreshold: 0.85,
  assistantDedupeMode: 'normalized-token-jaccard',
  assistantKeepStrategy: 'latest-clean',
  maxAssistantMessages: 10,
  prioritizeUserMessages: true,
  includeProjectSnapshot: true,
};

function run(input: {role: string; content: any}[], projectSnapshot?: string) {
  return buildSanitizedOverflow(input, BASE_CFG, projectSnapshot || undefined);
}

// ---------------------------------------------------------------------------
describe('Section 14.1.1 — <task> tag + task_progress', () => {
  it('extracts <task> content as active task and strips task_progress', () => {
    const result = run([
      { role: 'user', content: '<task>\nthực hiện điều tra kỹ chức năng session\n</task>\n# task_progress List\n- done step 1' },
    ]);
    assertTrue(result.activeTask.startsWith('thực hiện điều tra'), 'activeTask should start with task content');
    assertTrue(result.activeTask.includes('session'), 'activeTask should include "session"');
    assertFalse(result.activeTask.includes('task_progress'), 'activeTask should not include task_progress');
  });
});

describe('Section 14.1.2 — <feedback> wrapper', () => {
  it('extracts content from <feedback> tag', () => {
    const result = run([
      { role: 'user', content: '[attempt_completion] Result: Done\n<feedback>\nthực hiện điều tra kỹ chức năng session trước\n</feedback>' },
    ]);
    assertTrue(result.activeTask.includes('thực hiện điều tra kỹ chức năng session trước'),
      'activeTask should contain feedback content');
  });
});

describe('Section 14.1.3 — [TASK RESUMPTION] wrapper', () => {
  it('extracts <user_message> content and strips TASK RESUMPTION noise', () => {
    const result = run([
      { role: 'user', content: '[TASK RESUMPTION] This task was interrupted...\nNew message to respond to with plan_mode_respond tool...\n<user_message>\nthực hiện điều tra kỹ chức năng session trước sau đó mới thực hiện plan này\n</user_message>\n# task_progress List...' },
    ]);
    assertTrue(result.activeTask.includes('thực hiện điều tra kỹ chức năng session trước'),
      'activeTask should contain user_message content');
    assertFalse(result.activeTask.includes('TASK RESUMPTION'),
      'activeTask should not include TASK RESUMPTION wrapper');
    assertFalse(result.activeTask.includes('task_progress'),
      'activeTask should not include task_progress');
  });
});

describe('Section 14.1.4 — tool result [read_file]', () => {
  it('does not select tool result as active task', () => {
    const result = run([
      { role: 'user', content: '[read_file for \'src/server.ts\'] Result:\n1 | import fs from \'fs\';\n2 | ...' },
    ]);
    assertFalse(result.activeTask.startsWith('[read_file'),
      'activeTask should not be a tool result');
    assertMatch(result.fileContent || '', /TOOL_RESULT_CONTEXT/, 'tool result should go to TOOL_RESULT_CONTEXT');
  });
});

describe('Section 14.1.5 — custom tool result by shape', () => {
  it('detects custom tool result by shape, not by name', () => {
    const result = run([
      { role: 'user', content: '[my_custom_tool for \'abc\'] Result:\n{\n  "status": "ok"\n}' },
    ]);
    assertFalse(result.activeTask.startsWith('[my_custom_tool'),
      'activeTask should not be a custom tool result');
  });
});

describe('Section 14.1.6 — task_progress-only input', () => {
  it('does not select task_progress as active task', () => {
    const result = run([
      { role: 'user', content: '# task_progress List\n- item 1\n- item 2' },
    ]);
    assertFalse(result.activeTask.includes('task_progress'),
      'activeTask should not contain task_progress');
  });
});

describe('Section 14.1.7 — Plan Mode instruction-only', () => {
  it('does not select Plan Mode instruction as active task', () => {
    const result = run([
      { role: 'user', content: 'Current Mode: PLAN MODE\nWhile in PLAN MODE you should...\nplan_mode_respond' },
    ]);
    assertFalse(result.activeTask.includes('PLAN MODE'),
      'activeTask should not contain PLAN MODE');
  });
});

describe('Section 14.1.8 — assistant failure echo', () => {
  it('strips "Tool read_file does not exists" from context', () => {
    const result = run([
      { role: 'assistant', content: 'Tool read_file does not exists. Let me try a different approach.' },
    ]);
    const keptCount = result.keptMessageCount || 0;
    const strippedCount = result.strippedMessageCount || 0;
    assertTrue(strippedCount >= 1, 'failure echo should be stripped');
  });
});

describe('Section 14.1.9 — Multiple messages priority', () => {
  it('feedback has priority over task when both present', () => {
    const result = run([
      { role: 'user', content: '<task>\nsome old task\n</task>' },
      { role: 'assistant', content: 'I did step 1' },
      { role: 'user', content: '<feedback>\nplease change approach\n</feedback>' },
    ]);
    assertTrue(result.activeTask.includes('please change approach'),
      'latest feedback should be active task');
  });

  it('user_message has priority over plain task', () => {
    const result = run([
      { role: 'user', content: '<task>\nsome old task\n</task>' },
      { role: 'assistant', content: 'working...' },
      { role: 'user', content: '[TASK RESUMPTION]...\n<user_message>\nnew instruction\n</user_message>' },
    ]);
    assertTrue(result.activeTask.includes('new instruction'),
      'user_message should be active task');
  });
});

printSummary();
