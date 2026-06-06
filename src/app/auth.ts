import { createAppAuth } from "@octokit/auth-app";
import { Octokit as CoreOctokit } from "@octokit/core";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { restEndpointMethods } from "@octokit/plugin-rest-endpoint-methods";

import type { Octokit } from "../shared/github.ts";

const AppOctokit = CoreOctokit.plugin(paginateRest, restEndpointMethods);

export function createAppOctokit(
  appId: string,
  privateKey: string,
  installationId: number,
): Octokit {
  return new AppOctokit({
    authStrategy: createAppAuth,
    auth: { appId, privateKey, installationId },
  }) as Octokit;
}
