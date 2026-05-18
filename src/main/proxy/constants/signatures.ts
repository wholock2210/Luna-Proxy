/**
 * Unified Signature Definitions (package-local copy)
 */

export type ToolCallFormat =
    | 'bracket'
    | 'xml'
    | 'anthropic'
    | 'json'
    | 'native'
    | 'unknown';

export const GENERAL_TOOL_SIGNATURES = [
    '## Available Tools',
    '## Tool Call Protocol',
    '[function_calls]',
    'TOOL_WRAP_HINT',
    'You can invoke the following developer tools',
    'Tool Call Formatting',
    'TOOL USE',
    '## Tool Use',
    '## Tools',
];

export const FORMAT_SIGNATURES: Record<ToolCallFormat, string[]> = {
    bracket: ['[function_calls]', '[call:', '[/function_calls]', '[/call]'],
    xml: ['<tool_use>', '<name>', '<arguments>', '</tool_use>', '<tool_name>'],
    anthropic: ['<antml:function_calls>', 'antml:invoke', '</antml:function_calls>'],
    json: ['"tool_calls"', '"function"', '"arguments"'],
    native: [],
    unknown: [],
};

export function hasGeneralToolPromptSignature(content: string): boolean {
    return GENERAL_TOOL_SIGNATURES.some(sig => content.includes(sig));
}

export function detectToolCallFormat(content: string): ToolCallFormat {
    for (const [format, signatures] of Object.entries(FORMAT_SIGNATURES)) {
        if (signatures.some(sig => content.includes(sig))) {
            return format as ToolCallFormat;
        }
    }
    return 'bracket';
}
