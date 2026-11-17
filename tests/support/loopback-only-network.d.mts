export function isLoopbackHost(host: string | null | undefined): boolean;
export function installLoopbackOnlyNetwork(): { refused: string[]; uninstall(): void };
