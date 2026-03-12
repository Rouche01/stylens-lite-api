import { IRequest } from "itty-router";

export const AppRoles = {
    DefaultUser: 'defaultuser',
    RootAdmin: 'root-admin',
} as const;

export type AppRole = typeof AppRoles[keyof typeof AppRoles];

export type UserAuthMetadata = {
    role?: AppRole;
    dbId?: string;
    [key: string]: unknown;
};

export type DecodedJWT = {
    sub: string;
    email: string;
    app_metadata: UserAuthMetadata;
    [key: string]: unknown;
}

export type AuthUser = {
    authId: string;
    email: string;
    role?: AppRole;
    dbId?: string;
}

export type AuthRequest = IRequest & {
    user: AuthUser;
}

export type ProvisionedAuthUser = AuthUser & {
    dbId: string;
}

export type ProvisionedAuthRequest = IRequest & {
    user: ProvisionedAuthUser;
}