
// First picks out the first child (in order) that is prioritized enough
// It is a REQUIREMENT that the children have decreasing token counts
export type First = {
	type: 'first';
	children: Scope[];
};

export type Empty = {
	type: 'empty';
	tokenCount: number;
};

// the scope will exist iff the final priority is lower than the priority here
// it shouldn't be the case that both the relative priority and the absolute priority is set
export type Scope = {
	type: 'scope';
	children: Node[];
	// absolute priority takes precedence over relative priority
	absolutePriority: number | undefined;
	// relativePriority is relative to the parent of this scope
	// it should always be negative (or else it will not be displayed)
	relativePriority: number | undefined;
};

export type ChatMessage = {
	type: 'chat';
	role: 'user' | 'assistant' | 'system';
	children: Node[];
}


export type Node = First | Scope | Empty | ChatMessage | string | null | undefined | number;

export type PromptElement = Node[] | Node;

export type BaseProps = {
	// absolute priority takes precedence over relative priority
	// maximum supported priority level is 1e6
	p?: number;
	prel?: number;
	// TODO: add a max (token count) here. the max functions as follows:
	// first we optimize over the outest token count scope. if any max exceeds its token count, it is capped to the token count. once we have a global solution we seek the local solution
	// this works, but leads to something that may be a little bit weird: something of priority 1000 in a maxed out scope is not included while something with a priority of 0 outside the maxed out scope is included. but that's fine. i guess the whole point of the max is to break the global opptimization
	children?: PromptElement[] | PromptElement;
};

export type PromptProps<T = Record<never, never>> = (keyof T extends never ? BaseProps : BaseProps & T);

export namespace JSX {
	interface IntrinsicElements {
		scope: BaseProps;
		br: Omit<BaseProps, 'children'>;
		hr: Omit<BaseProps, 'children'>;
		// automatically use a certain number of tokens (useful for leaving space for the model to give its answer)
		empty: BaseProps & { tokens: number; };
		first: Omit<Omit<BaseProps, 'p'>, 'prel'>;
	}
	type Element = PromptElement;
	interface ElementAttributesProperty {
		props: BaseProps; // specify the property name to use
	}
}

export type ChatPromptMessage = {
	role: 'user' | 'assistant' | 'system';
	content: string;
};

export type ChatPrompt = {
	type: 'chat';
	messages: ChatPromptMessage[];
}

export type Prompt = string | ChatPrompt;