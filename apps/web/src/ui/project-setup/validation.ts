import { repositoryUrl } from '../../proposal-form';
import { setupStep, type ProjectSetupDraft, type ProjectSetupMode } from './types';

/** Creation uses one-person recruitment; changing recruitment belongs in Settings. */
export function validateSetupStep(step: number, mode: ProjectSetupMode, draft: ProjectSetupDraft, maximumContributors?: number | null): string | null {
  if (step === setupStep.Visibility) return null;
  if (!draft.name.trim()) return 'Enter a project name.';
  if (draft.name.trim().length > 120) return 'Use a project name of 120 characters or fewer.';
  if (!draft.purpose.trim()) return 'Describe the project.';
  if (draft.purpose.trim().length > 1500) return 'Use a description of 1,500 characters or fewer.';
  if (mode === 'public' && maximumContributors != null && maximumContributors < 1) return 'Public projects are not accepting new proposals right now.';
  if (step !== setupStep.Repository) return null;
  const repository = draft.repository.trim();
  if (repository.length > 300 || !repositoryUrl(repository)) return 'Enter a GitHub repository, such as github.com/owner/repository.';
  return null;
}

/** A named idea can be saved before its purpose or repository is complete. */
export function validatePublicDraft(draft: ProjectSetupDraft): string | null {
  if (!draft.name.trim() || draft.name.trim().length > 120) return 'Enter a project name of 120 characters or fewer.';
  if (draft.purpose.trim().length > 1500) return 'Use a description of 1,500 characters or fewer.';
  if (draft.repository.trim() && (draft.repository.trim().length > 300 || !repositoryUrl(draft.repository))) return 'Enter a valid GitHub repository, or leave it empty for now.';
  return null;
}
