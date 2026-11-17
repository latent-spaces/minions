/** The token from an `Authorization: Bearer <token>` header, if present. */
export const bearerToken = (authorization?: string): string | undefined => /^Bearer (\S+)$/i.exec(authorization ?? '')?.[1];
