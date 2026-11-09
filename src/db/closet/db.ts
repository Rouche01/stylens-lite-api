import { ClosetDBBase } from './base';
import { WithClosetEvalReset } from './eval_reset';
import { WithClosetIdentityJobs } from './identity_jobs';
import { WithClosetItems } from './items';
import { WithClosetMatches } from './matches';
import { WithClosetVectors } from './vectors';

/** Closet D1 facade — public API unchanged from the former monolithic ClosetDB. */
export class ClosetDB extends WithClosetEvalReset(
	WithClosetMatches(WithClosetIdentityJobs(WithClosetVectors(WithClosetItems(ClosetDBBase))))
) {}
