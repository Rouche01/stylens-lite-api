import { LLMService, createLLMService } from './llm.svc';
import { StyleAnalysisDB } from '../db/style_analysis';
import { SubscriptionsDB } from '../db/subscriptions';
import { UserLimitsDB } from '../db/user_limits';
import { ClassificationService, createClassificationService } from './classification.svc';
import { STYLE_ANALYSIS_SYSTEM_PROMPT } from '../llm/prompts/style_analysis';
import { MessageEntry } from '../utils/types';
import { ModelProvider, ModelUseCase } from './model_config.svc';
import { generateTitle } from '../utils/style_analysis_session.utils';
import { SubscriptionTier } from '../types';
import { createStyleAnalysisDB, createSubscriptionsDB, createUserLimitsDB } from '../db';
import { env } from 'cloudflare:workers';
import { RealtimeService, createRealtimeService } from './realtime.svc';
import { createVoltMemService, type VoltMemService } from './voltmem.svc';
import { createLogger } from '../utils/logger.utils';

export class StyleAnalysisService {
	constructor(
		private llmService: LLMService,
		private styleAnalysisDB: StyleAnalysisDB,
		private subscriptionsDB: SubscriptionsDB,
		private userLimitsDB: UserLimitsDB,
		private realtimeService: RealtimeService,
		private classificationService: ClassificationService,
		private envVars: any,
		private voltmem: VoltMemService | null = null
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
		const limits = await this.getEffectiveLimits(userId);

		// Check session count limit
		if (limits.sessionCountLimit !== -1) {
			const totalSessionsCount = await this.styleAnalysisDB.countTotalSessions(userId);
			if (totalSessionsCount >= limits.sessionCountLimit) {
				throw new Error('FREE_LIMIT_REACHED: Session limit reached. Upgrade for more sessions.');
			}
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
			remoteImage: m.image_url || m.image_key ? { url: m?.image_url || '', key: m.image_key || '', blurHash: m.images?.[0]?.blurHash } : undefined,
			remoteImages: m.images ? m.images.map(img => ({ url: img.url, key: img.key, ...(img.blurHash ? { blurHash: img.blurHash } : {}) })) : undefined,
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

		const limits = await this.getEffectiveLimits(userId);

		// Check message count limit for this session
		if (limits.messagePerSessionLimit !== -1) {
			const { total: messageCount } = await this.styleAnalysisDB.getSessionMessages(sessionId, { page: 1, pageSize: 1 });
			if (messageCount >= limits.messagePerSessionLimit) {
				throw new Error('FREE_LIMIT_REACHED: Maximum messages for this session reached. Start a new session or upgrade.');
			}
		}

		// Check image count limit for this session
		if (limits.imagePerSessionLimit !== -1) {
			// Count total images in the session
			const { messages: sessionMessages } = await this.styleAnalysisDB.getSessionMessages(sessionId, { page: 1, pageSize: 1000 });
			const totalImages = sessionMessages.reduce((sum, msg) => sum + (msg.images?.length || 0), 0);

			// Count images in the incoming message
			const incomingImageCount = (message.remoteImage ? 1 : 0) + (message.remoteImages?.length || 0);

			if (totalImages + incomingImageCount > limits.imagePerSessionLimit) {
				throw new Error('FREE_LIMIT_REACHED: Maximum images for this session reached.');
			}
		}

		const messageEntryId = await this.styleAnalysisDB.addMessage({
			sessionId,
			role: message.role,
			content: message.prompt,
			remoteImage: message.remoteImage,
			remoteImages: message.remoteImages,
		});
		// Trigger classification in the background (previous message resolved internally)
		this.classificationService.tagEntryInBackground(
			messageEntryId,
			message,
			ctx as ExecutionContext,
			sessionId,
			undefined,
			userId
		);

		return { sessionId, messageId: messageEntryId };
	}

	/**
	 * Generates a streaming response for the style analysis session,
	 * injecting the persona and dynamically fetching session + cross-session memory.
	 */
	async generateStyleAdviceStream(params: {
		sessionId: string;
		userId: string;
		messages: MessageEntry[];
		onComplete?: (completeStreamText: string) => Promise<void> | void;
		signal?: AbortSignal;
	}): Promise<ReadableStream> {
		const { sessionId, userId, messages, onComplete, signal } = params;
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

		// 2b. Cross-session USER MEMORY from VoltMem (fail-open; session memory stays first)
		let userMemoryContext = '';
		if (this.voltmem) {
			const hits = await this.voltmem.searchPrefs(
				userId,
				'style preferences constraints occasion',
				5
			);
			if (hits.length > 0) {
				const lines = hits.map((h) => `- ${h.memory} (domain=${h.domain})`);
				userMemoryContext = `\n\n[USER MEMORY]\n${lines.join('\n')}`;
			}

			if (this.envVars.ENV_NAME !== 'production') {
				const log = createLogger({ env: this.envVars.ENV_NAME }).child({ service: 'voltmem' });
				const stats = await this.voltmem.domainStats(userId);
				const auditSummary = stats
					? Object.entries(stats)
							.map(([domain, s]) => `${domain}:${s.audit_rate ?? 0}`)
							.join(',')
					: '';
				log.info('voltmem_prompt_injection', {
					user_id: userId,
					session_id: sessionId,
					hit_count: hits.length,
					domain_audit_rates: auditSummary || undefined,
				});
			}
		}

		// 3. Create the developer payload encapsulating the persona and current memory state
		const systemMessage: MessageEntry = {
			role: 'system',
			prompt: STYLE_ANALYSIS_SYSTEM_PROMPT + memoryContext + userMemoryContext
		};

		// 4. Assemble the full message sequence:
		//    [system + SESSION MEMORY + USER MEMORY] → [session images] → [conversation history]
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
		ctx?: ExecutionContext;
	}) {
		const { sessionId, messageIds, title, messages, userId, ctx } = params;

		if (!title) {
			this.generateTitleInBackground({ sessionId, messages, ctx });
		}

		this.classifyMessagesInBackground({ sessionId, messageIds, messages, userId, ctx });

		// Sync the has_reached_limit flag in the background for UI consistency
		this.syncSessionLimitFlagInBackground({ userId, ctx });
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
	 * Triggers background classification for each message in the session.
	 */
	private classifyMessagesInBackground(params: {
		sessionId: string;
		messageIds: string[];
		messages: MessageEntry[];
		userId: string;
		ctx?: ExecutionContext;
	}) {
		const { sessionId, messageIds, messages, userId, ctx } = params;

		for (let i = 0; i < messages.length; i++) {
			const previousMessage = i > 0 ? messages[i - 1] : null;
			this.classificationService.tagEntryInBackground(
				messageIds[i],
				messages[i],
				ctx as ExecutionContext,
				sessionId,
				previousMessage,
				userId
			);
		}
	}

	/**
	 * Syncs the global has_reached_limit flag in the subscription table based on current session count.
	 * This is primarily used for UI consistency in the mobile app (e.g., showing upgrade banners).
	 */
	public syncSessionLimitFlagInBackground(params: {
		userId: string;
		ctx?: ExecutionContext;
	}) {
		const { userId, ctx } = params;

		const promise = (async () => {
			try {
				const limits = await this.getEffectiveLimits(userId);
				const sub = await this.subscriptionsDB.getSubscriptionByUserId(userId);
				if (!sub) return;

				let hasReachedLimit = 0;
				if (limits.sessionCountLimit !== -1) {
					const totalSessionsCount = await this.styleAnalysisDB.countTotalSessions(userId);
					if (totalSessionsCount >= limits.sessionCountLimit) {
						hasReachedLimit = 1;
					}
				}

				// Only update if the flag has actually changed
				if (sub.has_reached_limit !== hasReachedLimit) {
					await this.subscriptionsDB.updateSubscription(sub.id, { has_reached_limit: hasReachedLimit as 0 | 1 });
					// Notify the Flutter app in real-time via Supabase Broadcast
					await this.realtimeService.notifyLimitChanged(userId, hasReachedLimit === 1);
				}
			} catch (err) {
				console.warn('Async session limit sync failed for user', userId, err);
			}
		})();

		if (ctx?.waitUntil) {
			ctx.waitUntil(promise);
		}
	}

	/**
	 * Resolves effective limits for a user based on overrides, tier, and global defaults.
	 */
	public async getEffectiveLimits(userId: string) {
		const override = await this.userLimitsDB.getUserLimit(userId);
		const subscription = await this.subscriptionsDB.getSubscriptionByUserId(userId);
		const tier = subscription?.tier || SubscriptionTier.Free;

		// Session Count Limit
		let sessionCountLimit = override?.session_count_limit ?? (tier === SubscriptionTier.Core ? -1 : parseInt(this.envVars.FREE_TIER_SESSION_LIMIT || '3', 10));

		// Message Per Session Limit
		let messagePerSessionLimit = override?.message_per_session_limit ?? (tier === SubscriptionTier.Core ? -1 : 20); // Default 20 for Free

		// Image Per Session Limit
		let imagePerSessionLimit = override?.image_per_session_limit ?? (tier === SubscriptionTier.Core ? -1 : 10); // Default 10 for Free

		return {
			sessionCountLimit,
			messagePerSessionLimit,
			imagePerSessionLimit
		};
	}
}

export const createStyleAnalysisService = (providedEnv?: any) => {
	// Fallback to imported env if not provided
	const applicationEnv = providedEnv || env;

	const llmService = createLLMService({ useCase: ModelUseCase.STYLE_ANALYSIS, provider: ModelProvider.CLAUDE });
	const styleAnalysisDB = createStyleAnalysisDB(applicationEnv.GOSTYLENS_DB);
	const subscriptionsDB = createSubscriptionsDB(applicationEnv.GOSTYLENS_DB);
	const userLimitsDB = createUserLimitsDB(applicationEnv.GOSTYLENS_DB);
	const realtimeService = createRealtimeService();
	const classificationService = createClassificationService(applicationEnv.GOSTYLENS_DB, applicationEnv);
	const voltmem = createVoltMemService(applicationEnv);

	return new StyleAnalysisService(
		llmService,
		styleAnalysisDB,
		subscriptionsDB,
		userLimitsDB,
		realtimeService,
		classificationService,
		applicationEnv,
		voltmem
	);
};
