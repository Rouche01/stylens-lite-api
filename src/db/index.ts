import { StyleAnalysisDB } from './style_analysis';

export function createStyleAnalysisDB(db: D1Database): StyleAnalysisDB {
	return new StyleAnalysisDB(db);
}

export * from './types.js';
export { StyleAnalysisDB };
