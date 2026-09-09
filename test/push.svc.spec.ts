import { describe, expect, it } from 'vitest';
import { isStaleFcmToken } from '../src/services/push.svc';

describe('isStaleFcmToken', () => {
	it('treats UNREGISTERED FCM error code as stale', () => {
		expect(
			isStaleFcmToken({
				error: {
					status: 'NOT_FOUND',
					code: 404,
					message: 'Requested entity was not found.',
					details: [
						{
							'@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
							errorCode: 'UNREGISTERED',
						},
					],
				},
			})
		).toBe(true);
	});

	it('treats legacy not-found shapes as stale', () => {
		expect(
			isStaleFcmToken({
				error: {
					status: 'NOT_FOUND',
					code: 404,
					message: 'Requested entity was not found.',
				},
			})
		).toBe(true);

		expect(
			isStaleFcmToken({
				error: {
					message: 'registration token is not registered',
				},
			})
		).toBe(true);
	});

	it('does not treat other FCM failures as stale', () => {
		expect(
			isStaleFcmToken({
				error: {
					status: 'INVALID_ARGUMENT',
					code: 400,
					message: 'The registration token is not a valid FCM registration token',
					details: [
						{
							'@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
							errorCode: 'INVALID_ARGUMENT',
						},
					],
				},
			})
		).toBe(false);
	});
});
