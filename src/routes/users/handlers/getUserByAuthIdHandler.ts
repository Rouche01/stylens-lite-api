import { env } from 'cloudflare:workers';
import { createUsersDB } from 'db';
import { error, RequestHandler } from 'itty-router';

const getUserByAuthIdHandler: RequestHandler = async (request) => {
    try {
        const { authId } = request.params;
        if (!authId) {
            return error(400, 'authId query parameter is required');
        }

        const usersDB = createUsersDB(env.gostylens_db);

        const user = await usersDB.getUserByAuthId(authId);
        if (!user) {
            return error(404, 'User not found');
        }

        return new Response(JSON.stringify(user), {
            headers: { 'Content-Type': 'application/json' },
            status: 200,
        });
    } catch (err) {
        if (err instanceof Error) {
            return error(400, err.message);
        }
        return error(500, 'Internal Server Error');
    }
};

export default getUserByAuthIdHandler;
