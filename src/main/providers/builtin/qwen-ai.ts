import type {BuiltinProviderConfig} from '../../store/types';

export interface QwenAiModelCatalogItem {
	id: string;
	name: string;
	description: string;
	maxContextLength: string;
	maxSummaryGenerationLength?: string;
	maxGenerationLength?: string;
	maxThinkingGenerationLength?: string;
	modality: string[];
}

export const qwenAiModelCatalog = [
	{
		id: 'qwen3.6-plus',
		name: 'Qwen3.6-Plus',
		description: 'Qwen3.6-Plus is the latest large model in the Qwen3.6 series, integrating state-of-the-art text and multimodal processing capabilities. It can autonomously invoke tools during everyday conversations and excels in web development, artifacts, complex reasoning, role-playing, creative writing, visual reasoning, OCR, and spatial understanding.',
		maxContextLength: '1,000,000 tokens',
		maxSummaryGenerationLength: '65,536 tokens',
		modality: ['text', 'image', 'video'],
	},
	{
		id: 'qwen3.6-max-preview',
		name: 'Qwen3.6-Max-Preview',
		description: 'Qwen3.6-Max-Preview is a preview version of the flagship model in the Qwen3.6 family, featuring our most advanced text capabilities. It excels in expert-level knowledge, complex reasoning, mathematics, and coding. Please note that this preview build does not currently support Search or Code Interpreter tools.',
		maxContextLength: '262,144 tokens',
		maxSummaryGenerationLength: '65,536 tokens',
		maxThinkingGenerationLength: '81,920 tokens',
		modality: ['text'],
	},
	{
		id: 'qwen3.6-27b',
		name: 'Qwen3.6-27B',
		description: 'The 27B dense model in the Qwen3.6 open-source series supports text and multimodal tasks with deep optimization for local deployment. Its compact yet powerful architecture enables smooth operation on both consumer-grade and enterprise GPUs, delivering strong performance in agentic coding, reasoning, mathematics, code generation, and multilingual understanding--making it an ideal choice for on-premise and private deployment scenarios.',
		maxContextLength: '262,144 tokens',
		maxSummaryGenerationLength: '65,536 tokens',
		maxThinkingGenerationLength: '81,920 tokens',
		modality: ['text', 'image', 'video'],
	},
	{
		id: 'qwen-latest-series-invite-beta-v24',
		name: 'Qwen3.7-Max-Preview',
		description: 'Qwen3.7-Max-Preview is the flagship model of the Qwen3.7 series, engineered to deliver state-of-the-art performance and our most advanced text capabilities. It excels in expert-level knowledge, complex logical reasoning, advanced mathematics, and sophisticated coding tasks. This preview build operates exclusively in thinking mode, and external tools such as Search and Code Interpreter are not yet supported.',
		maxContextLength: '262,144 tokens',
		maxSummaryGenerationLength: '65,536 tokens',
		maxThinkingGenerationLength: '81,920 tokens',
		modality: ['text'],
	},
	{
		id: 'qwen-latest-series-invite-beta-v16',
		name: 'Qwen3.7-Plus-Preview',
		description: 'Qwen3.7-Plus-Preview is a high-performance preview release within the Qwen3.7 family, designed to deliver a robust balance of advanced capabilities and efficiency. It provides strong text and vision processing and analytical skills for a wide range of complex tasks. This preview version runs exclusively in thinking mode, and external tools such as Search and Code Interpreter are not yet supported.',
		maxContextLength: '1,000,000 tokens',
		maxSummaryGenerationLength: '65,536 tokens',
		modality: ['text', 'image', 'video'],
	},
	{
		id: 'qwen3.5-plus',
		name: 'Qwen3.5-Plus',
		description: 'Qwen3.5-Plus is the latest large model in the Qwen3.5 series, integrating state-of-the-art text and multimodal processing capabilities. It can autonomously invoke tools during everyday conversations and excels in complex reasoning, instruction following, programming, role-playing, creative writing, visual reasoning, OCR, and spatial understanding.',
		maxContextLength: '1,000,000 tokens',
		maxSummaryGenerationLength: '65,536 tokens',
		modality: ['text', 'image', 'video'],
	},
	{
		id: 'qwen3.5-omni-plus',
		name: 'Qwen3.5-Omni-Plus',
		description: 'Qwen3.5-Omni-Plus is the latest multimodal large model in the Qwen3.5 series, supporting text, images, audio, and audio-video understanding. It features a 256K-long context window and accepts audio inputs up to 3 hours per turn and audio-video inputs up to 1 hour per turn. The model has achieved state-of-the-art (SOTA) results on 216 subtasks/benchmarks in audio and audio-video understanding, reasoning, and interactive tasks. Its general audio understanding, reasoning, recognition, translation, and dialogue capabilities comprehensively surpass those of Gemini-3.1 Pro, while its audio-video understanding performance matches that of Gemini-3.1 Pro overall. Additionally, its vision and text capabilities match those of the same-sized Qwen3.5-Plus model.',
		maxContextLength: '262,144 tokens',
		maxGenerationLength: '65,536 tokens',
		modality: ['text', 'image', 'video', 'audio'],
	},
	{
		id: 'qwen3.6-35b-a3b',
		name: 'Qwen3.6-35B-A3B',
		description: 'The latest high-efficiency model in the Qwen3.6 series, supporting text and multimodal tasks. It excels in complex reasoning, instruction following, programming, role-playing, creative writing, visual reasoning, OCR, and spatial understanding.',
		maxContextLength: '262,144 tokens',
		maxSummaryGenerationLength: '65,536 tokens',
		maxThinkingGenerationLength: '81,920 tokens',
		modality: ['text', 'image', 'video'],
	},
	{
		id: 'qwen3.5-flash',
		name: 'Qwen3.5-Flash',
		description: 'The latest high-efficiency model in the Qwen3.5 series, supporting text and multimodal tasks. It excels in complex reasoning, instruction following, programming, role-playing, creative writing, visual reasoning, OCR, and spatial understanding.',
		maxContextLength: '1,000,000 tokens',
		maxSummaryGenerationLength: '65,536 tokens',
		modality: ['text', 'image', 'video'],
	},
	{
		id: 'qwen3.5-max-2026-03-08',
		name: 'Qwen3.5-Max-Preview',
		description: 'Qwen3.5-Max-Preview is a preview version of the flagship model in the Qwen3.5 family, offering our most advanced text capabilities. It excels in expert-level knowledge, complex reasoning, mathematics, coding, creative writing, and role-playing. This preview build currently operates exclusively in thinking mode, prioritizing deep analytical processing and extended reasoning chains for high-complexity workloads.',
		maxContextLength: '262,144 tokens',
		maxSummaryGenerationLength: '65,536 tokens',
		maxThinkingGenerationLength: '81,920 tokens',
		modality: ['text'],
	},
	{
		id: 'qwen3.6-plus-preview',
		name: 'Qwen3.6-Plus-Preview',
		description: 'Qwen3.6-Plus-Preview is a preview release from the Qwen3.6 series, built specifically for developers and creators. It excels at coding, web development, and generating ready-to-use artifacts. This preview build currently operates exclusively in thinking mode.',
		maxContextLength: '1,000,000 tokens',
		maxSummaryGenerationLength: '65,536 tokens',
		maxThinkingGenerationLength: '81,920 tokens',
		modality: ['text'],
	},
	{
		id: 'qwen3.5-397b-a17b',
		name: 'Qwen3.5-397B-A17B',
		description: 'Qwen3.5-397B-A17B is the flagship language model of the Qwen3.5 series, integrating state-of-the-art text and multimodal processing capabilities while supporting both thinking and non-thinking modes. The model employs a sparse MoE, linear attention, and multi-token prediction architecture, achieving efficient inference while maintaining outstanding performance.',
		maxContextLength: '262,144 tokens',
		maxSummaryGenerationLength: '65,536 tokens',
		modality: ['text', 'image', 'video'],
	},
	{
		id: 'qwen3.5-122b-a10b',
		name: 'Qwen3.5-122B-A10B',
		description: 'A large-scale Mixture-of-Experts (MoE) model in the Qwen3.5 open-source series, featuring 122 billion total parameters with approximately 10 billion activated per forward pass. This design delivers top-tier model performance while significantly reducing inference costs. Supporting both text and multimodal tasks, it achieves industry-leading results in knowledge-intensive QA, long-context understanding, complex logical reasoning, and code generation--making it ideal for deployments requiring both high capability and computational efficiency.',
		maxContextLength: '262,144 tokens',
		maxSummaryGenerationLength: '65,536 tokens',
		modality: ['text', 'image', 'video'],
	},
	{
		id: 'qwen3.5-omni-flash',
		name: 'Qwen3.5-Omni-Flash',
		description: "Qwen3.5-Omni-Flash is the latest, highly efficient output version of Qwen3.5's next-generation full-modal large model, supporting text, images, audio, and audio-video understanding. It offers the same context length support as Qwen3.5-Omni-Plus and demonstrates exceptional performance in audio and audio-video understanding, reasoning, and interactive tasks.",
		maxContextLength: '262,144 tokens',
		maxGenerationLength: '65,536 tokens',
		modality: ['text', 'image', 'video', 'audio'],
	},
	{
		id: 'qwen3.5-27b',
		name: 'Qwen3.5-27B',
		description: 'The 27B dense model in the Qwen3.5 open-source series supports text and multimodal tasks with deep optimization for local deployment. Its compact yet powerful architecture enables smooth operation on both consumer-grade and enterprise GPUs, delivering strong performance in reasoning, mathematics, code generation, and multilingual understanding--making it an ideal choice for on-premise and private deployment scenarios.',
		maxContextLength: '262,144 tokens',
		maxSummaryGenerationLength: '65,536 tokens',
		modality: ['text', 'image', 'video'],
	},
	{
		id: 'qwen3.5-35b-a3b',
		name: 'Qwen3.5-35B-A3B',
		description: 'A lightweight Mixture-of-Experts (MoE) model in the Qwen3.5 open-source series, with 35 billion total parameters and only about 3 billion activated per inference. This architecture dramatically reduces memory footprint and computational overhead, enabling high-quality reasoning, dialogue, and content generation even on edge devices or in resource-constrained environments--the go-to choice for teams prioritizing efficiency and lightweight deployment.',
		maxContextLength: '262,144 tokens',
		maxSummaryGenerationLength: '65,536 tokens',
		modality: ['text', 'image', 'video'],
	},
	{
		id: 'qwen3-max-2026-01-23',
		name: 'Qwen3-Max',
		description: 'Qwen3-Max is the most advanced language model in the Qwen series, excelling in complex reasoning, instruction following, mathematics, coding, role-playing, creative writing, and more.',
		maxContextLength: '262,144 tokens',
		maxSummaryGenerationLength: '32,768 tokens',
		modality: ['text'],
	},
	{
		id: 'qwen-plus-2025-07-28',
		name: 'Qwen3-235B-A22B-2507',
		description: 'Qwen3-235B-A22B is the flagship language model in the third-generation Qwen series, featuring a dynamic thinking budget mechanism for adaptive performance and cost efficiency. It excels in complex reasoning, instruction following, math, coding, role-playing, and creative writing in thinking mode, while efficiently handling common tasks with low latency and token cost in non-thinking mode.',
		maxContextLength: '131,072 tokens',
		maxSummaryGenerationLength: '8,192 tokens',
		maxThinkingGenerationLength: '81,920 tokens',
		modality: ['text'],
	},
	{
		id: 'qwen3-coder-plus',
		name: 'Qwen3-Coder',
		description: 'Qwen3-Coder is a powerful coding-specialized language model excelling in code generation, tool use, and agentic tasks.',
		maxContextLength: '1,048,576 tokens',
		maxGenerationLength: '65,536 tokens',
		modality: ['text'],
	},
	{
		id: 'qwen3-vl-plus',
		name: 'Qwen3-VL-235B-A22B',
		description: 'Qwen3-VL is the most advanced vision-language model in the Qwen series, seamlessly integrating text and vision with no performance trade-off. It excels in visual reasoning, OCR, spatial understanding, and GUI-based agent tasks, supports 256K context (up to 1M), and handles images, videos, and complex documents with state-of-the-art accuracy.',
		maxContextLength: '262,144 tokens',
		maxSummaryGenerationLength: '32,768 tokens',
		maxThinkingGenerationLength: '81,920 tokens',
		modality: ['text', 'image', 'video'],
	},
	{
		id: 'qwen3-omni-flash-2025-12-01',
		name: 'Qwen3-Omni-Flash',
		description: 'Qwen3-Omni is a natively omni-modal LLM based on Qwen3. It achieves no performance degradation in text and visual modalities, sets open-source state-of-the-art results on 32 benchmarks, and achieves overall state-of-the-art performance on 22 out of 36 audio and audio-visual benchmarks, surpassing strong closed-source models such as Gemini-2.5-Pro, Seed-ASR, and GPT-4o-Transcribe.',
		maxContextLength: '65,536 tokens',
		maxThinkingGenerationLength: '24,576 tokens',
		maxGenerationLength: '13,684 tokens',
		modality: ['text', 'image', 'video', 'audio'],
	},
	{
		id: 'qwen-max-latest',
		name: 'Qwen2.5-Max',
		description: 'Qwen2.5-Max is the most powerful language model in the Qwen series. It achieves excellent performance in complex reasoning, instruction following, mathematics, coding, role-playing, creative writing, etc.',
		maxContextLength: '131,072 tokens',
		maxGenerationLength: '8,192 tokens',
		modality: ['text'],
	},
] satisfies QwenAiModelCatalogItem[];

export function getQwenAiModelCatalog(): QwenAiModelCatalogItem[] {
	return qwenAiModelCatalog.map(model => ({...model}));
}

export function getQwenAiModelMappings(): Record<string, string> {
	return Object.fromEntries(
		qwenAiModelCatalog.flatMap(model => [
			[model.name, model.id],
			[model.id, model.id],
		]),
	);
}

export const qwenAiConfig: BuiltinProviderConfig = {
	id: 'qwen-ai',
	name: 'Qwen AI (International)',
	type: 'builtin',
	authType: 'jwt',
	apiEndpoint: 'https://chat.qwen.ai',
	chatPath: '/api/v2/chat/completions',
	headers: {
		'Content-Type': 'application/json',
		Accept: 'application/json',
		source: 'web',
	},
	enabled: true,
	description: 'Qwen AI international version (chat.qwen.ai)',
	supportedModels: qwenAiModelCatalog.map(model => model.name),
	modelMappings: getQwenAiModelMappings(),
	credentialFields: [
		{
			name: 'token',
			label: 'Auth Token',
			type: 'password',
			required: true,
			placeholder: 'Enter JWT token from chat.qwen.ai',
			helpText:
				'JWT token obtained from chat.qwen.ai Local Storage (key: "token")',
		},
		{
			name: 'cookies',
			label: 'Cookies (Optional)',
			type: 'textarea',
			required: false,
			placeholder: 'Optional cookies for enhanced compatibility',
			helpText:
				'Full cookie string from browser DevTools (optional but recommended)',
		},
	],
};

export default qwenAiConfig;
