import { LLMService, createLLMService } from './llm.svc';
import { StyleAnalysisDB } from '../db/style_analysis';
import { SubscriptionsDB } from '../db/subscriptions';
import { ClassificationService, createClassificationService } from './classification.svc';
import { STYLE_ANALYSIS_SYSTEM_PROMPT } from '../llm/prompts/style_analysis';
import { MessageEntry } from '../utils/types';
import { ModelProvider, ModelUseCase } from './model_config.svc';
import { generateTitle } from '../utils/style_analysis_session.utils';
import { SubscriptionTier } from '../types';
import { createStyleAnalysisDB, createSubscriptionsDB } from '../db';
import { env } from 'cloudflare:workers';

export class StyleAnalysisService {
	constructor(
		private llmService: LLMService,
		private styleAnalysisDB: StyleAnalysisDB,
		private subscriptionsDB: SubscriptionsDB,
		private classificationService: ClassificationService,
		private envVars: any
	) { }

	/**
	 * Creates a new session with initial messages and triggers background processes.
	 */
	async createSession(params: {
		userId: string;
		messages: MessageEntry[];
		title?: string;
		ctx?: ExecutionContext;
	}) {
		const { userId, messages, title, ctx } = params;
		const subscription = await this.subscriptionsDB.getSubscriptionByUserId(userId);
		const currentUserTier = subscription?.tier || SubscriptionTier.Free;
		const hasReachedLimit = subscription?.has_reached_limit === 1;

		if (currentUserTier === SubscriptionTier.Free && hasReachedLimit) {
			throw new Error('FREE_LIMIT_REACHED: Upgrade to GoStylens Core for unlimited sessions.');
		}

		// Create session with initial message
		const sessionResult = await this.styleAnalysisDB.createSessionWithInitialMessage({ userId, title, messages });

		// Fire off all async background tasks
		this.triggerOnCreateSessionBackgroundTasks({
			sessionId: sessionResult.sessionId,
			messageIds: sessionResult.messageIds,
			title,
			messages,
			userId,
			currentUserTier,
			ctx
		});

		return sessionResult;
	}

	/**
	 * Retrieves session messages filtered by context mode and converted to MessageEntry format.
	 * Returns messages in chronological order (oldest first), ready for the LLM.
	 */
	async getLLMContextSessionMessages(params: {
		sessionId: string;
		userId: string;
		contextMode?: 'all' | 'recent' | 'last';
		recentCount?: number;
	}): Promise<MessageEntry[]> {
		const { sessionId, userId, contextMode = 'recent', recentCount = 10 } = params;

		const session = await this.styleAnalysisDB.getSession(sessionId, userId);
		if (!session) {
			throw new Error('NOT_FOUND: Session not found or access denied');
		}

		const { messages: allMessages } = await this.styleAnalysisDB.getSessionMessages(sessionId);

		// Filter based on context mode
		let messagesToSend: typeof allMessages;

		switch (contextMode) {
			case 'all':
				messagesToSend = allMessages;
				break;

			case 'last':
				const lastUserMessage = allMessages.find((msg) => msg.role === 'user');
				messagesToSend = lastUserMessage ? [lastUserMessage] : [];
				break;

			case 'recent':
			default:
				// Messages come back in DESC order, so slice from the start
				messagesToSend = allMessages.slice(0, recentCount);
				break;
		}

		// Convert DB rows to MessageEntry format
		const messageEntries: MessageEntry[] = messagesToSend.map((m) => ({
			role: m.role as 'user' | 'assistant' | 'system',
			prompt: m.content || undefined,
			remoteImage: m.image_url || m.image_key ? { url: m?.image_url || '', key: m.image_key || '' } : undefined,
			remoteImages: m.images ? m.images.map(img => ({ url: img.url, key: img.key })) : undefined,
		}));

		// Return in chronological order (oldest first)
		return messageEntries.reverse();
	}

	/**
	 * Adds a single message to an existing session and triggers background classification.
	 */
	async addMessageToSession(params: {
		sessionId: string;
		userId: string;
		message: MessageEntry;
		ctx?: ExecutionContext;
	}) {
		const { sessionId, userId, message, ctx } = params;
		const session = await this.styleAnalysisDB.getSession(sessionId, userId);
		if (!session) {
			throw new Error('NOT_FOUND: Session not found or access denied');
		}

		const messageEntryId = await this.styleAnalysisDB.addMessage({
			sessionId,
			role: message.role,
			content: message.prompt,
			remoteImage: message.remoteImage,
			remoteImages: message.remoteImages,
		});
		// Trigger classification in the background (previous message resolved internally)
		this.classificationService.tagEntryInBackground(messageEntryId, message, ctx as ExecutionContext, sessionId);

		return { sessionId, messageId: messageEntryId };
	}

	/**
	 * Generates a streaming response for the style analysis session,
	 * injecting the persona and dynamically fetching session memory.
	 */
	async generateStyleAdviceStream(params: {
		sessionId: string;
		messages: MessageEntry[];
		onComplete?: (completeStreamText: string) => Promise<void> | void;
		signal?: AbortSignal;
	}): Promise<ReadableStream> {
		const { sessionId, messages, onComplete, signal } = params;
		// 1. Fetch chronologically ordered session memory
		const memoryItems = await this.styleAnalysisDB.getSessionMemory(sessionId);

		// 2. Build unified text context block and collect associated images
		let memoryContext = '';
		const contextImages: MessageEntry[] = [];

		if (memoryItems.length > 0) {
			const textItems = memoryItems.filter(item => item.images.length === 0);
			const imageItems = memoryItems.filter(item => item.images.length > 0);

			// Build text-only memory block (occasions, constraints, preferences)
			if (textItems.length > 0) {
				const textLines = textItems.map(item => `- ${item.label}: ${item.summary}`);
				memoryContext = `\n\n[SESSION MEMORY]\n${textLines.join('\n')}`;
			}

			// Build image context messages using their summaries as prompts
			for (let i = 0; i < imageItems.length; i++) {
				const item = imageItems[i];
				const isLatest = i === imageItems.length - 1;
				contextImages.push({
					role: 'user',
					prompt: isLatest ? `[LATEST] ${item.summary}` : item.summary,
					remoteImages: item.images
				});
			}
		}

		// 3. Create the developer payload encapsulating the persona and current memory state
		const systemMessage: MessageEntry = {
			role: 'system',
			prompt: STYLE_ANALYSIS_SYSTEM_PROMPT + memoryContext
		};

		// 4. Assemble the full message sequence:
		//    [system] → [session images in chronological order] → [conversation history]
		const messagesChronological = [systemMessage, ...contextImages, ...messages];

		// 5. Structure LLM Inputs and execute stream
		const preparedMessages = await this.llmService.prepareMessagesForLLM(messagesChronological);

		return this.llmService.generateStreamingResponse(sessionId, preparedMessages, onComplete, signal);
	}

	/**
	 * Orchestrates all non-blocking background tasks after session creation.
	 */
	private triggerOnCreateSessionBackgroundTasks(params: {
		sessionId: string;
		messageIds: string[];
		title?: string;
		messages: MessageEntry[];
		userId: string;
		currentUserTier: SubscriptionTier;
		ctx?: ExecutionContext;
	}) {
		const { sessionId, messageIds, title, messages, userId, currentUserTier, ctx } = params;

		if (!title) {
			this.generateTitleInBackground({ sessionId, messages, ctx });
		}

		this.checkFreeTierLimitInBackground({ userId, currentUserTier, ctx });

		this.classifyMessagesInBackground({ sessionId, messageIds, messages, ctx });
	}

	/**
	 * Generates a session title asynchronously via LLM and persists it.
	 */
	private generateTitleInBackground(params: {
		sessionId: string;
		messages: MessageEntry[];
		ctx?: ExecutionContext;
	}) {
		const { sessionId, messages, ctx } = params;

		const promise = (async () => {
			try {
				const generated = await generateTitle(messages, { timeoutMs: 30000 });
				if (generated) {
					await this.styleAnalysisDB.updateSessionTitle(sessionId, generated);
				}
			} catch (err) {
				console.warn('Async title update failed for session', sessionId, err);
			}
		})();

		if (ctx?.waitUntil) {
			ctx.waitUntil(promise);
		}
	}

	/**
	 * Checks whether a free-tier user has hit the session limit and flags the subscription.
	 */
	private checkFreeTierLimitInBackground(params: {
		userId: string;
		currentUserTier: SubscriptionTier;
		ctx?: ExecutionContext;
	}) {
		const { userId, currentUserTier, ctx } = params;

		const promise = (async () => {
			try {
				if (currentUserTier === SubscriptionTier.Free) {
					const freeTierLimit = parseInt((this.envVars as any).FREE_TIER_SESSION_LIMIT || '3', 10);
					const totalSessionsCount = await this.styleAnalysisDB.countTotalSessions(userId);
					if (totalSessionsCount >= freeTierLimit) {
						const sub = await this.subscriptionsDB.getSubscriptionByUserId(userId);
						if (sub && sub.id) {
							await this.subscriptionsDB.updateSubscription(sub.id, { has_reached_limit: 1 });
						}
					}
				}
			} catch (err) {
				console.warn('Async limit check failed for user', userId, err);
			}
		})();

		if (ctx?.waitUntil) {
			ctx.waitUntil(promise);
		}
	}

	/**
	 * Triggers background classification for each message in the session.
	 */
	private classifyMessagesInBackground(params: {
		sessionId: string;
		messageIds: string[];
		messages: MessageEntry[];
		ctx?: ExecutionContext;
	}) {
		const { sessionId, messageIds, messages, ctx } = params;

		for (let i = 0; i < messages.length; i++) {
			const previousMessage = i > 0 ? messages[i - 1] : null;
			this.classificationService.tagEntryInBackground(messageIds[i], messages[i], ctx as ExecutionContext, sessionId, previousMessage);
		}
	}
}

export const createStyleAnalysisService = (providedEnv?: any) => {
	// Fallback to imported env if not provided
	const applicationEnv = providedEnv || env;

	const llmService = createLLMService({ useCase: ModelUseCase.STYLE_ANALYSIS, provider: ModelProvider.CLAUDE });
	const styleAnalysisDB = createStyleAnalysisDB(applicationEnv.gostylens_db);
	const subscriptionsDB = createSubscriptionsDB(applicationEnv.gostylens_db);
	const classificationService = createClassificationService(applicationEnv.gostylens_db);

	return new StyleAnalysisService(
		llmService,
		styleAnalysisDB,
		subscriptionsDB,
		classificationService,
		applicationEnv
	);
};
