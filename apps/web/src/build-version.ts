declare const __MLSWARM_BUILD__: string;
/** This bundle's build id; version.json beside the page names the newest one. */
export const BUILD = __MLSWARM_BUILD__;

/** True when the served version.json names a different build than the one this tab runs. A failed read says nothing. */
export async function newerBuildServed(current: string, load: () => Promise<Response> = () => fetch('/version.json', { cache: 'no-store' })): Promise<boolean> {
  try {
    const response = await load();
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return typeof body === 'object' && body !== null && typeof (body as { build?: unknown }).build === 'string' && (body as { build: string }).build !== current;
  } catch { return false; }
}
