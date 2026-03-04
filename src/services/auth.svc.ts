import { createRemoteJWKSet, jwtVerify } from "jose";
import { env } from 'cloudflare:workers';
import { UserAuthMetadata } from 'types';

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export class AuthService {
    public issuer: string;
    public JWKS: ReturnType<typeof createRemoteJWKSet>;

    constructor(
        private svcRoleKey: string,
        private svcAnonKey: string,
        private svcUrl: string,
    ) {
        this.issuer = `${this.svcUrl}/auth/v1`;

        if (!jwksCache.has(this.svcUrl)) {
            jwksCache.set(
                this.svcUrl,
                createRemoteJWKSet(new URL(`${this.svcUrl}/auth/v1/.well-known/jwks.json`))
            );
        }
        this.JWKS = jwksCache.get(this.svcUrl)!;
    }

    async verifyJWT(token: string) {
        const { payload } = await jwtVerify(token, this.JWKS, {
            issuer: this.issuer,
            audience: 'authenticated'
        });
        return payload;
    }

    async updateUserAuthMetadata(userId: string, appMetadata: UserAuthMetadata) {
        console.log(this.svcRoleKey, this.svcAnonKey, this.svcUrl);
        const res = await fetch(`${this.svcUrl}/auth/v1/admin/users/${userId}`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${this.svcRoleKey}`,
                'apikey': this.svcRoleKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                app_metadata: appMetadata
            })
        });

        if (!res.ok) {
            const errorText = await res.text();
            throw new Error(`Failed to update user app_metadata: ${res.status} ${errorText}`);
        }

        return res.json();
    }
}

export const createAuthService = () => {
    return new AuthService(env.SUPABASE_ROLE_KEY, env.SUPABASE_ANON_KEY, env.SUPABASE_URL);
};