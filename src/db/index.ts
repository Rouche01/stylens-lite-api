import { StyleAnalysisDB } from './style_analysis';

export function createStyleAnalysisDB(db: any): StyleAnalysisDB {
	return new StyleAnalysisDB(db);
}

export * from './types.js';
export { StyleAnalysisDB };
