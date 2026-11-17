import { error, RequestHandler } from 'itty-router';
import { createInviteCodesDB } from 'db';
import { AuthRequest } from 'types';
import { env } from 'cloudflare:workers';

const listInviteCodesHandler: RequestHandler<AuthRequest> = async () => {
	try {
		const inviteCodesDB = createInviteCodesDB(env.GOSTYLENS_DB);
		const codes = await inviteCodesDB.listInviteCodes();

		return new Response(JSON.stringify(codes), {
			headers: { 'Content-Type': 'application/json' },
		});
	} catch (err) {
		if (err instanceof Error) {
			return error(400, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

export default listInviteCodesHandler;
