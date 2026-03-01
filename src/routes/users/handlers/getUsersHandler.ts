import { env } from 'cloudflare:workers';
import { createUsersDB } from 'db';
import { error, RequestHandler } from 'itty-router';

const getUsersHandler: RequestHandler = async () => {
    try {
        const usersDB = createUsersDB(env.gostylens_db);

        const users = await usersDB.getUsers();

        return new Response(JSON.stringify(users), {
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

export default getUsersHandler;
