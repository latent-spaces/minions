import type { RepositoryReadiness } from '@mlswarm/contracts';
const messages:Record<string,string>={
  git_missing:'Git is missing on this computer. Open your coding chat to finish setup.',
  git_authentication_failed:'This computer could not sign in to the repository through Git. Open your coding chat to check Git authentication.',
  repository_access_denied:'Git was denied access to this repository. Check the signed-in GitHub account and repository permissions in your coding chat.',
  dns_failed:'This computer could not find GitHub on the network. Check its network or proxy connection.',
  tls_failed:'This computer could not establish a trusted connection to GitHub. Check its certificate or proxy setup in your coding chat.',
  network_timeout:'The repository connection timed out. Check this computer’s network; MyLittleSwarm will retry.',
  invalid_repository:'The project repository address is invalid. Ask the owner to check it.',
};
export function repositoryWaitMessage(repository?:RepositoryReadiness|null){
  return repository ? `Last repository check: ${messages[repository.code]??'This computer could not reach the repository. Open your coding chat to inspect the diagnostics.'}`
    : 'Waiting for this computer to reach the project’s GitHub repository. Open your coding chat to inspect the diagnostics.';
}
