export class ClosetMatchNotFoundError extends Error {
	constructor(matchId: string) {
		super(`Closet match ${matchId} was not found`);
		this.name = 'ClosetMatchNotFoundError';
	}
}

export class ClosetMatchResolvedError extends Error {
	constructor(matchId: string, status: string) {
		super(`Closet match ${matchId} is already ${status}`);
		this.name = 'ClosetMatchResolvedError';
	}
}

export class IdentityBusyError extends Error {
	constructor(userId: string) {
		super(`Identity already in progress for user ${userId}`);
		this.name = 'IdentityBusyError';
	}
}
