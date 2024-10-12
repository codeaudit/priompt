// TODO: add an onExclude hook. i think it should be able to do whatever, and whenever it is executed, we have a promise to re-render the whole thing afterwards. the idea is that when some things are excluded we want to actually do something more advanced than just excuding certain parts (eg summarize or something)


// TODO: add an IDE plugin or something that renders the prompt when you hover over it (and has a slider for the priority)

import { ChatCompletionRequestMessage, ChatCompletionFunctions, ChatCompletionResponseMessage, CreateChatCompletionResponse, Content, StreamChatCompletionResponse, } from './openai';
import { CHATML_PROMPT_EXTRA_TOKEN_COUNT_CONSTANT, CHATML_PROMPT_EXTRA_TOKEN_COUNT_LINEAR_FACTOR, } from './openai';
import { CL100K, CL100K_SPECIAL_TOKENS, OpenAIMessageRole, PriomptTokenizer, estimateTokensUsingCharcount, numTokensForImage } from './tokenizer';
import { BaseProps, Node, ChatPrompt, Empty, First, RenderedPrompt, PromptElement, Scope, FunctionDefinition, FunctionPrompt, TextPrompt, ChatAndFunctionPromptFunction, ChatPromptMessage, ChatUserSystemMessage, ChatAssistantMessage, ChatFunctionResultMessage, Capture, OutputHandler, PromptProps, CaptureProps, BasePromptProps, ReturnProps, Isolate, RenderOutput, RenderOptions, PromptString, Prompt, BreakToken, PromptContentWrapper, PromptContent, ChatImage, ImagePromptContent, Config, ConfigProps, ChatToolResultMessage, SourceMap } from './types';
import { NewOutputCatcher } from './outputCatcher.ai';
import { PreviewManager } from './preview';


export function chatPromptToString(prompt: ChatPrompt): string {
	return prompt.messages.map((message) => {
		return `<|im_start|>${message.role}<|im_sep|>${message.content}<|im_end|>`;
	}).join('\n');
}
export function functionPromptToString(prompt: FunctionPrompt): string {
	return prompt.functions.map((func) => {
		JSON.stringify(func);
	}).join('\n');
}
const OPENAI_SPECIAL_TOKENS = [
	"<|im_start|>",
	"<|im_sep|>",
	"<|im_end|>",
	"<|meta_start|>",
	"<|meta_sep|>",
	"<|meta_end|>",
	"<|endoftext|>",
	"<|endofprompt|>",
	"<|endoffile|>",
	"<|startoftext|>",
	"<|fim_prefix|>",
	"<|fim_middle|>",
	"<|fim_suffix|>",
	"<|disc_score|>",
	"<|disc_sep|>",
	"<|disc_thread|>",
	"<|ipynb_marker|>",
	"<|diff_marker|>",
	"<|ghissue|>",
	"<|ghreview|>",
]
export function replaceOpenaiSpecialTokens(s: string): string {
	for (const token of OPENAI_SPECIAL_TOKENS) {
		s = s.replace(new RegExp(token, 'g'), token.replace("<|", "<").replace("|>", ">"));
	}
	return s;
}

export function isChatPrompt(prompt: RenderedPrompt | undefined): prompt is ChatPrompt {
	return typeof prompt === 'object' && !Array.isArray(prompt) && prompt.type === 'chat';
}
export function isPlainPrompt(prompt: RenderedPrompt | undefined): prompt is PromptString {
	return typeof prompt === 'string' || Array.isArray(prompt);
}
export function isPromptContent(prompt: RenderedPrompt | undefined): prompt is PromptContentWrapper {
	return typeof prompt === 'object' && !Array.isArray(prompt) && 'type' in prompt && prompt.type === 'prompt_content'
}
function isTextPromptPotentiallyWithFunctions(prompt: RenderedPrompt | undefined): prompt is ((TextPrompt & FunctionPrompt) | PromptString) {
	return (typeof prompt === 'object' && 'text' in prompt) || typeof prompt === 'string';
}
export function promptHasFunctions(prompt: RenderedPrompt | undefined): prompt is ((ChatPrompt & FunctionPrompt) | (TextPrompt & FunctionPrompt)) {
	return typeof prompt === 'object' && 'functions' in prompt && prompt.functions !== undefined;
}
export function promptStringToString(promptString: PromptString): string {
	return Array.isArray(promptString) ? promptString.join('') : promptString;
}
export function promptGetText(prompt: RenderedPrompt | undefined): string | undefined {
	if (!isTextPromptPotentiallyWithFunctions(prompt)) {
		return undefined;
	}
	if (isPlainPrompt(prompt)) {
		return promptStringToString(prompt);
	}
	return promptStringToString(prompt.text);
}

function sumPromptStrings(a: PromptString, b: PromptString): PromptString {
	if (Array.isArray(a) && a.length === 0) {
		return b;
	}
	if (Array.isArray(b) && b.length === 0) {
		return a;
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		return [...a.slice(0, -1), a[a.length - 1] + b[0], ...b.slice(1)];
	}
	if (Array.isArray(a)) {
		return [...a.slice(0, -1), a[a.length - 1] + b,];
	}
	if (Array.isArray(b)) {
		return [a + b[0], ...b.slice(1)];
	}
	return a + b;
}

function emptyConfig(): ConfigProps {
	return {
		maxResponseTokens: undefined,
		stop: undefined,
		cacheKey: undefined,
	};
}
// TODO: we probably want to merge based on depth-in-tree (not priority, i think)
// so that things higher up in the tree take precedence
// this is just to make sure that a component cannot affect a parent component unexpectedly
function mergeConfigs(a: ConfigProps, b: ConfigProps): ConfigProps {
	return Object.keys(b).reduce((result, key) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		result[key as keyof ConfigProps] = (a[key as keyof ConfigProps] === undefined ? b[key as keyof ConfigProps] : a[key as keyof ConfigProps]) as any;
		return result;
	}, { ...a });
}

function sumPrompts(a: RenderedPrompt | undefined, b: RenderedPrompt | undefined): RenderedPrompt | undefined {
	if (a === undefined) {
		return b;
	}
	if (b === undefined) {
		return a;
	}
	// These are non-intersecting messages, so we are fine
	if ((isChatPrompt(a) && isChatPrompt(b)) || (isChatPrompt(a) && promptGetText(b) === '') || (isChatPrompt(b) && promptGetText(a) === '')) {
		const functions = [...(promptHasFunctions(a) ? a.functions : []), ...(promptHasFunctions(b) ? b.functions : [])];
		const prompt: (ChatPrompt & FunctionPrompt) | ChatPrompt = {
			type: 'chat',
			messages: [...(isChatPrompt(a) ? a.messages : []), ...(isChatPrompt(b) ? b.messages : [])],
			functions: functions.length > 0 ? functions : undefined
		};
		return prompt;
	}
	if ((promptHasFunctions(a) || promptHasFunctions(b)) && (isTextPromptPotentiallyWithFunctions(a) && isTextPromptPotentiallyWithFunctions(b))) {
		// valid, should return TextPrompt & FunctionPrompt
		const functions = [...(promptHasFunctions(a) ? a.functions : []), ...(promptHasFunctions(b) ? b.functions : [])];
		const prompt: TextPrompt & FunctionPrompt = {
			type: 'text',
			text: sumPromptStrings((isPlainPrompt(a) ? a : a.text), (isPlainPrompt(b) ? b : b.text)),
			functions,
		};
		return prompt;
	}

	// We should not have contentPrompts with functions in them
	if ((promptHasFunctions(a) && isPromptContent(b)) || (promptHasFunctions(b) && isPromptContent(a))) {
		throw new Error(`Cannot sum prompts ${a} and ${b} since one has a function and the other has images`);
	}

	// Sum together content with plain text
	if (isPlainPrompt(a) && isPromptContent(b)) {
		return {
			...b,
			content: sumPromptStrings(a, b.content),
			images: b.images,
		}
	} else if (isPlainPrompt(b) && isPromptContent(a)) {
		return {
			...a,
			content: sumPromptStrings(a.content, b),
			images: a.images,
		}
	} else if (isPromptContent(a) && isPromptContent(b)) {
		return {
			...a,
			content: sumPromptStrings(a.content, b.content),
			images: [...(a.images ?? []), ...(b.images ?? [])],
		}
	}

	if (isPlainPrompt(a) && isPlainPrompt(b)) {
		return sumPromptStrings(a, b);
	}
	throw new Error(`cannot sum prompts ${a} (${isPlainPrompt(a) ? 'string' : a.type}) and ${b} (${isPlainPrompt(b) ? 'string' : b.type})`);
}


export function createElement(tag: ((props: BaseProps & Record<string, unknown>) => PromptElement) | string, props: Record<string, unknown> | null, ...children: PromptElement[]): PromptElement {
	if (typeof tag === 'function') {
		// we scope each tag so we can add priorities to it
		return {
			type: 'scope',
			children: [tag({ ...props, children: children })].flat(),
			absolutePriority: (props && typeof props.p === 'number') ? props.p : undefined,
			relativePriority: (props && typeof props.prel === 'number') ? props.prel : undefined,
			name: (props && typeof props.name === 'string') ? props.name : undefined,
		};
	}
	if (!(typeof tag === 'string')) {
		throw new Error(`tag must be a string or a function, got ${tag}`);
	}

	switch (tag) {
		case 'scope':
			{
				return {
					type: 'scope',
					children: children.flat(),
					relativePriority: (props && typeof props.prel === 'number') ? props.prel : undefined,
					absolutePriority: (props && typeof props.p === 'number') ? props.p : undefined,
					name: (props && typeof props.name === 'string') ? props.name : undefined,
					onEject: props && typeof props.onEject === 'function' ? props.onEject as () => void : undefined,
					onInclude: props && typeof props.onInclude === 'function' ? props.onInclude as () => void : undefined,
				};
			}
		case 'br':
			{
				if (children.length > 0) {
					throw new Error(`br tag must have no children, got ${children}`);
				}
				return {
					type: 'scope',
					children: ['\n'],
					absolutePriority: (props && typeof props.p === 'number') ? props.p : undefined,
					name: (props && typeof props.name === 'string') ? props.name : undefined,
					relativePriority: (props && typeof props.prel === 'number') ? props.prel : undefined
				};
			}
		case 'config':
			{
				if (children.length > 0) {
					throw new Error(`config tag must have no children, got ${children}`);
				}
				if (props && typeof props !== 'object') {
					throw new Error(`props must be an object, got ${props}`);
				}
				let maxResponseTokens: number | 'tokensReserved' | 'tokensRemaining' | undefined = undefined;
				if (props && 'maxResponseTokens' in props && props.maxResponseTokens !== null && props.maxResponseTokens !== undefined) {
					if (typeof props.maxResponseTokens !== 'number' && props.maxResponseTokens !== 'tokensReserved' && props.maxResponseTokens !== 'tokensRemaining') {
						throw new Error(`maxResponseTokens must be a number, 'tokensReserved', or 'tokensRemaining', got ${props.maxResponseTokens}`);
					}
					maxResponseTokens = props.maxResponseTokens;
				}
				let stop: string | string[] | undefined = undefined;
				if (props && 'stop' in props && props.stop !== null && props.stop !== undefined) {
					if (!Array.isArray(props.stop) && typeof props.stop !== 'string') {
						throw new Error(`stop must be a string or an array of strings, got ${props.stop}`);
					}
					if (Array.isArray(props.stop) && props.stop.some(s => typeof s !== 'string')) {
						throw new Error(`stop must be a string or an array of strings, got ${props.stop}`);
					}
					stop = props.stop;
				}
				let cacheKey: string | undefined = undefined;
				if (props && 'cacheKey' in props && props.cacheKey !== null && props.cacheKey !== undefined) {
					if (typeof props.cacheKey !== 'string') {
						throw new Error(`cacheKey must be a string, got ${props.cacheKey}`);
					}
					cacheKey = props.cacheKey;
				}
				return {
					type: 'scope',
					children: [{
						type: 'config',
						maxResponseTokens: maxResponseTokens,
						stop: stop,
						cacheKey: cacheKey,
					}],
					absolutePriority: (props && typeof props.p === 'number') ? props.p : undefined,
					name: (props && typeof props.name === 'string') ? props.name : undefined,
					relativePriority: (props && typeof props.prel === 'number') ? props.prel : undefined
				};
			}
		case 'breaktoken':
			{
				if (children.length > 0) {
					throw new Error(`breaktoken tag must have no children, got ${children}`);
				}
				return {
					type: 'scope',
					children: [{
						type: 'breaktoken',
					}],
					name: (props && typeof props.name === 'string') ? props.name : undefined,
					absolutePriority: (props && typeof props.p === 'number') ? props.p : undefined,
					relativePriority: (props && typeof props.prel === 'number') ? props.prel : undefined
				};
			}
		case 'hr':
			{
				if (children.length > 0) {
					throw new Error(`hr tag must have no children, got ${children}`);
				}
				return {
					type: 'scope',
					children: ['\n\n-------\n\n'],
					name: (props && typeof props.name === 'string') ? props.name : undefined,
					absolutePriority: (props && typeof props.p === 'number') ? props.p : undefined,
					relativePriority: (props && typeof props.prel === 'number') ? props.prel : undefined
				};
			}
		case 'first':
			{
				const newChildren: Scope[] = [];
				// assert that all children are scopes
				for (const child of children.flat()) {
					if (child === null || typeof child !== 'object') {
						throw new Error(`first tag must have only scope children, got ${child}`);
					}
					if (child.type !== 'scope') {
						throw new Error(`first tag must have only scope children, got ${child}`);
					}
					newChildren.push(child);
				}
				return {
					type: 'first',
					children: newChildren,
					onEject: props && typeof props.onEject === 'function' ? props.onEject as () => void : undefined,
					onInclude: props && typeof props.onInclude === 'function' ? props.onInclude as () => void : undefined,
				};
			}
		case 'empty':
			{
				if (children.length > 0) {
					throw new Error(`empty tag must have no children, got ${children}`);
				}
				if (!props || (typeof props.tokens !== 'number' && typeof props.tokens !== 'function')) {
					throw new Error(`empty tag must have a tokens prop, got ${props}`);
				}

				return {
					type: 'scope',
					children: [{
						type: 'empty',
						tokenCount: typeof props.tokens === 'number' ? props.tokens : undefined,
						tokenFunction: typeof props.tokens === 'function' ? props.tokens as Empty['tokenFunction'] : undefined,
					}],
					absolutePriority: (typeof props.p === 'number') ? props.p : undefined,
					relativePriority: (typeof props.prel === 'number') ? props.prel : undefined,
				};
			}
		case 'isolate':
			{
				// must have tokenLimit
				if (!props || typeof props.tokenLimit !== 'number') {
					throw new Error(`isolate tag must have a tokenLimit prop, got ${props}`);
				}

				return {
					type: 'scope',
					children: [{
						type: 'isolate',
						tokenLimit: props.tokenLimit,
						cachedRenderOutput: undefined,
						children: children.flat(),
					}],
					absolutePriority: (typeof props.p === 'number') ? props.p : undefined,
					relativePriority: (typeof props.prel === 'number') ? props.prel : undefined,
					name: (props !== null && typeof props.name === 'string') ? props.name : undefined,
				};
			}
		case 'capture':
			{
				if (children.length > 0) {
					throw new Error(`capture tag must have no children, got ${children}`);
				}
				if (!props || ('onOutput' in props && typeof props.onOutput !== 'function')) {
					throw new Error(`capture tag must have an onOutput prop that's a function, got ${props}`);
				}
				if ('onStream' in props && typeof props.onStream !== 'function') {
					throw new Error(`capture tag must have an onStream prop and it must be a function, got ${props}`);
				}


				return {
					type: 'scope',
					children: [{
						type: 'capture',
						onOutput: ('onOutput' in props && props.onOutput !== undefined) ? props.onOutput as OutputHandler<ChatCompletionResponseMessage> : undefined,
						onStream: ('onStream' in props && props.onStream !== undefined) ? props.onStream as OutputHandler<AsyncIterable<ChatCompletionResponseMessage>> : undefined,
					}],
					absolutePriority: (typeof props.p === 'number') ? props.p : undefined,
					relativePriority: (typeof props.prel === 'number') ? props.prel : undefined,
					name: (props !== null && typeof props.name === 'string') ? props.name : undefined,
				};
			}
		case 'image': {
			if (!props || !('bytes' in props) || !(props.bytes instanceof Uint8Array)) {
				throw new Error(`image tag must have a bytes prop that's a Uint8Array, got ${props}`);
			}
			if (!('dimensions' in props) || typeof props.dimensions !== 'object' || (!props.dimensions) || !('width' in props.dimensions) || !('height' in props.dimensions) ||
				typeof props.dimensions.width !== 'number' || typeof props.dimensions.height !== 'number') {
				throw new Error(`image tag must have a dimensions prop that's an object with width and height, got ${props}`);
			}

			if (!(props.detail === 'low' || props.detail === 'high' || props.detail === 'auto')) {
				throw new Error(`image tag must have a detail prop that's either low, high, or auto, got ${props}`);
			}
			return {
				type: 'image',
				bytes: props.bytes,
				dimensions: {
					width: props.dimensions.width,
					height: props.dimensions.height,
				},
				detail: props.detail
			}

		}
		default:
			throw new Error(`Unknown tag ${tag}`);
	}
}
export function Fragment({ children }: { children: PromptElement[]; }): PromptElement {
	// merge all the lists
	return children.flat();
}



const getIsDevelopment = () => process.env.NODE_ENV === 'development' && process.env.PRINT_PRIOMPT_LOGS === "true";
// priority level if it is not set becomes 1e9, i.e. it is always rendered
const BASE_PRIORITY = 1e9;

export async function render(elem: PromptElement, options: RenderOptions): Promise<RenderOutput> {

	// TODO: we need to performance optimize this.
	// the problem is if there are a lot of scopes.
	// the linear search, even though it caches results, is slow because the traversal over tree is quite slow
	// additionally, the linear search is surprisingly inaccurate, because tokens apparently cross boundaries more often
	// than you'd think
	// the binary search is slow because it needs to do a lot of passes
	// i'm not sure what the right solution is! it's possible that the correct approach is just that priompt is too slow to be used for every single line of a file if the file has more than 10K lines
	// one idea is to just force the user to have coarse scopes
	// another idea is to implement this in Rust, and use the napi-rs library to call it from JS. in rust, implementing this would be trivial, because we would actually have a good data structure and memory management and parallelism (i think)

	// return renderBackwardsLinearSearch(elem, options);
	return await renderBinarySearch(elem, options);
}

export async function renderPrompt<
	ReturnT,
	PropsT extends object
>({
	prompt,
	props,
	renderOptions,
}: {
	prompt: Prompt<PropsT, ReturnT>;
	props: PropsT;
	renderOptions: RenderOptions;
}): Promise<RenderOutput> {
	const baseProps: BasePromptProps<PropsT> = props;

	const returnProps: ReturnProps<ReturnT> = {
		onReturn: async () => { },
	};

	const realProps: PromptProps<PropsT, ReturnT> = {
		...baseProps,
		...returnProps,
	} satisfies PromptProps<PropsT, ReturnT>;

	let promptElement = prompt(realProps);
	if (promptElement instanceof Promise) {
		promptElement = await promptElement;
	}

	return await render(promptElement, renderOptions);
}

// returns the highest-priority onOutput call
// may throw
export async function renderun<
	ReturnT,
	PropsT extends object
>({
	prompt,
	props,
	renderOptions,
	modelCall,
	loggingOptions,
	renderedMessagesCallback = (messages: ChatCompletionRequestMessage[]) => { },
}: {
	prompt: Prompt<PropsT, ReturnT>;
	props: Omit<PropsT, "onReturn">;
	renderOptions: RenderOptions;
	renderedMessagesCallback?: (messages: ChatCompletionRequestMessage[]) => void
	modelCall: (
		args: ReturnType<typeof promptToOpenAIChatRequest>
	) => Promise<{ type: "output", value: CreateChatCompletionResponse } | { type: "stream", value: AsyncIterable<ChatCompletionResponseMessage> } | { type: "streamResponseObject", value: AsyncIterable<StreamChatCompletionResponse> }>;
	loggingOptions?: {
		promptElementRef?: { current: PromptElement | undefined };
		renderOutputRef?: { current: RenderOutput | undefined };
	}
}): Promise<ReturnT> {
	// create an output catcher
	const outputCatcher = NewOutputCatcher<ReturnT>();

	const baseProps: Omit<BasePromptProps<PropsT>, "onReturn"> = props;

	const returnProps: ReturnProps<ReturnT> = {
		onReturn: (x) => outputCatcher.onOutput(x),
	};

	// this is fine because onOutput will get overridden
	const realProps: PromptProps<PropsT, ReturnT> = {
		...baseProps,
		...returnProps,
	} as PromptProps<PropsT, ReturnT>;

	PreviewManager.maybeDump<PropsT, ReturnT>(prompt, props);

	// first render
	let promptElement = prompt(realProps);
	if (promptElement instanceof Promise) {
		promptElement = await promptElement;
	}
	if (loggingOptions?.promptElementRef !== undefined) {
		loggingOptions.promptElementRef.current = promptElement;
	}
	const rendered = await render(promptElement, renderOptions);
	if (loggingOptions?.renderOutputRef !== undefined) {
		loggingOptions.renderOutputRef.current = rendered;
	}


	const modelRequest = promptToOpenAIChatRequest(rendered.prompt);
	renderedMessagesCallback(modelRequest.messages);

	// now do the model call
	const modelOutput = await modelCall(modelRequest);


	// call all of them and wait all of them in parallel
	if (modelOutput.type === "output") {

		if (modelOutput.value.choices.length === 0) {
			throw new Error(`model returned no choices`);
		}

		const modelOutputMessage = modelOutput.value.choices[0].message;

		if (modelOutputMessage === undefined) {
			throw new Error(`model returned no message`);
		}

		await Promise.all(
			rendered.outputHandlers.map((handler) => handler(modelOutputMessage))
		);
	} else if (modelOutput.type === "stream") {
		// If no stream handlers, the default is to just return the first output
		if (rendered.streamHandlers.length === 0) {
			const awaitable = async function* (): AsyncIterable<ChatCompletionResponseMessage> {
				for await (const message of modelOutput.value) {
					yield message
				}
			}
			await outputCatcher.onOutput(awaitable() as ReturnT);
		} else {
			await Promise.all(
				rendered.streamHandlers.map((handler) => handler(modelOutput.value))
			);

		}
	} else {
		// If no stream handlers, the default is to just return the first output
		if (rendered.streamResponseObjectHandlers.length === 0) {
			const awaitable = async function* (): AsyncIterable<StreamChatCompletionResponse> {
				for await (const message of modelOutput.value) {
					yield message
				}
			}
			await outputCatcher.onOutput(awaitable() as ReturnT);
		} else {
			await Promise.all(
				rendered.streamResponseObjectHandlers.map((handler) => handler(modelOutput.value))
			);

		}
	}

	// now return the first output
	const firstOutput = outputCatcher.getOutput();

	if (firstOutput === undefined) {
		// bad bad! let's throw an error
		throw new Error(
			`No output was captured. Did you forget to include a <capture> element?`
		);
	} else {
		return firstOutput;
	}
}

// a fast, synchronous, somewhat inexact and incomplete way to render a prompt
// yields ~50x speedup in many cases and is useful for datajobs
export function renderCumulativeSum(
	elem: PromptElement,
	{ tokenLimit, tokenizer, lastMessageIsIncomplete }: RenderOptions
): Omit<RenderOutput, "tokenCount"> {
	let startTime: number | undefined;
	if (getIsDevelopment()) {
		startTime = performance.now();
	}

	// set the tokenLimit to the max number of tokens per model
	if (tokenizer === undefined) {
		throw new Error("Must specify tokenizer or model!");
	}
	const definedTokenizer = tokenizer;

	let startTimeValidating: number | undefined;
	if (getIsDevelopment()) {
		startTimeValidating = performance.now();
	}
	validateUnrenderedPrompt(elem);
	// Cumulative sum cannot uses firsts

	validateNoUnhandledTypes(elem)
	if (getIsDevelopment()) {
		const endTimeValidating = performance.now();
		console.debug(`Validating prompt took ${endTimeValidating - (startTimeValidating ?? 0)} ms`);
	}

	let startTimeComputingPriorityLevels = undefined;
	startTimeComputingPriorityLevels = performance.now();

	// We normalize the node first
	const normalizedNode = normalizePrompt(elem);
	// for now, we do a much simple thing, which is just to render the whole thing every time
	const priorityLevelsTokensMapping: Record<number, Countables[]> = {};
	computePriorityLevelsTokensMapping(normalizedNode, BASE_PRIORITY, priorityLevelsTokensMapping);

	// We also just compute the priority levels the normal way for rendering later
	const priorityLevels = new Set<number>();
	computePriorityLevels(elem, BASE_PRIORITY, priorityLevels);

	// convert to array and sort them from highest to lowest
	const priorityLevelKeys = Object.keys(priorityLevelsTokensMapping).map((x) => parseInt(x));
	const sortedPriorityLevels = priorityLevelKeys.sort((a, b) => b - a);
	if (getIsDevelopment()) {
		const endTimeComputingPriorityLevels = performance.now();
		console.debug(`Computing priority levels took ${endTimeComputingPriorityLevels - (startTimeComputingPriorityLevels ?? 0)} ms`);
	}

	// Then, we traverse in reverse order
	let runningTokenSum = 0;
	let bestTokenLevel = BASE_PRIORITY;
	for (const priorityLevel of sortedPriorityLevels) {
		const newCountables = priorityLevelsTokensMapping[priorityLevel];
		let newTokens = 0;
		newCountables.forEach((countable) => {
			if (typeof countable === 'number') {
				newTokens += countable;
			} else if (typeof countable === 'string') {
				newTokens += tokenizer.estimateNumTokensFast_SYNCHRONOUS_BE_CAREFUL(countable);
			} else {
				newTokens += countFunctionTokensApprox_SYNCHRONOUS_BE_CAREFUL(countable, definedTokenizer);
			}
		});
		runningTokenSum += newTokens;
		if (runningTokenSum > tokenLimit) {
			break;
		}
		bestTokenLevel = priorityLevel;
	}


	let startExactTokenCount = undefined;
	if (getIsDevelopment()) {
		startExactTokenCount = performance.now();
	}

	const prompt = renderWithLevel(elem, bestTokenLevel, tokenizer, true);

	if (prompt.prompt === undefined) {
		throw new Error(`renderWithLevel returned undefined`);
	}
	// const tokenCount = await countTokensExact(tokenizer, prompt.prompt ?? "", { lastMessageIsIncomplete });

	// if (tokenCount + prompt.emptyTokenCount > tokenLimit) {
	// this means that the base level prompt is too big
	// we could either return an empty string or we could throw an error here
	// this is never desirable behavior, and indicates a bug with the prompt
	// hence we throw an error
	// throw new Error(`Base prompt estimated token count is ${tokenCount} with ${prompt.emptyTokenCount} tokens reserved, which is higher than the limit ${tokenLimit}. This is probably a bug in the prompt — please add some priority levels to fix this.`);
	// }

	if (getIsDevelopment()) {
		const endExactTokenCount = performance.now();
		console.debug(`Computing exact token count took ${endExactTokenCount - (startExactTokenCount ?? 0)} ms`);
	}

	let duration: number | undefined = undefined;
	if (startTime !== undefined) {
		const endTime = performance.now();
		duration = endTime - startTime;
		if (duration > 100) {
			console.warn(`Priompt WARNING: rendering prompt took ${duration} ms, which is longer than the recommended maximum of 100 ms. Consider reducing the number of scopes you have.`)
		}
	}
	return {
		prompt: prompt.prompt,
		// tokenCount: 0,
		tokensReserved: prompt.emptyTokenCount,
		tokenLimit: tokenLimit,
		tokenizer,
		durationMs: duration,
		outputHandlers: prompt.outputHandlers,
		streamHandlers: prompt.streamHandlers,
		streamResponseObjectHandlers: prompt.streamResponseObjectHandlers,
		priorityCutoff: bestTokenLevel,
		config: prompt.config,
	};

}


export async function renderBinarySearch(elem: PromptElement, { tokenLimit, tokenizer, lastMessageIsIncomplete, countTokensFast_UNSAFE_CAN_THROW_TOOMANYTOKENS_INCORRECTLY, shouldBuildSourceMap }: RenderOptions): Promise<RenderOutput> {
	let startTime: number | undefined;
	if (getIsDevelopment()) {
		startTime = performance.now();
	}

	let startTimeValidating: number | undefined;
	if (getIsDevelopment()) {
		startTimeValidating = performance.now();
	}
	validateUnrenderedPrompt(elem);
	if (getIsDevelopment()) {
		const endTimeValidating = performance.now();
		console.debug(`Validating prompt took ${endTimeValidating - (startTimeValidating ?? 0)} ms`);
	}

	let startTimeComputingPriorityLevels = undefined;
	if (getIsDevelopment()) {
		startTimeComputingPriorityLevels = performance.now();
	}
	// for now, we do a much simple thing, which is just to render the whole thing every time
	const priorityLevels = new Set<number>();
	computePriorityLevels(elem, BASE_PRIORITY, priorityLevels);
	priorityLevels.add(BASE_PRIORITY);
	// convert to array and sort them from lowest to highest
	const sortedPriorityLevels = Array.from(priorityLevels).sort((a, b) => a - b);
	if (getIsDevelopment()) {
		const endTimeComputingPriorityLevels = performance.now();
		console.debug(`Computing priority levels took ${endTimeComputingPriorityLevels - (startTimeComputingPriorityLevels ?? 0)} ms`);
	}

	// We lower the token limit if this is an approx count
	let usedTokenlimit: number;
	if (countTokensFast_UNSAFE_CAN_THROW_TOOMANYTOKENS_INCORRECTLY === true) {
		usedTokenlimit = tokenLimit * 0.95
	} else {
		usedTokenlimit = tokenLimit;
	}

	// now we hydrate the isolates
	let startTimeHydratingIsolates = undefined;
	if (getIsDevelopment()) {
		startTimeHydratingIsolates = performance.now();
	}
	await hydrateIsolates(elem, tokenizer);
	if (getIsDevelopment()) {
		const endTimeHydratingIsolates = performance.now();
		console.debug(`Hydrating isolates took ${endTimeHydratingIsolates - (startTimeHydratingIsolates ?? 0)} ms`);
	}

	await hydrateEmptyTokenCount(elem, tokenizer);

	let startTimeRendering = undefined;
	if (getIsDevelopment()) {
		startTimeRendering = performance.now();
	}

	// the lowest priority level is as far as the cutoff can go
	// we choose an exclusive lower bound and an inclusive upper bound because we get the information
	// if TOKEN LIMIT OK: then the answer has to be <= to the candidate
	// if TOKEN LIMIT NOT OK: then the answer has to be > than the candidate
	let exclusiveLowerBound = -1;
	let inclusiveUpperBound = sortedPriorityLevels.length - 1;

	while (exclusiveLowerBound < inclusiveUpperBound - 1) {
		const candidateLevelIndex = Math.floor((exclusiveLowerBound + inclusiveUpperBound) / 2);
		const candidateLevel = sortedPriorityLevels[candidateLevelIndex];
		if (getIsDevelopment()) {
			console.debug(`Trying candidate level ${candidateLevel} with index ${candidateLevelIndex}`)
		}
		let start: number | undefined;
		if (getIsDevelopment()) {
			start = performance.now();
		}
		let countStart: number | undefined;
		let tokenCount = -1;
		try {
			const prompt = renderWithLevelAndEarlyExitWithTokenEstimation(elem, candidateLevel, tokenizer, tokenLimit);
			if (getIsDevelopment()) {
				countStart = performance.now();
			}
			// const prompt = renderWithLevel(elem, candidateLevel);
			if (countTokensFast_UNSAFE_CAN_THROW_TOOMANYTOKENS_INCORRECTLY === true) {
				tokenCount = countTokensApproxFast_UNSAFE(tokenizer, prompt.prompt ?? "", { lastMessageIsIncomplete });
			} else {
				tokenCount = await countTokensExact(tokenizer, prompt.prompt ?? "", { lastMessageIsIncomplete });
			}
			if (tokenCount + prompt.emptyTokenCount > usedTokenlimit) {
				// this means that the candidateLevel is too low
				exclusiveLowerBound = candidateLevelIndex;
			} else {
				// this means the candidate level is too high or it is just right
				inclusiveUpperBound = candidateLevelIndex;
			}
		} catch {
			// this means the candidate level is too low
			exclusiveLowerBound = candidateLevelIndex;
		} finally {
			if (getIsDevelopment()) {
				const end = performance.now();
				console.debug(`Candidate level ${candidateLevel} with index ${candidateLevelIndex} took ${end - (start ?? 0)} ms and has ${tokenCount} tokens (-1 means early exit, counting took ${end - (countStart ?? 0)})`);
			}
		}
	}

	if (getIsDevelopment()) {
		const endTimeRendering = performance.now();
		console.debug(`Rendering prompt took ${endTimeRendering - (startTimeRendering ?? 0)} ms`);
	}

	let startExactTokenCount = undefined;
	if (getIsDevelopment()) {
		startExactTokenCount = performance.now();
	}
	const prompt = renderWithLevel(elem, sortedPriorityLevels[inclusiveUpperBound], tokenizer, true, shouldBuildSourceMap === true ? {
		name: 'root',
		isLast: undefined,
	} : undefined);
	if (prompt.sourceMap !== undefined) {
		prompt.sourceMap = normalizeSourceMap(prompt.sourceMap);
	}
	const tokenCount = await countTokensExact(tokenizer, prompt.prompt ?? "", { lastMessageIsIncomplete });

	if (tokenCount + prompt.emptyTokenCount > tokenLimit) {
		// this means that the base level prompt is too big
		// we could either return an empty string or we could throw an error here
		// this is never desirable behavior, and indicates a bug with the prompt
		// hence we throw an error
		throw new TooManyTokensForBasePriority(`Base prompt estimated token count is ${tokenCount} with ${prompt.emptyTokenCount} tokens reserved, which is higher than the limit ${tokenLimit}. This is probably a bug in the prompt — please add some priority levels to fix this.`);
	}

	if (getIsDevelopment()) {
		const endExactTokenCount = performance.now();
		console.debug(`Computing exact token count took ${endExactTokenCount - (startExactTokenCount ?? 0)} ms`);
	}

	let duration: number | undefined = undefined;
	if (startTime !== undefined) {
		const endTime = performance.now();
		duration = endTime - startTime;
		if (duration > 100) {
			console.warn(`Priompt WARNING: rendering prompt took ${duration} ms, which is longer than the recommended maximum of 100 ms. Consider reducing the number of scopes you have.`)
		}
	}
	return {
		prompt: prompt.prompt ?? "",
		tokenCount: tokenCount,
		tokensReserved: prompt.emptyTokenCount,
		tokenLimit: tokenLimit,
		tokenizer,
		durationMs: duration,
		outputHandlers: prompt.outputHandlers,
		streamHandlers: prompt.streamHandlers,
		streamResponseObjectHandlers: prompt.streamResponseObjectHandlers,
		priorityCutoff: sortedPriorityLevels[inclusiveUpperBound],
		sourceMap: prompt.sourceMap,
		config: prompt.config,
	};

}

export async function renderBackwardsLinearSearch(elem: PromptElement, { tokenLimit, tokenizer, lastMessageIsIncomplete }: RenderOptions): Promise<RenderOutput> {
	let startTime: number | undefined;
	if (getIsDevelopment()) {
		startTime = performance.now();
	}

	let startTimeValidating: number | undefined;
	if (getIsDevelopment()) {
		startTimeValidating = performance.now();
		// only validate in debug
		validateUnrenderedPrompt(elem);
		const endTimeValidating = performance.now();
		console.debug(`Validating prompt took ${endTimeValidating - (startTimeValidating ?? 0)} ms`);
	}


	// ALGORITHM:
	// 1. Build a sorted list of all priorities.
	// 2. Compute an estimated lower/upper bound on the level using the number of bytes + a linear scan.
	// 3. For each block present in the lower level, compute the real token count.
	// 4. Now do a linear scan in priority level until the real token count is at or below the limit + create an upper bound where the sum of the tokens are #nodes more than the limit.
	// 5. Finally, do binary search on the updated lower/upper bound where we tokenize the full prompt every time.
	// TODO: actually implement this, instead of doing the super naive version we are doing right now


	// actually..... we do an additive approach instead. this has slightly different semantics for the <first> tag, but it is very simple and easy to reason about
	// so we go from the highest possible priority, adding in things at each time

	// FOR NOW: we do an additive search from highest cutoff to lowest, caching the token count of each element (where an element is a scope — strings themselves will be merged first, because we want as big chunks as possible to feed into tiktoken for both efficiency and accuracy reasons)
	// TODO: come up with a better algorithm here. this one is fine for now. just doesn't work if someone creates really low-character scopes but why would they

	let startTimeNormalizing = undefined;
	if (getIsDevelopment()) {
		startTimeNormalizing = performance.now();
	}
	const normalizedElem = normalizePrompt(elem);
	if (getIsDevelopment()) {
		const endTimeNormalizing = performance.now();
		console.debug(`Normalizing prompt took ${endTimeNormalizing - (startTimeNormalizing ?? 0)} ms`);
	}

	console.debug(normalizedElem, "normalizedElem");


	let startTimeComputingPriorityLevels = undefined;
	if (getIsDevelopment()) {
		startTimeComputingPriorityLevels = performance.now();
	}
	// for now, we do a much simple thing, which is just to render the whole thing every time
	const priorityLevels = new Set<number>();
	computePriorityLevels(normalizedElem, BASE_PRIORITY, priorityLevels);
	priorityLevels.add(BASE_PRIORITY);
	// convert to array and sort them from highest to lowest
	const sortedPriorityLevels = Array.from(priorityLevels).sort((a, b) => b - a);
	if (getIsDevelopment()) {
		const endTimeComputingPriorityLevels = performance.now();
		console.debug(`Computing priority levels took ${endTimeComputingPriorityLevels - (startTimeComputingPriorityLevels ?? 0)} ms`);
	}

	// if the first one is higher than the base priority, then print a warning because it will not have any effect

	let startTimeRendering = undefined;
	if (getIsDevelopment()) {
		startTimeRendering = performance.now();
	}

	// naive version: just render the whole thing for every priority level, and pick the first one that is below the limit
	let prevPrompt: RenderWithLevelPartialTypeWithCount | undefined = undefined;
	let prevLevel: number | undefined = undefined;
	let thisPrompt: RenderWithLevelPartialTypeWithCount | undefined = undefined;
	for (const level of sortedPriorityLevels) {
		thisPrompt = await renderWithLevelAndCountTokens(normalizedElem, level, tokenizer);
		if (isChatPrompt(thisPrompt.prompt)) {
			thisPrompt.tokenCount += CHATML_PROMPT_EXTRA_TOKEN_COUNT_CONSTANT;
		}
		if (thisPrompt.tokenCount + thisPrompt.emptyTokenCount > tokenLimit) {
			break;
		}
		prevPrompt = thisPrompt;
		prevLevel = level;
	}

	if (getIsDevelopment()) {
		const endTimeRendering = performance.now();
		console.debug(`Rendering prompt took ${endTimeRendering - (startTimeRendering ?? 0)} ms`);
	}

	if (prevPrompt === undefined) {
		// this means that the base level prompt is too big
		// we could either return an empty string or we could throw an error here
		// this is never desirable behavior, and indicates a bug with the prompt
		// hence we throw an error
		throw new TooManyTokensForBasePriority(`Base prompt estimated token count is ${thisPrompt?.tokenCount} with ${thisPrompt?.emptyTokenCount} tokens reserved, which is higher than the limit ${tokenLimit}. This is probably a bug in the prompt — please add some priority levels to fix this.`);
	}

	let startExactTokenCount = undefined;
	if (getIsDevelopment()) {
		startExactTokenCount = performance.now();
	}

	// now get the *actual* token count
	// the reason this might be different is tokens that span scopes
	// we do this because maybe sometimes you want the actually correct token count?
	// this token count should be smaller than the estimated token count (since now boundaries are allowed), but there might be an edge case where this actually yields a larger token count
	// in that case, it is normally fine to just have the token count be slightly too big to fit
	// because you always have a gap to fill anyways
	// consider adding a mode that if this happens, backtracks
	if (prevPrompt.prompt !== undefined) {
		const exactTokenCount = await countTokensExact(tokenizer, prevPrompt.prompt, { lastMessageIsIncomplete });
		console.debug(`Discrepancy: (estimated token count) - (actual token count) = ${prevPrompt.tokenCount} - ${exactTokenCount} = ${prevPrompt.tokenCount - exactTokenCount}`);
		prevPrompt.tokenCount = exactTokenCount;
		if (exactTokenCount + prevPrompt.emptyTokenCount > tokenLimit) {
			console.warn(`Actual token count is ${exactTokenCount} with ${prevPrompt.emptyTokenCount} tokens reserved, which is higher than the limit ${tokenLimit}. This can possibly happen in rare circumstances, but should never be a problem in practice.`)
		}
	}

	if (getIsDevelopment()) {
		const endExactTokenCount = performance.now();
		console.debug(`Computing exact token count took ${endExactTokenCount - (startExactTokenCount ?? 0)} ms`);
	}

	let duration: number | undefined = undefined;
	if (startTime !== undefined) {
		const endTime = performance.now();
		duration = endTime - startTime;
	}
	return {
		prompt: prevPrompt.prompt ?? "",
		tokenCount: prevPrompt.tokenCount,
		tokensReserved: prevPrompt.emptyTokenCount,
		tokenLimit: tokenLimit,
		tokenizer,
		outputHandlers: prevPrompt.outputHandlers,
		streamHandlers: prevPrompt.streamHandlers,
		streamResponseObjectHandlers: prevPrompt.streamResponseObjectHandlers,
		durationMs: duration,
		priorityCutoff: prevLevel ?? BASE_PRIORITY,
		config: prevPrompt.config,
	};

}

type NormalizedString = {
	type: 'normalizedString';
	s: string;
	cachedCount: number | undefined;
}
type NormalizedScope = Omit<Scope, 'children'> & {
	children: NormalizedNode[];
};
type NormalizedFirst = Omit<First, 'children'> & {
	children: NormalizedScope[];
};
type NormalizedChatUserSystemMessage = Omit<ChatUserSystemMessage, 'children'> & {
	children: NormalizedNode[];
};
type NormalizedChatAssistantMessage = Omit<ChatAssistantMessage, 'children'> & {
	children: NormalizedNode[];
};
type NormalizedChatFunctionResultMessage = Omit<ChatFunctionResultMessage, 'children'> & {
	children: NormalizedNode[];
};
type NormalizedChatToolResultMessage = Omit<ChatToolResultMessage, 'children'> & {
	children: NormalizedNode[];
};
type NormalizedChatMessage = NormalizedChatUserSystemMessage | NormalizedChatAssistantMessage | NormalizedChatFunctionResultMessage | NormalizedChatToolResultMessage;
type NormalizedFunctionDefinition = FunctionDefinition & {
	cachedCount: number | undefined;
}
type NormalizedNode = NormalizedFirst | NormalizedScope | BreakToken | Config | Empty | Isolate | Capture | NormalizedChatMessage | NormalizedString | ChatImage | NormalizedFunctionDefinition;
type NormalizedPromptElement = NormalizedNode[];
function normalizePrompt(elem: PromptElement): NormalizedPromptElement {
	// we want to merge all the strings together
	const result: NormalizedNode[] = [];
	let currentString = "";
	const elemArray = Array.isArray(elem) ? elem : [elem];
	const pushCurrentString = () => {
		if (currentString.length > 0) {
			result.push({
				type: 'normalizedString',
				s: currentString,
				cachedCount: undefined
			});
			currentString = "";
		}
	}
	for (const node of elemArray) {
		if (node === undefined || node === null) {
			continue;
		}
		if (typeof node === 'string') {
			currentString += node;
		} else if (typeof node === 'number') {
			currentString += node.toString();
		} else if (typeof node === 'object') {
			pushCurrentString();
			let newNode: NormalizedNode;
			switch (node.type) {
				case 'config':
				case 'capture':
				case 'isolate':
				case 'breaktoken':
				case 'image':
				case 'empty': {
					newNode = node;
					break;
				}
				case 'functionDefinition': {
					newNode = {
						...node,
						cachedCount: undefined
					};
					break;
				}
				case 'first': {
					newNode = {
						...node,
						children: node.children.map(c => {
							return {
								...c,
								children: normalizePrompt(c.children)
							};
						}
						),
					};
					break;
				}
				case 'chat':
				case 'scope': {
					newNode = {
						...node,
						children: normalizePrompt(node.children)
					};
					break;
				}
			}
			result.push(newNode);
		} else {
			throw new Error("Invalid prompt element");
		}
	}
	pushCurrentString();
	return result;
}

type RenderWithLevelPartialType = {
	prompt: RenderedPrompt | undefined;
	emptyTokenCount: number;
	outputHandlers: OutputHandler<ChatCompletionResponseMessage>[];
	streamHandlers: OutputHandler<AsyncIterable<ChatCompletionResponseMessage>>[];
	streamResponseObjectHandlers: OutputHandler<AsyncIterable<StreamChatCompletionResponse>>[];
	config: ConfigProps;
	sourceMap?: SourceMap;
};
type RenderWithLevelPartialTypeWithCount = RenderWithLevelPartialType & { tokenCount: number; };

// if chat prompt, the token count will be missing the constant factor
async function renderWithLevelAndCountTokens(elem: NormalizedNode[] | NormalizedNode, level: number, tokenizer: PriomptTokenizer): Promise<RenderWithLevelPartialTypeWithCount> {
	if (Array.isArray(elem)) {
		return (await Promise.all(elem.map(e => renderWithLevelAndCountTokens(e, level, tokenizer)))).reduce((a, b) => {
			return {
				prompt: sumPrompts(a.prompt, b.prompt),
				tokenCount: a.tokenCount + b.tokenCount,
				emptyTokenCount: a.emptyTokenCount + b.emptyTokenCount,
				outputHandlers: [...a.outputHandlers, ...b.outputHandlers],
				streamHandlers: [...a.streamHandlers, ...b.streamHandlers],
				streamResponseObjectHandlers: [...a.streamResponseObjectHandlers, ...b.streamResponseObjectHandlers],
				config: mergeConfigs(a.config, b.config),
			};
		}, {
			prompt: undefined,
			tokenCount: 0,
			emptyTokenCount: 0,
			outputHandlers: [],
			streamHandlers: [],
			streamResponseObjectHandlers: [],
			config: {
				maxResponseTokens: undefined,
				stop: undefined,
				cacheKey: undefined,
			},
		});
	}
	switch (elem.type) {
		case 'first': {
			for (const child of elem.children) {
				if (child.absolutePriority === undefined) {
					throw new Error(`BUG!! computePriorityLevels should have set absolutePriority for all children of first`);
				}
				if (child.absolutePriority >= level) {
					return renderWithLevelAndCountTokens(child, level, tokenizer);
				}
			}
			// nothing returned from first, which is ok
			return {
				prompt: undefined,
				tokenCount: 0,
				emptyTokenCount: 0,
				outputHandlers: [],
				streamHandlers: [],
				streamResponseObjectHandlers: [],
				config: emptyConfig(),
			};
		}
		case 'image': {
			const base64EncodedBytes = Buffer.from(elem.bytes).toString('base64');
			return {
				prompt: {
					type: 'prompt_content',
					content: [],
					images: [{
						type: 'image_url',
						image_url: {
							url: `data:image/jpeg;base64,${base64EncodedBytes}`,
							detail: elem.detail,
							// Temporary addition to be removed before sent to openai
							dimensions: elem.dimensions,
						}
					}],
				},
				// Count the number of tokens for the image
				emptyTokenCount: 0,
				tokenCount: numTokensForImage(elem.dimensions, elem.detail),
				outputHandlers: [],
				streamHandlers: [],
				streamResponseObjectHandlers: [],
				config: emptyConfig(),
			}
		}
		case 'capture': {
			return {
				prompt: undefined,
				tokenCount: 0,
				emptyTokenCount: 0,
				outputHandlers: elem.onOutput !== undefined ? [elem.onOutput] : [],
				streamHandlers: elem.onStream !== undefined ? [elem.onStream] : [],
				streamResponseObjectHandlers: elem.onStreamResponseObject !== undefined ? [elem.onStreamResponseObject] : [],
				config: emptyConfig(),
			}
		}
		case 'config': {
			return {
				prompt: undefined,
				tokenCount: 0,
				emptyTokenCount: 0,
				outputHandlers: [],
				streamHandlers: [],
				streamResponseObjectHandlers: [],
				config: elem
			}
		}
		case 'breaktoken': {
			return {
				// a breaktoken is just a split!
				prompt: ['', ''],
				tokenCount: 0,
				emptyTokenCount: 0,
				outputHandlers: [],
				streamHandlers: [],
				streamResponseObjectHandlers: [],
				config: emptyConfig(),
			}
		}
		case 'empty': {
			if (elem.tokenCount === undefined) {
				if (elem.tokenFunction === undefined) {
					throw new Error(`BUG!! empty token function is undefined. THIS SHOULD NEVER HAPPEN. BUG IN PRIOMPT.`);
				}
				elem.tokenCount = await elem.tokenFunction((s) => tokenizer.numTokens(s));
			}
			return {
				prompt: undefined,
				tokenCount: 0,
				emptyTokenCount: elem.tokenCount,
				outputHandlers: [],
				streamHandlers: [],
				streamResponseObjectHandlers: [],
				config: emptyConfig(),
			}
		}
		case 'functionDefinition': {
			if (elem.cachedCount === undefined) {
				elem.cachedCount = await countFunctionTokens(elem, tokenizer);
			}
			const prompt: (TextPrompt & FunctionPrompt) = {
				type: 'text',
				text: "",
				functions: [
					{
						name: elem.name,
						description: elem.description,
						parameters: elem.parameters,
					}
				]
			};
			return {
				prompt,
				tokenCount: elem.cachedCount,
				emptyTokenCount: 0,
				outputHandlers: [],
				streamHandlers: [],
				streamResponseObjectHandlers: [],
				config: emptyConfig(),
			}
		}
		case 'isolate': {
			// check if we have a cached prompt
			if (elem.cachedRenderOutput === undefined) {
				elem.cachedRenderOutput = await render(elem.children, {
					tokenizer,
					tokenLimit: elem.tokenLimit,
				})
			}
			return {
				prompt: elem.cachedRenderOutput.prompt,
				tokenCount: elem.cachedRenderOutput.tokenCount,
				emptyTokenCount: elem.cachedRenderOutput.tokensReserved,
				outputHandlers: elem.cachedRenderOutput.outputHandlers,
				streamHandlers: elem.cachedRenderOutput.streamHandlers,
				streamResponseObjectHandlers: elem.cachedRenderOutput.streamResponseObjectHandlers,
				config: emptyConfig(),
			}
		}
		case 'chat': {
			const p = await renderWithLevelAndCountTokens(elem.children, level, tokenizer);
			if (isChatPrompt(p.prompt)) {
				throw new Error(`Incorrect prompt: we have nested chat messages, which is not allowed!`);
			}

			let extraTokenCount = 0;
			let message: ChatPromptMessage;
			if (elem.role === 'user') {
				if (isPromptContent(p.prompt)) {
					message = {
						role: elem.role,
						name: elem.name,
						to: elem.to,
						content: p.prompt.content,
						images: p.prompt.images,
					};
				} else {
					message = {
						role: elem.role,
						name: elem.name,
						to: elem.to,
						content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text ?? ""),
					};
				}
			} else if (elem.role === 'system') {
				if (isPromptContent(p.prompt)) {
					throw new Error('Did not expect images in system message')
				} else {
					message = {
						role: elem.role,
						name: elem.name,
						to: elem.to,
						content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text ?? ""),
					};
				}
			} else if (elem.role === 'assistant') {
				if (isPromptContent(p.prompt)) {
					throw new Error('Did not expect images in assistant message')
				}
				if (elem.functionCall !== undefined) {
					message = {
						role: elem.role,
						// intentionally can be undefined because an assistant message can, for example, contain only a function call
						content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text),
						to: elem.to,
						functionCall: elem.functionCall,
					}
					extraTokenCount += await countFunctionCallMessageTokens(elem.functionCall, tokenizer);
				} else {
					message = {
						role: elem.role,
						to: elem.to,
						content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text ?? ""),
					}
				}
			} else if (elem.role === 'function') {
				if (isPromptContent(p.prompt)) {
					throw new Error('Did not expect images in function message')
				}
				message = {
					role: elem.role,
					name: elem.name,
					to: elem.to,
					content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text ?? ""),
				}
				extraTokenCount += await tokenizer.numTokens(elem.name);
			} else if (elem.role === 'tool') {
				if (isPromptContent(p.prompt)) {
					throw new Error('Did not expect images in tool message')
				}
				message = {
					role: elem.role,
					name: elem.name,
					to: elem.to,
					content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text ?? ""),
				}
				extraTokenCount += await tokenizer.numTokens(elem.name);
			} else {
				const x: never = elem.role;
				throw new Error(`BUG!! Invalid role ${elem.role}`);
			}

			return {
				prompt: {
					type: 'chat',
					messages: [message],
					functions: promptHasFunctions(p.prompt) ? p.prompt.functions : undefined
				},
				tokenCount: p.tokenCount + CHATML_PROMPT_EXTRA_TOKEN_COUNT_LINEAR_FACTOR + extraTokenCount,
				emptyTokenCount: p.emptyTokenCount,
				outputHandlers: p.outputHandlers,
				streamHandlers: p.streamHandlers,
				streamResponseObjectHandlers: p.streamResponseObjectHandlers,
				config: emptyConfig(),
			}
		}
		case 'scope': {
			if (elem.absolutePriority === undefined) {
				throw new Error(`BUG!! computePriorityLevels should have set absolutePriority for all scopes`);
			}
			if (elem.absolutePriority >= level) {
				return renderWithLevelAndCountTokens(elem.children, level, tokenizer);
			}
			return {
				prompt: undefined,
				tokenCount: 0,
				emptyTokenCount: 0,
				outputHandlers: [],
				streamHandlers: [],
				streamResponseObjectHandlers: [],
				config: emptyConfig(),
			}
		}
		case 'normalizedString': {
			if (elem.cachedCount === undefined) {
				elem.cachedCount = await tokenizer.numTokens(elem.s);
			}
			return {
				prompt: elem.s,
				tokenCount: elem.cachedCount,
				emptyTokenCount: 0,
				outputHandlers: [],
				streamHandlers: [],
				streamResponseObjectHandlers: [],
				config: emptyConfig(),
			};
		}
	}
}

// WARNING: do not attempt to make this function async!!! it will make it a lot slower!
function renderWithLevelAndEarlyExitWithTokenEstimation(elem: PromptElement, level: number, tokenizer: PriomptTokenizer, tokenLimit: number): {
	prompt: RenderedPrompt | undefined;
	emptyTokenCount: number;
} {
	if (elem === undefined || elem === null || elem === false) {
		return {
			prompt: undefined,
			emptyTokenCount: 0
		};
	}
	if (Array.isArray(elem)) {
		const results = elem.map(e => renderWithLevelAndEarlyExitWithTokenEstimation(e, level, tokenizer, tokenLimit));
		return results.reduce((a, b) => {
			const sum = sumPrompts(a.prompt, b.prompt);
			const lowerBound = estimateLowerBoundTokensForPrompt(sum, tokenizer);
			if (lowerBound > tokenLimit) {
				throw new Error(`Token limit exceeded!`);
			}
			return {
				prompt: sum,
				emptyTokenCount: a.emptyTokenCount + b.emptyTokenCount
			};
		}, {
			prompt: undefined,
			emptyTokenCount: 0
		});
	}
	if (typeof elem === 'string') {
		return {
			prompt: elem,
			emptyTokenCount: 0
		};
	}
	if (typeof elem === 'number') {
		return {
			prompt: elem.toString(),
			emptyTokenCount: 0
		};
	}
	switch (elem.type) {
		case 'first': {
			for (const child of elem.children) {
				if (child.absolutePriority === undefined) {
					throw new Error(`BUG!! computePriorityLevels should have set absolutePriority for all children of first`);
				}
				if (child.absolutePriority >= level) {
					return renderWithLevelAndEarlyExitWithTokenEstimation(child, level, tokenizer, tokenLimit);
				}
			}
			// nothing returned from first, which is ok
			return {
				prompt: undefined,
				emptyTokenCount: 0
			};
		}
		case 'capture': {
			// we're not rendering the capture here
			return {
				prompt: undefined,
				emptyTokenCount: 0
			}
		}
		case 'config': {
			// we're not rendering the config here
			return {
				prompt: undefined,
				emptyTokenCount: 0
			}
		}
		case 'breaktoken': {
			return {
				prompt: ['', ''],
				emptyTokenCount: 0
			}
		}
		case 'empty': {
			if (elem.tokenCount === undefined) {
				throw new Error(`BUG!! empty token count is undefined. THIS SHOULD NEVER HAPPEN. BUG IN PRIOMPT.Empty token count should've been hydrated first!`);
			}
			return {
				prompt: undefined,
				emptyTokenCount: elem.tokenCount
			}
		}
		case 'functionDefinition': {
			const prompt: (TextPrompt & FunctionPrompt) = {
				type: 'text',
				text: "",
				functions: [
					{
						name: elem.name,
						description: elem.description,
						parameters: elem.parameters,
					}
				]
			};
			return {
				prompt,
				emptyTokenCount: 0
			}
		}
		case 'image': {
			const base64EncodedBytes = Buffer.from(elem.bytes).toString('base64');
			return {
				prompt: {
					type: 'prompt_content',
					content: [],
					images: [{
						type: 'image_url',
						image_url: {
							url: `data:image/jpeg;base64,${base64EncodedBytes}`,
							detail: elem.detail,
							dimensions: elem.dimensions,
						}
					}],
				},
				// Count the number of tokens for the image
				emptyTokenCount: 0,
			}
		}
		case 'isolate': {
			// check if we have a cached prompt
			if (elem.cachedRenderOutput === undefined) {
				// throw error! we need to hydrate the isolates first!
				throw new Error(`BUG!! Isolates should have been hydrated before calling renderWithLevelAndEarlyExitWithTokenEstimation`);
			}
			return {
				prompt: elem.cachedRenderOutput.prompt,
				emptyTokenCount: elem.cachedRenderOutput.tokensReserved,
			}
		}
		case 'chat': {
			const p = renderWithLevelAndEarlyExitWithTokenEstimation(elem.children, level, tokenizer, tokenLimit);
			if (isChatPrompt(p.prompt)) {
				throw new Error(`Incorrect prompt: we have nested chat messages, which is not allowed!`);
			}

			let message: ChatPromptMessage;
			if (elem.role === 'user') {
				if (isPromptContent(p.prompt)) {
					message = {
						role: elem.role,
						name: elem.name,
						to: elem.to,
						content: p.prompt.content,
						images: p.prompt.images,
					};
				} else {
					message = {
						role: elem.role,
						to: elem.to,
						name: elem.name,
						content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text ?? ""),
					};
				}
			} else if (elem.role === 'system') {
				if (isPromptContent(p.prompt)) {
					throw new Error('Did not expect images in system message')
				}
				message = {
					role: elem.role,
					to: elem.to,
					name: elem.name,
					content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text ?? ""),
				};
			} else if (elem.role === 'assistant') {
				if (isPromptContent(p.prompt)) {
					throw new Error('Did not expect images in assistant message')
				}
				if (elem.functionCall !== undefined) {
					message = {
						role: elem.role,
						to: elem.to,
						content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text),
						functionCall: elem.functionCall,
					}
				} else {
					message = {
						role: elem.role,
						to: elem.to,
						content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text ?? ""),
					}
				}
			} else if (elem.role === 'function') {
				if (isPromptContent(p.prompt)) {
					throw new Error('Did not expect images in function message')
				}
				message = {
					role: elem.role,
					name: elem.name,
					to: elem.to,
					content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text ?? ""),
				}
			} else if (elem.role === 'tool') {
				if (isPromptContent(p.prompt)) {
					throw new Error('Did not expect images in tool message')
				}
				message = {
					role: elem.role,
					name: elem.name,
					to: elem.to,
					content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text ?? ""),
				}
			} else {
				const x: never = elem.role;
				throw new Error(`BUG!! Invalid role ${elem.role}`);
			}

			return {
				prompt: {
					type: 'chat',
					messages: [message],
					functions: promptHasFunctions(p.prompt) ? p.prompt.functions : undefined
				},
				emptyTokenCount: p.emptyTokenCount,
			}
		}
		case 'scope': {
			if (elem.absolutePriority === undefined) {
				throw new Error(`BUG!! computePriorityLevels should have set absolutePriority for all scopes`);
			}
			if (elem.absolutePriority >= level) {
				return renderWithLevelAndEarlyExitWithTokenEstimation(elem.children, level, tokenizer, tokenLimit);
			}
			return {
				prompt: undefined,
				emptyTokenCount: 0
			}
		}
	}
}

function recursivelyEject(elem: PromptElement) {
	if (elem === undefined || elem === null || elem === false || typeof elem === 'string' || typeof elem === 'number') {
		return;
	}
	if (Array.isArray(elem)) {
		elem.forEach(e => recursivelyEject(e));
	} else {
		if ('onEject' in elem && elem.onEject !== undefined && typeof elem.onEject === 'function') {
			elem.onEject();
		}
		if ('children' in elem && elem.children !== undefined && Array.isArray(elem.children)) {
			elem.children.forEach(e => recursivelyEject(e));
		}
	}
}

function hydrateEmptyTokenCount(elem: PromptElement, tokenizer: PriomptTokenizer): Promise<void> | undefined {
	if (elem === undefined || elem === null || elem === false) {
		return;
	}
	if (Array.isArray(elem)) {
		const results = elem.map(e => hydrateEmptyTokenCount(e, tokenizer));
		if (results.some(r => r !== undefined)) {
			return Promise.all(results.filter(r => r !== undefined)).then(() => { });
		} else {
			return undefined;
		}
	}
	if (typeof elem === 'string') {
		return;
	}
	if (typeof elem === 'number') {
		return;
	}
	switch (elem.type) {
		case 'chat':
		case 'scope':
		case 'first': {
			return hydrateEmptyTokenCount(elem.children, tokenizer);
		}
		case 'capture':
		case 'image':
		case 'isolate':
		case 'breaktoken':
		case 'config':
		case 'functionDefinition': {
			return;
		}
		case 'empty': {
			// check if we have a cached prompt
			if (elem.tokenCount === undefined) {
				const promise = (async () => {
					if (elem.tokenFunction === undefined) {
						throw new Error(`BUG!! empty token function is undefined. THIS SHOULD NEVER HAPPEN. BUG IN PRIOMPT.`);
					}
					elem.tokenCount = await elem.tokenFunction((s) => tokenizer.numTokens(s));
				})();
				return promise;
			}
			return;
		}
	}
}

function hydrateIsolates(elem: PromptElement, tokenizer: PriomptTokenizer): Promise<void> | undefined {
	if (elem === undefined || elem === null || elem === false) {
		return;
	}
	if (Array.isArray(elem)) {
		const results = elem.map(e => hydrateIsolates(e, tokenizer));
		if (results.some(r => r !== undefined)) {
			return Promise.all(results.filter(r => r !== undefined)).then(() => { });
		} else {
			return undefined;
		}
	}
	if (typeof elem === 'string') {
		return;
	}
	if (typeof elem === 'number') {
		return;
	}
	switch (elem.type) {
		case 'first': {
			return hydrateIsolates(elem.children, tokenizer);
		}
		case 'capture':
		case 'empty':
		case 'image':
		case 'breaktoken':
		case 'config':
		case 'functionDefinition': {
			return;
		}
		case 'isolate': {
			// check if we have a cached prompt
			if (elem.cachedRenderOutput === undefined) {
				const promise = (async () => {
					elem.cachedRenderOutput = await render(elem.children, {
						tokenizer,
						tokenLimit: elem.tokenLimit,
					})
				})();
				return promise;
			}
			return;
		}
		case 'chat': {
			return hydrateIsolates(elem.children, tokenizer);
		}
		case 'scope': {
			return hydrateIsolates(elem.children, tokenizer);
		}
	}
}
type SourceInfo = {
	name: string;
	isLast: boolean | undefined
}
// WARNING: do not attempt to make this function async!!! it will make it a lot slower!
function renderWithLevel(
	elem: PromptElement,
	level: number,
	tokenizer: PriomptTokenizer,
	callEjectedCallback?: boolean,
	sourceInfo?: SourceInfo
): RenderWithLevelPartialType {
	if (elem === undefined || elem === null || elem === false) {
		return {
			prompt: undefined,
			emptyTokenCount: 0,
			outputHandlers: [],
			streamHandlers: [],
			streamResponseObjectHandlers: [],
			sourceMap: undefined,
			config: {
				stop: undefined,
				maxResponseTokens: undefined,
				cacheKey: undefined,
			}
		};
	}
	if (Array.isArray(elem)) {
		const results = elem.map(
			(e, i) => renderWithLevel(
				e, level, tokenizer, callEjectedCallback,
				sourceInfo !== undefined ? {
					name: `${i}`,
					isLast: (sourceInfo.isLast === undefined || sourceInfo.isLast === true) && i === elem.length - 1,
				} : undefined
			)
		);
		const reducedResult = results.reduce((a, b) => {
			return {
				prompt: sumPrompts(a.prompt, b.prompt),
				emptyTokenCount: a.emptyTokenCount + b.emptyTokenCount,
				outputHandlers: a.outputHandlers.concat(b.outputHandlers),
				streamHandlers: a.streamHandlers.concat(b.streamHandlers),
				streamResponseObjectHandlers: a.streamResponseObjectHandlers.concat(b.streamResponseObjectHandlers),
				config: mergeConfigs(a.config, b.config),
			};
		}, {
			prompt: undefined,
			emptyTokenCount: 0,
			outputHandlers: [],
			streamHandlers: [],
			streamResponseObjectHandlers: [],
			config: emptyConfig(),
		});
		return {
			...reducedResult,
			sourceMap: sourceInfo === undefined ? undefined : mergeSourceMaps(results.map(r => r.sourceMap), sourceInfo.name)
		}
	}
	if (typeof elem === 'string') {
		return {
			prompt: elem,
			emptyTokenCount: 0,
			outputHandlers: [],
			streamHandlers: [],
			streamResponseObjectHandlers: [],
			sourceMap: sourceInfo !== undefined ? {
				name: sourceInfo.name,
				children: undefined,
				start: 0,
				end: elem.length,
				string: elem
			} : undefined,
			config: emptyConfig(),
		};
	}
	if (typeof elem === 'number') {
		const prompt = elem.toString();
		return {
			prompt,
			emptyTokenCount: 0,
			outputHandlers: [],
			streamHandlers: [],
			streamResponseObjectHandlers: [],
			sourceMap: sourceInfo !== undefined ? {
				name: sourceInfo.name,
				start: 0,
				end: prompt.length,
				string: prompt
			} : undefined,
			config: emptyConfig(),
		};
	}
	switch (elem.type) {
		case 'first': {
			for (const [i, child] of elem.children.entries()) {
				if (child.absolutePriority === undefined) {
					throw new Error(`BUG!! computePriorityLevels should have set absolutePriority for all children of first`);
				}
				if (child.absolutePriority >= level) {
					elem.onInclude?.();
					const result = renderWithLevel(child, level, tokenizer, callEjectedCallback, sourceInfo !== undefined ? {
						name: `${sourceInfo.name}.${i}`,
						isLast: (sourceInfo.isLast === undefined || sourceInfo.isLast === true) && i === elem.children.length - 1,
					} : undefined);
					return result
				} else if (callEjectedCallback === true) {
					recursivelyEject(child);
				}
			}
			// nothing returned from first, which is ok
			return {
				prompt: undefined,
				sourceMap: undefined,
				emptyTokenCount: 0,
				outputHandlers: [],
				streamHandlers: [],
				streamResponseObjectHandlers: [],
				config: emptyConfig(),
			};
		}
		case 'capture': {
			return {
				prompt: undefined,
				sourceMap: undefined,
				emptyTokenCount: 0,
				outputHandlers: elem.onOutput ? [
					elem.onOutput
				] : [],
				streamHandlers: elem.onStream ? [
					elem.onStream
				] : [],
				streamResponseObjectHandlers: elem.onStreamResponseObject ? [
					elem.onStreamResponseObject
				] : [],
				config: emptyConfig(),
			}
		}
		case 'config': {
			return {
				prompt: undefined,
				sourceMap: undefined,
				emptyTokenCount: 0,
				outputHandlers: [],
				streamHandlers: [],
				streamResponseObjectHandlers: [],
				config: elem
			}
		}
		case 'breaktoken': {
			return {
				prompt: ['', ''],
				sourceMap: undefined,
				emptyTokenCount: 0,
				outputHandlers: [],
				streamHandlers: [],
				streamResponseObjectHandlers: [],
				config: emptyConfig(),
			}
		}
		case 'empty': {
			if (elem.tokenCount === undefined) {
				throw new Error(`BUG!! empty token count is undefined. THIS SHOULD NEVER HAPPEN. BUG IN PRIOMPT.Empty token count should've been hydrated first!`);
			}
			return {
				prompt: undefined,
				sourceMap: undefined,
				emptyTokenCount: elem.tokenCount,
				outputHandlers: [],
				streamHandlers: [],
				streamResponseObjectHandlers: [],
				config: emptyConfig(),
			}
		}
		case 'functionDefinition': {
			const prompt: (TextPrompt & FunctionPrompt) = {
				type: 'text',
				text: "",
				functions: [
					{
						name: elem.name,
						description: elem.description,
						parameters: elem.parameters,
					}
				]
			};
			return {
				prompt,
				sourceMap: undefined,
				emptyTokenCount: 0,
				outputHandlers: [],
				streamHandlers: [],
				streamResponseObjectHandlers: [],
				config: emptyConfig(),
			}
		}
		case 'isolate': {
			// check if we have a cached prompt
			if (elem.cachedRenderOutput === undefined) {
				// throw error! we need to hydrate the isolates first!
				throw new Error(`BUG!! Isolates should have been hydrated before calling renderWithLevelAndEarlyExitWithTokenEstimation`);
			}
			return {
				prompt: elem.cachedRenderOutput.prompt,
				emptyTokenCount: elem.cachedRenderOutput.tokensReserved,
				outputHandlers: elem.cachedRenderOutput.outputHandlers,
				streamHandlers: elem.cachedRenderOutput.streamHandlers,
				streamResponseObjectHandlers: elem.cachedRenderOutput.streamResponseObjectHandlers,
				sourceMap: elem.cachedRenderOutput.sourceMap,
				config: emptyConfig(),
			}
		}
		case 'chat': {
			const p = renderWithLevel(elem.children, level, tokenizer, callEjectedCallback, sourceInfo !== undefined ? {
				name: `${elem.role}-message`,
				isLast: undefined,
			} : undefined);
			if (isChatPrompt(p.prompt)) {
				throw new Error(`Incorrect prompt: we have nested chat messages, which is not allowed!`);
			}

			let message: ChatPromptMessage;
			if (elem.role === 'user') {
				if (isPromptContent(p.prompt)) {
					message = {
						role: elem.role,
						name: elem.name,
						to: elem.to,
						content: p.prompt.content,
						images: p.prompt.images
					};
				} else {
					message = {
						role: elem.role,
						name: elem.name,
						to: elem.to,
						content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text ?? ""),
					};
				}
			} else if (elem.role === 'system') {
				if (isPromptContent(p.prompt)) {
					throw new Error('Did not expect images in system message')
				}
				message = {
					role: elem.role,
					to: elem.to,
					name: elem.name,
					content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text ?? ""),
				};
			} else if (elem.role === 'assistant') {
				if (isPromptContent(p.prompt)) {
					throw new Error('Did not expect images in assistant message')
				}
				if (elem.functionCall !== undefined) {
					message = {
						role: elem.role,
						to: elem.to,
						content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text),
						functionCall: elem.functionCall,
					}
				} else {
					message = {
						role: elem.role,
						to: elem.to,
						content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text ?? ""),
					}
				}
			} else if (elem.role === 'function') {
				if (isPromptContent(p.prompt)) {
					throw new Error('Did not expect images in function message')
				}
				message = {
					role: elem.role,
					to: elem.to,
					name: elem.name,
					content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text ?? ""),
				}
			} else if (elem.role === 'tool') {
				if (isPromptContent(p.prompt)) {
					throw new Error('Did not expect images in tool message')
				}
				message = {
					role: elem.role,
					name: elem.name,
					to: elem.to,
					content: isPlainPrompt(p.prompt) ? p.prompt : (p.prompt?.text ?? ""),
				}
			} else {
				const x: never = elem.role;
				throw new Error(`BUG!! Invalid role ${elem.role}`);
			}
			let sourceMap = p.sourceMap;
			if (sourceInfo !== undefined && p.sourceMap !== undefined) {
				sourceMap = getSourceMapForChat(message, tokenizer, p.sourceMap, sourceInfo);
			}
			return {
				prompt: {
					type: 'chat',
					messages: [message],
					functions: promptHasFunctions(p.prompt) ? p.prompt.functions : undefined
				},
				sourceMap,
				emptyTokenCount: p.emptyTokenCount,
				outputHandlers: p.outputHandlers,
				streamHandlers: p.streamHandlers,
				streamResponseObjectHandlers: p.streamResponseObjectHandlers,
				config: emptyConfig(),
			}
		}
		case 'scope': {
			if (elem.absolutePriority === undefined) {
				throw new Error(`BUG!! computePriorityLevels should have set absolutePriority for all scopes`);
			}
			if (elem.absolutePriority >= level) {
				elem.onInclude?.();
				const result = renderWithLevel(elem.children, level, tokenizer, callEjectedCallback, sourceInfo !== undefined ? {
					name: elem.name ?? 'scope',
					isLast: sourceInfo.isLast,
				} : undefined);
				return {
					...result,
					sourceMap: result.sourceMap !== undefined && sourceInfo !== undefined ? {
						name: sourceInfo.name,
						children: [result.sourceMap],
						start: 0,
						end: result.sourceMap.end
					} : undefined
				}
			} else if (callEjectedCallback === true) {
				recursivelyEject(elem);
			}

			return {
				prompt: undefined,
				emptyTokenCount: 0,
				outputHandlers: [],
				streamHandlers: [],
				streamResponseObjectHandlers: [],
				sourceMap: undefined,
				config: emptyConfig(),
			}
		}
		case 'image': {
			const base64EncodedBytes = Buffer.from(elem.bytes).toString('base64');
			return {
				prompt: {
					type: 'prompt_content',
					content: [],
					images: [{
						type: 'image_url',
						image_url: {
							url: `data:image/jpeg;base64,${base64EncodedBytes}`,
							detail: elem.detail,
							dimensions: elem.dimensions,
						}
					}],
				},
				// Count the number of tokens for the image
				emptyTokenCount: 0,
				outputHandlers: [],
				streamHandlers: [],
				streamResponseObjectHandlers: [],
				config: emptyConfig(),
			}
		}
	}
}

const getSourceMapForChat = (message: ChatPromptMessage, tokenizer: PriomptTokenizer, sourceMap: SourceMap, sourceInfo: SourceInfo) => {
	let headerStringForMessage;
	if (message.role === 'function') {
		console.error("SourceMap not implemented for functions");
		headerStringForMessage = "";
	} else {
		headerStringForMessage = tokenizer.getHeaderStringForMessage(message);
	}
	const children = [
		{
			name: 'header',
			children: [],
			start: 0,
			end: headerStringForMessage.length
		},
		{
			...sourceMap,
			start: headerStringForMessage.length,
			end: sourceMap.end + headerStringForMessage.length
		}
	]
	if (sourceInfo.isLast === null) {
		throw new Error(`BUG!! source.isLast should not be null`);
	}
	if ((sourceInfo.isLast === false) && tokenizer.shouldAddEosTokenToEachMessage) {
		children.push({
			name: 'eos',
			children: [],
			start: children[children.length - 1].end,
			end: children[children.length - 1].end + tokenizer.getEosToken().length
		})
	}
	return {
		name: 'chat',
		children,
		start: 0,
		end: children[children.length - 1].end
	}
}

const normalizeSourceMap = (sourceMap: SourceMap): SourceMap => {
	if (sourceMap.children === undefined) {
		return sourceMap
	}
	if (sourceMap.children.length === 0) {
		sourceMap.children = undefined
		return sourceMap
	}
	if (sourceMap.children.length === 1) {
		return normalizeSourceMap({
			name: `${sourceMap.name}.${sourceMap.children[0].name}`,
			children: sourceMap.children[0].children,
			start: sourceMap.start,
			end: sourceMap.end
		})
	} else {
		return {
			...sourceMap,
			children: sourceMap.children.map(normalizeSourceMap),
		}
	}
}

const mergeSourceMaps = (sourceMaps: (SourceMap | undefined)[], sourceName: string): SourceMap | undefined => {
	// We need to shift all of the non-root sourceMaps
	const filteredSourceMaps = sourceMaps.filter(s => s !== undefined) as SourceMap[];
	if (filteredSourceMaps.length === 0) {
		return undefined
	}
	const shiftedSourceMaps = [filteredSourceMaps[0]]
	for (const nextSourceMap of filteredSourceMaps.slice(1)) {
		if (nextSourceMap === undefined) {
			continue;
		}
		const newBase = shiftedSourceMaps[shiftedSourceMaps.length - 1].end;
		shiftedSourceMaps.push({
			...nextSourceMap,
			start: nextSourceMap.start + newBase,
			end: nextSourceMap.end + newBase
		})
	}
	return {
		name: sourceName,
		children: shiftedSourceMaps,
		start: 0,
		end: shiftedSourceMaps.reduce((a, b) => Math.max(a, b.end), 0)
	}
}


// TODO: make this into eslint rules so they can be shown in the IDE
function validateUnrenderedPrompt(elem: PromptElement): void {
	validateNoChildrenHigherPriorityThanParent(elem);

	// print a warning if any scope has both an absolute and relative priority
	validateNotBothAbsoluteAndRelativePriority(elem);
}

function validateNoUnhandledTypes(elem: PromptElement): void {
	if (Array.isArray(elem)) {
		for (const child of elem) {
			validateNoUnhandledTypes(child);
		}
		return;
	}

	if (elem === undefined || elem === null || elem === false) {
		return;
	}

	if (typeof elem === 'string') {
		return;
	}
	if (typeof elem === 'number') {
		return;
	}

	switch (elem.type) {
		case 'functionDefinition':
		case 'image':
		case 'empty': {
			return;
		}
		case 'chat':
		case 'scope': {
			validateNoUnhandledTypes(elem.children);
			return;
		}
		case 'isolate':
		case 'breaktoken':
		case 'config':
		case 'capture':
		case 'first': {
			throw new Error(`Priompt ERROR: prompt element type ${elem.type} is not handled`);
		}
	}

}


function validateNotBothAbsoluteAndRelativePriority(elem: PromptElement): void {
	if (Array.isArray(elem)) {
		for (const child of elem) {
			validateNotBothAbsoluteAndRelativePriority(child);
		}
		return;
	}

	if (elem === undefined || elem === null || elem === false) {
		return;
	}

	if (typeof elem === 'string') {
		return;
	}
	if (typeof elem === 'number') {
		return;
	}

	switch (elem.type) {
		case 'chat':
		case 'isolate':
		case 'first': {
			for (const child of elem.children) {
				validateNotBothAbsoluteAndRelativePriority(child);
			}
			return;
		}
		case 'capture':
		case 'breaktoken':
		case 'functionDefinition':
		case 'image':
		case 'config':
		case 'empty': {
			return;
		}
		case 'scope': {
			if (elem.absolutePriority !== undefined && elem.relativePriority !== undefined) {
				console.warn(`Priompt WARNING: scope has both absolute and relative priority.This is discouraged.Ignoring relative priority.`);
			}
			for (const child of elem.children) {
				validateNotBothAbsoluteAndRelativePriority(child);
			}
			return;
		}
	}
}

function validateNoChildrenHigherPriorityThanParent(elem: PromptElement, parentPriority: number = BASE_PRIORITY): void {
	if (Array.isArray(elem)) {
		for (const child of elem) {
			validateNoChildrenHigherPriorityThanParent(child, parentPriority);
		}
		return;
	}

	if (elem === undefined || elem === null || elem === false) {
		return;
	}

	if (typeof elem === 'string') {
		return;
	}
	if (typeof elem === 'number') {
		return;
	}

	switch (elem.type) {
		case 'chat':
		case 'first': {
			for (const child of elem.children) {
				validateNoChildrenHigherPriorityThanParent(child, parentPriority);
			}
			return;
		}
		case 'isolate': {
			// we explicitly do not send in the parent priority because the isolate is isolated!!
			validateNoChildrenHigherPriorityThanParent(elem.children);
			return;
		}
		case 'capture':
		case 'image':
		case 'breaktoken':
		case 'functionDefinition':
		case 'empty':
		case 'config': {
			return;
		}
		case 'scope': {
			const priority = computePriority(elem, parentPriority);
			if (priority > parentPriority) {
				console.warn(`Priompt WARNING: child scope has a higher priority(${priority}) than its parent(${parentPriority}).This is discouraged, because the child will only be included if the parent is, and thus the effective priority of the child is just the parent's priority.`);
			}
			for (const child of elem.children) {
				validateNoChildrenHigherPriorityThanParent(child, priority);
			}
			return;
		}
	}
}

function computePriority(elem: Scope | NormalizedScope, parentPriority: number) {
	return elem.absolutePriority ?? (parentPriority + (elem.relativePriority ?? 0));
}

type AnyNode = NormalizedNode | Node;

function computePriorityLevels(elem: AnyNode[] | AnyNode, parentPriority: number, levels: Set<number>): void {
	if (Array.isArray(elem)) {
		for (const child of elem) {
			computePriorityLevels(child, parentPriority, levels);
		}
		return;
	}

	if (elem === undefined || elem === null || elem === false) {
		return;
	}

	if (typeof elem === 'string') {
		return;
	}

	if (typeof elem === 'number') {
		return;
	}

	switch (elem.type) {
		case 'chat':
		case 'first': {
			// just do it for each child
			for (const child of elem.children) {
				computePriorityLevels(child, parentPriority, levels);
			}
			return;
		}
		case 'image':
		case 'capture':
		case 'functionDefinition':
		case 'breaktoken':
		case 'config':
		case 'empty': {
			// nothing happens
			return;
		}
		case 'isolate': {
			// nothing happens because we fully re-render
			return;
		}
		case 'scope': {
			// compute the priority of this scope
			// the absolutePriority takes precedence over the relativePriority
			const priority = computePriority(elem, parentPriority);
			levels.add(priority);
			// we make the elem have this priority, so that we don't need to redo the priority calculation
			elem.absolutePriority = priority;
			// then for each child
			for (const child of elem.children) {
				computePriorityLevels(child, priority, levels);
			}
			return;
		}
		case 'normalizedString': {
			// nothing happens
			return;
		}
	}

	throw new Error(`BUG!! computePriorityLevels got an invalid node of type ${typeof elem} (see the console log above)`);
}

type Countables = FunctionDefinition | NormalizedFunctionDefinition | string | number
function computePriorityLevelsTokensMapping(elem: NormalizedNode[] | NormalizedNode, parentPriority: number, mapping: Record<number, Countables[]>): void {

	if (Array.isArray(elem)) {
		for (const child of elem) {
			computePriorityLevelsTokensMapping(child, parentPriority, mapping);
		}
		return;
	}

	switch (elem.type) {
		case 'empty': {
			if (elem.tokenCount === undefined) {
				throw new Error(`BUG!! empty token count is undefined. THIS SHOULD NEVER HAPPEN. BUG IN PRIOMPT.Empty token count should've been hydrated first!`);
			}
			if (!(parentPriority in mapping)) {
				mapping[parentPriority] = [];
			}
			mapping[parentPriority].push(elem.tokenCount);
			return
		}
		case 'functionDefinition': {
			if (!(parentPriority in mapping)) {
				mapping[parentPriority] = [];
			}
			mapping[parentPriority].push(elem);
			return;
		}
		case 'chat': {
			if (!(parentPriority in mapping)) {
				mapping[parentPriority] = [];
			}
			mapping[parentPriority].push(CHATML_PROMPT_EXTRA_TOKEN_COUNT_CONSTANT);
			for (const child of elem.children) {
				computePriorityLevelsTokensMapping(child, parentPriority, mapping);
			}
			return;

		}
		case 'scope': {
			const priority = computePriority(elem, parentPriority);
			elem.absolutePriority = priority;

			if (!(priority in mapping)) {
				mapping[priority] = [];
			}

			for (const child of elem.children) {
				computePriorityLevelsTokensMapping(child, priority, mapping);
			}
			return;
		}
		case 'normalizedString': {
			if (!(parentPriority in mapping)) {
				mapping[parentPriority] = [];
			}

			mapping[parentPriority].push(elem.s);
			return;
		}
		case 'isolate':
		case 'breaktoken':
		case 'capture':
		case 'config':
		case 'image':
		case 'first': {
			throw new Error(`BUG!! computePriorityLevelsTokensMapping should not be called on a ${elem.type}!`);
		}
	}
}

async function numTokensPromptString(p: PromptString, tokenizer: PriomptTokenizer): Promise<number> {
	if (Array.isArray(p)) {
		// should be tokenized independently!!!!!!!
		const t = await Promise.all(p.map(s => tokenizer.numTokens(s)));
		return t.reduce((a, b) => a + b, 0);
	}
	return tokenizer.numTokens(p);
}

function numTokensPromptStringFast_UNSAFE(prompt: PromptString, tokenizer: PriomptTokenizer): number {
	if (Array.isArray(prompt)) {
		return prompt.reduce((a, b) => a + numTokensPromptStringFast_UNSAFE(b, tokenizer), 0);
	}
	return tokenizer.estimateNumTokensFast_SYNCHRONOUS_BE_CAREFUL(prompt)
}

function countTokensApproxFast_UNSAFE(tokenizer: PriomptTokenizer, prompt: RenderedPrompt, options: {
	lastMessageIsIncomplete?: boolean;
}): number {
	let tokens = 0;
	if (isPlainPrompt(prompt)) {
		tokens += numTokensPromptStringFast_UNSAFE(prompt, tokenizer);
	} else if (isChatPrompt(prompt)) {
		const msgTokens = prompt.messages.map(msg => countMsgTokensFast_UNSAFE(msg, tokenizer));
		// docs here: https://platform.openai.com/docs/guides/chat/introduction
		tokens += msgTokens.reduce((a, b) => a + b, 0) + CHATML_PROMPT_EXTRA_TOKEN_COUNT_LINEAR_FACTOR * (prompt.messages.length) + CHATML_PROMPT_EXTRA_TOKEN_COUNT_CONSTANT;
		if (options.lastMessageIsIncomplete === true) {
			// one for the <|im_end|>
			tokens = tokens - (CHATML_PROMPT_EXTRA_TOKEN_COUNT_CONSTANT + 1);
		}
	} else if (isPromptContent(prompt)) {
		// We count the tokens of each text element
		tokens += numTokensPromptStringFast_UNSAFE(prompt.content, tokenizer);
		if (prompt.images) {
			prompt.images.forEach(image => {
				// Fine because sync anyways
				tokens += numTokensForImage(image.image_url.dimensions, image.image_url.detail)
			});
		}
	} else {
		tokens += numTokensPromptStringFast_UNSAFE(prompt.text, tokenizer);
	}
	if (promptHasFunctions(prompt)) {
		// we assume an extra 2 tokens per function
		const functionTokens = prompt.functions.map((func) => {
			return countFunctionTokensApprox_SYNCHRONOUS_BE_CAREFUL(func, tokenizer) + 2;
		});
		tokens += functionTokens.reduce((a, b) => a + b, 0);
	}
	return tokens;
}
async function countTokensExact(tokenizer: PriomptTokenizer, prompt: RenderedPrompt, options: {
	lastMessageIsIncomplete?: boolean;
}): Promise<number> {
	let tokens = 0;
	if (isPlainPrompt(prompt)) {
		tokens += await numTokensPromptString(prompt, tokenizer);
	} else if (isChatPrompt(prompt)) {
		const msgTokens = await Promise.all(prompt.messages.map(msg => countMsgTokens(msg, tokenizer)));
		// docs here: https://platform.openai.com/docs/guides/chat/introduction
		tokens += msgTokens.reduce((a, b) => a + b, 0) + CHATML_PROMPT_EXTRA_TOKEN_COUNT_LINEAR_FACTOR * (prompt.messages.length) + CHATML_PROMPT_EXTRA_TOKEN_COUNT_CONSTANT;
		if (options.lastMessageIsIncomplete === true) {
			// one for the <|im_end|>
			tokens = tokens - (CHATML_PROMPT_EXTRA_TOKEN_COUNT_CONSTANT + 1);
		}
	} else if (isPromptContent(prompt)) {
		// We count the tokens of each text element
		tokens += await numTokensPromptString(prompt.content, tokenizer);
		if (prompt.images) {
			prompt.images.forEach(image => {
				tokens += numTokensForImage(image.image_url.dimensions, image.image_url.detail)
			});

		}
	} else {
		tokens += await numTokensPromptString(prompt.text, tokenizer);
	}
	if (promptHasFunctions(prompt)) {
		// we assume an extra 2 tokens per function
		const functionTokens = await Promise.all(prompt.functions.map(async (func) => {
			return await countFunctionTokens(func, tokenizer) + 2;
		}));
		tokens += functionTokens.reduce((a, b) => a + b, 0);
	}
	return tokens;
}

export function promptToOpenAIChatRequest(prompt: RenderedPrompt): { messages: Array<ChatCompletionRequestMessage>; functions: ChatCompletionFunctions[] | undefined } {
	const functions = promptHasFunctions(prompt) ? prompt.functions : undefined;
	const messages = promptToOpenAIChatMessages(prompt);
	return {
		messages,
		functions
	};
}


export function contentArrayToStringContent(content: Array<string | PromptContent>): string[] {
	const newContent: string[] = []
	content.forEach(c => {
		if (typeof c === 'string') {
			newContent.push(c);
		} else if (c.type === 'text') {
			newContent.push(c.text);
		} else if (c.type === 'image_url') {
			// Do nothing with images
		}
	});
	return newContent;

}

// a piece of context, e.g. a scraped doc, could include <|im_end|> strings and mess up the prompt... so please don't use it unless necessary
// it also does not have <breaktoken> support
export function promptToString_VULNERABLE_TO_PROMPT_INJECTION(prompt: RenderedPrompt, tokenizer: PriomptTokenizer): string {
	if (isPlainPrompt(prompt)) {
		// we should just encode it as a plain prompt!
		let s = "";
		if (Array.isArray(prompt)) {
			s = prompt.join('');
		} else {
			s = prompt;
		}
		return s;
	} else if (isChatPrompt(prompt)) {
		const parts = prompt.messages.map((msg) => {
			if (msg.role === 'function') {
				// let's just throw
				throw new Error(`BUG!! promptToString got a chat prompt with a function message, which is not supported yet!`);
			} else if (msg.role === 'assistant' && msg.functionCall !== undefined) {
				throw new Error(`BUG!! promptToString got a chat prompt with a function message, which is not supported yet!`);
			} else {
				const headerTokens = tokenizer.getHeaderStringForMessage(msg);
				let newContent: string[] | string | undefined = undefined
				if (Array.isArray(msg.content)) {
					// We just combine the tokens to a string array to get around images
					newContent = contentArrayToStringContent(msg.content);
				} else {
					newContent = msg.content;
				}
				return headerTokens + (newContent !== undefined ? (promptToString_VULNERABLE_TO_PROMPT_INJECTION(newContent, tokenizer)) : "");
			}
		});
		let final: string = "";
		for (const part of parts) {
			if (final.length > 0) {
				final += tokenizer.getEosToken();
			}
			final += part;
		}
		return final;
	}
	throw new Error(`BUG!! promptToString got an invalid prompt`);
}

// always leaves the last message "open"
export async function promptToTokens(prompt: RenderedPrompt, tokenizer: PriomptTokenizer): Promise<number[]> {
	if (isPlainPrompt(prompt)) {
		// we should just encode it as a plain prompt!
		if (Array.isArray(prompt)) {
			const tokens = await Promise.all(prompt.map(s => tokenizer.encodeTokens(s)));
			return tokens.reduce((a, b) => a.concat(b), []);
		}
		return tokenizer.encodeTokens(prompt);
	} else if (isChatPrompt(prompt)) {
		const messages = prompt.messages;
		messages.forEach(msg => {
			if (msg.role === 'function') {
				throw new Error(`BUG!! promptToTokens got a chat prompt with a function message, which is not supported yet!`);
			} else if (msg.role === 'assistant' && msg.functionCall !== undefined) {
				throw new Error(`BUG!! promptToTokens got a chat prompt with a function message, which is not supported yet!`);
			} else if (msg.content === undefined) {
				throw new Error(`BUG!! promptToTokens got a chat prompt with a message that is undefined!`);
			}
		})

		return await tokenizer.applyChatTemplateTokens(messages as {
			role: OpenAIMessageRole,
			name?: string,
			to?: string,
			content: string | string[]
		}[])
	}
	throw new Error(`BUG!! promptToTokens got an invalid prompt`);
}

export function openAIChatMessagesToPrompt(messages: ChatCompletionRequestMessage[]): ChatPrompt {
	return {
		type: "chat",
		messages: messages.map(m => {
			let c: ChatPromptMessage;
			if (Array.isArray(m.content)) {
				if (m.role === "function") {
					c = {
						role: "function",
						to: undefined,
						content: m.content.map(c => c.type === 'text' ? c.text : "").join(""),
						name: m.name ?? "",
					}
					return c;
				}
				c = {
					role: m.role,
					to: undefined,
					content: m.content.map(c => c.type === 'text' ? c.text : "").join(""),
					images: m.content.filter(c => c.type === 'image_url') as ImagePromptContent[],
				}
				return c;
			} else {
				if (m.role === "function") {
					c = {
						role: "function",
						to: undefined,
						content: m.content ?? "",
						name: m.name ?? "",
					}
					return c;
				}
				c = {
					role: m.role,
					to: undefined,
					content: m.content ?? ""
				}
				return c;
			}
		})
	}
}

export function promptToOpenAIChatMessages(prompt: RenderedPrompt): Array<ChatCompletionRequestMessage> {
	if (isPlainPrompt(prompt)) {
		return [
			{
				role: 'user',
				content: promptStringToString(prompt)
			}
		];
	} else if (isChatPrompt(prompt)) {
		return prompt.messages.map(msg => {
			if (msg.role === 'function') {
				return {
					role: msg.role,
					name: msg.name,
					content: promptStringToString(msg.content),
				}
			} else if (msg.role === 'tool') {
				// openai chat messages do not support the tool role... (i think)
				// so we put it in a system message instead!
				return {
					role: "system",
					name: msg.name,
					content: promptStringToString(msg.content),
				}
			} else if (msg.role === 'assistant' && msg.functionCall !== undefined) {
				return {
					role: msg.role,
					content: msg.content !== undefined ? promptStringToString(msg.content) : "", // openai is lying when they say this should not be provided
					function_call: msg.functionCall,
				}
			} else if (msg.role === 'assistant') {
				return {
					role: msg.role,
					content: msg.content !== undefined ? promptStringToString(msg.content) : "", // openai is lying when they say this should not be provided
				}
			} else if (msg.role === 'system') {
				return {
					role: msg.role,
					name: msg.name,
					content: msg.content !== undefined ? promptStringToString(msg.content) : "", // openai is lying when they say this should not be provided
				}
			} else {
				if (msg.images && msg.images.length > 0) {
					// We format the content
					const content: Content[] = [];
					// First, we add the image
					content.push(...msg.images)
					// Then we add the text
					const textContent = msg.content !== undefined ? promptStringToString(msg.content) : "";
					content.push({
						type: 'text',
						text: textContent
					})
					// Import new openai api version to support images
					return {
						role: msg.role,
						content: content,
						name: 'name' in msg ? msg.name : undefined,
					}
				} else {
					return {
						role: msg.role,
						content: msg.content !== undefined ? promptStringToString(msg.content) : '',
						name: 'name' in msg ? msg.name : undefined,
					}
				}
			}
		});
	}
	throw new Error(`BUG!! promptToOpenAIChatMessagesgot an invalid prompt`);
}

function countMsgTokensFast_UNSAFE(message: ChatPromptMessage, tokenizer: PriomptTokenizer): number {
	if (message.role === 'function') {
		// add an extra 2 tokens for good measure
		return (tokenizer.estimateNumTokensFast_SYNCHRONOUS_BE_CAREFUL(message.name)) + (numTokensPromptStringFast_UNSAFE(message.content, tokenizer)) + 2;
	} else if (message.role === 'assistant' && message.functionCall !== undefined) {
		return (countFunctionCallMessageTokensFast_UNSAFE(message.functionCall, tokenizer)) + (message.content !== undefined ? (numTokensPromptStringFast_UNSAFE(message.content, tokenizer)) : 0);
	} else {
		let numTokens = numTokensPromptStringFast_UNSAFE(message.content ?? "", tokenizer);
		if (message.role === 'user' && message.images !== undefined) {
			message.images.forEach(image => {
				// numTokensForImage is synchronous and fast anyways, so nothing needed here
				numTokens += numTokensForImage(image.image_url.dimensions, image.image_url.detail);
			});
		}
		return numTokens;
	}
}
export async function countMsgTokens(message: ChatPromptMessage, tokenizer: PriomptTokenizer): Promise<number> {
	if (message.role === 'function') {
		// add an extra 2 tokens for good measure
		return (await tokenizer.numTokens(message.name)) + (await numTokensPromptString(message.content, tokenizer)) + 2;
	} else if (message.role === 'assistant' && message.functionCall !== undefined) {
		return (await countFunctionCallMessageTokens(message.functionCall, tokenizer)) + (message.content !== undefined ? (await numTokensPromptString(message.content, tokenizer)) : 0);
	} else {
		let numTokens = await numTokensPromptString(message.content ?? "", tokenizer);
		if (message.role === 'user' && message.images !== undefined) {
			message.images.forEach(image => {
				numTokens += numTokensForImage(image.image_url.dimensions, image.image_url.detail);
			});
		}
		return numTokens;
	}
}

async function countFunctionCallMessageTokens(functionCall: { name: string; arguments: string; }, tokenizer: PriomptTokenizer): Promise<number> {
	// add some constant factor here because who knows what's actually going on with functions
	return (await tokenizer.numTokens(functionCall.name)) + (await tokenizer.numTokens(functionCall.arguments)) + 5;
}
function countFunctionCallMessageTokensFast_UNSAFE(functionCall: { name: string; arguments: string; }, tokenizer: PriomptTokenizer): number {
	// add some constant factor here because who knows what's actually going on with functions
	return (tokenizer.estimateNumTokensFast_SYNCHRONOUS_BE_CAREFUL(functionCall.name)) + (tokenizer.estimateNumTokensFast_SYNCHRONOUS_BE_CAREFUL(functionCall.arguments)) + 5;
}

async function countFunctionTokens(functionDefinition: ChatAndFunctionPromptFunction, tokenizer: PriomptTokenizer): Promise<number> {
	// hmmmm how do we count these tokens? openai has been quite unclear
	// for now we JSON stringify and count tokens, and hope that that is reasonably close
	const stringifiedFunction = JSON.stringify({
		name: functionDefinition.name,
		description: functionDefinition.description,
		parameters: functionDefinition.parameters,
	}, null, 2);
	// we multiply by 1.5 and add 10 just to be safe until we've done more testing
	const raw = await tokenizer.numTokens(stringifiedFunction);
	return Math.ceil(raw * 1.5) + 10;
}

function countFunctionTokensApprox_SYNCHRONOUS_BE_CAREFUL(functionDefinition: ChatAndFunctionPromptFunction, tokenizer: PriomptTokenizer): number {
	// hmmmm how do we count these tokens? openai has been quite unclear
	// for now we JSON stringify and count tokens, and hope that that is reasonably close
	const stringifiedFunction = JSON.stringify({
		name: functionDefinition.name,
		description: functionDefinition.description,
		parameters: functionDefinition.parameters,
	}, null, 2);
	// we multiply by 1.5 and add 10 just to be safe until we've done more testing
	const raw = tokenizer.estimateNumTokensFast_SYNCHRONOUS_BE_CAREFUL(stringifiedFunction);
	return Math.ceil(raw * 1.5) + 10;
}


function estimateFunctionTokensUsingCharcount(functionDefinition: ChatAndFunctionPromptFunction, tokenizer: PriomptTokenizer): [number, number] {
	const stringifiedFunction = JSON.stringify({
		name: functionDefinition.name,
		description: functionDefinition.description,
		parameters: functionDefinition.parameters,
	}, null, 2);
	const raw = tokenizer.estimateTokensUsingCharCount(stringifiedFunction);
	// we multiply by 1.5 and add 10 just to be safe until we've done more testing for the upper bound
	return [Math.ceil(raw[0] * 0.5), Math.ceil(raw[1] * 1.5) + 10];
}

function estimateLowerBoundTokensForPrompt(prompt: RenderedPrompt | undefined, tokenizer: PriomptTokenizer): number {
	if (prompt === undefined) {
		return 0;
	}
	let contentTokens;
	if (isChatPrompt(prompt)) {
		contentTokens = prompt.messages.reduce((a, b) => {
			if (b.role === 'function') {
				// since this is a lower bound, we assume there are no extra tokens here
				return a + tokenizer.estimateTokensUsingCharCount(b.name + b.content)[0];
			} else if (b.role === 'assistant' && b.functionCall !== undefined) {
				return a + tokenizer.estimateTokensUsingCharCount(b.functionCall.name + b.functionCall.arguments + (b.content ?? ""))[0];
			} else {
				return a + tokenizer.estimateTokensUsingCharCount(b.content !== undefined ? promptStringToString(b.content) : "")[0];
			}
		}, 0);
	} else if (isPlainPrompt(prompt)) {
		contentTokens = tokenizer.estimateTokensUsingCharCount(promptStringToString(prompt))[0];
	} else if (isPromptContent(prompt)) {
		contentTokens = tokenizer.estimateTokensUsingCharCount(promptStringToString(prompt.content))[0];
	} else {
		contentTokens = tokenizer.estimateTokensUsingCharCount(promptStringToString(prompt.text))[0];
	}

	const functionTokens = (promptHasFunctions(prompt) ? prompt.functions.reduce((a, b) => (a + estimateFunctionTokensUsingCharcount(b, tokenizer)[0]), 0) : 0);

	return contentTokens + functionTokens;
}

export class TooManyTokensForBasePriority extends Error {
	constructor(message?: string) {
		super(message);
		this.name = "TooManyTokensForBasePriority";
	}
}
