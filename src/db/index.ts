import { FavouritesDB } from './favourites';
import { StyleAnalysisDB } from './style_analysis';
import { SubscriptionsDB } from './subscriptions';
import { UsersDB } from './users';

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

export * from './types.js';
export { StyleAnalysisDB };
