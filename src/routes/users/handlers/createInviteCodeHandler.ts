import { error, RequestHandler } from 'itty-router';
import { createInviteCodesDB } from 'db';
import { AuthRequest } from 'types';
import { env } from 'cloudflare:workers';

type CreateInviteCodeBody = {
	code: string;
	trialDays?: number | null;
	trialSessionLimit?: number | null;
	monthlySessionLimit?: number | null;
	messagePerSessionLimit?: number | null;
	imagePerSessionLimit?: number | null;
	maxRedemptions?: number | null;
	expiresAt?: number | null;
};

const createInviteCodeHandler: RequestHandler<AuthRequest> = async (request) => {
	try {
		const body = (await request.json()) as CreateInviteCodeBody;

		if (!body.code || !body.code.trim()) {
			return error(400, 'code is required');
		}

		const inviteCodesDB = createInviteCodesDB(env.GOSTYLENS_DB);
		const created = await inviteCodesDB.createInviteCode({
			code: body.code,
			trialDays: body.trialDays,
			trialSessionLimit: body.trialSessionLimit,
			monthlySessionLimit: body.monthlySessionLimit,
			messagePerSessionLimit: body.messagePerSessionLimit,
			imagePerSessionLimit: body.imagePerSessionLimit,
			maxRedemptions: body.maxRedemptions,
			expiresAt: body.expiresAt,
		});

		return new Response(JSON.stringify(created), {
			headers: { 'Content-Type': 'application/json' },
			status: 201,
		});
	} catch (err) {
		if (err instanceof Error) {
			// Unique constraint violations surface as D1 errors
			if (err.message.includes('UNIQUE') || err.message.includes('unique')) {
				return error(409, 'Invite code already exists');
			}
			return error(400, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

export default createInviteCodeHandler;
