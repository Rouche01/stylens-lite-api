import { StyleAnalysisDB } from './style_analysis';
import { UsersDB } from './users';

export const createStyleAnalysisDB = (db: D1Database): StyleAnalysisDB => {
	return new StyleAnalysisDB(db);
};

export const createUsersDB = (db: D1Database) => {
	return new UsersDB(db);
};

export * from './types.js';
export { StyleAnalysisDB };
