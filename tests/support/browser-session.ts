// Browser acceptance signs in with an engine session token (idTokenFor in apps/server/test/helpers.ts), stored where
// the viewer keeps the session the engine's GitHub sign-in returns (apps/web/src/server-session.ts).
export async function signInBrowser(page: { evaluate(source: string): Promise<unknown>; reload(): Promise<unknown> }, token: string) {
  await page.evaluate(`localStorage.setItem('mlswarm.session', ${JSON.stringify(token)})`);
  await page.reload();
}
