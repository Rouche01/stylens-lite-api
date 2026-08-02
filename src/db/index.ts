import { FavouritesDB } from './favourites';
import { StyleAnalysisDB } from './style_analysis';
import { SubscriptionsDB } from './subscriptions';
import { UsersDB } from './users';
import { UserLimitsDB } from './user_limits';
import { ClosetDB } from './closet';
import { PushTokensDB } from './push_tokens';
import { StylistOpenersDB } from './stylist_openers';

export const createStyleAnalysisDB = (db: D1Database): StyleAnalysisDB => {
	return new StyleAnalysisDB(db);
};

export const createUsersDB = (db: D1Database) => {
	return new UsersDB(db);
};

export const createFavouritesDB = (db: D1Database) => {
	return new FavouritesDB(db);
};

export const createSubscriptionsDB = (db: D1Database) => {
	return new SubscriptionsDB(db);
};

export const createUserLimitsDB = (db: D1Database) => {
	return new UserLimitsDB(db);
};

export const createClosetDB = (db: D1Database) => {
	return new ClosetDB(db);
};

export const createPushTokensDB = (db: D1Database) => {
	return new PushTokensDB(db);
};

export const createStylistOpenersDB = (db: D1Database) => {
	return new StylistOpenersDB(db);
};

export * from './types.js';
export { StyleAnalysisDB, ClosetDB, PushTokensDB, StylistOpenersDB };
