interface ApprovalContinuitySnapshot {
  state: string;
  draft: boolean;
  headSha: string;
  reviewedHeadSha: string;
}

interface AutoApprovalSnapshot extends ApprovalContinuitySnapshot {
  mergeable: boolean | null;
}

type AutoApprovalSafetyDecision = { status: 'eligible' } | { status: 'blocked'; reason: string };

export type AutoApprovalDecision = AutoApprovalSafetyDecision | { status: 'already-approved' };

export function decideApprovalContinuity(
  snapshot: ApprovalContinuitySnapshot,
): AutoApprovalSafetyDecision {
  if (snapshot.state !== 'open') {
    return { status: 'blocked', reason: 'the pull request is not open' };
  }
  if (snapshot.draft) {
    return { status: 'blocked', reason: 'the pull request is still a draft' };
  }
  if (snapshot.headSha !== snapshot.reviewedHeadSha) {
    return { status: 'blocked', reason: 'the pull request head changed during review' };
  }
  return { status: 'eligible' };
}

export function decideAutoApproval(snapshot: AutoApprovalSnapshot): AutoApprovalSafetyDecision {
  const continuity = decideApprovalContinuity(snapshot);
  if (continuity.status === 'blocked') return continuity;

  if (snapshot.mergeable !== true) {
    return {
      status: 'blocked',
      reason:
        snapshot.mergeable === false
          ? 'GitHub reports the pull request is not mergeable'
          : 'GitHub has not determined mergeability yet',
    };
  }
  return { status: 'eligible' };
}

export function isDefinitiveApprovalRejection(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return status === 403 || status === 422;
}
