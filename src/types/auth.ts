export const AppRoles = {
    DefaultUser: 'defaultuser',
    RootAdmin: 'root-admin',
} as const;

export type AppRole = typeof AppRoles[keyof typeof AppRoles];

export type UserAuthMetadata = {
    role?: AppRole;
    dbId?: string;
    [key: string]: any;
};

export type DecodedJWT = {
    sub: string;
    email: string;
    role: AppRole;
    dbId: string;
    [key: string]: any;
}                           