import * as core from '@actions/core';
import * as github from '@actions/github';

type OctokitType = ReturnType<typeof github.getOctokit>;

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const CONFIG_FILE = 'tmp_handshake_config_file_123456.json';

export type ReceiverInfo = {
  receiver_name: string;
  timestamp: string;
};

export type Config = {
  public_key: string;
  destination: string;
  locked: boolean;
  usage_count: number;
  max_usage_count: number;
  created_at: string;
  created_by: string;
  run_id: number;
  run_url: string;
  receivers: ReceiverInfo[];
};

export type Payload = {
  branch_postfix: string;
};

export function randomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    const randomIndex = Math.floor(Math.random() * chars.length);
    result += chars[randomIndex];
  }
  return result;
}

export async function getConfig(branch: string, octokit: OctokitType): Promise<Config> {
  const { repo, owner } = github.context.repo;

  const refData = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${branch}`,
  });

  const commitSha = refData.data.object.sha;

  const commit = await octokit.rest.git.getCommit({
    owner,
    repo,
    commit_sha: commitSha,
  });

  const treeSha = commit.data.tree.sha;

  const tree = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: treeSha,
    recursive: 'true',
  });

  const handshakeFile = tree.data.tree.find((item) => item.path === CONFIG_FILE && item.type === 'blob');

  if (!handshakeFile || !handshakeFile.sha) {
    throw new Error(`Handshake file "${CONFIG_FILE}" not found in branch "${branch}"`);
  }

  const blob = await octokit.rest.git.getBlob({
    owner,
    repo,
    file_sha: handshakeFile.sha,
  });

  const content = Buffer.from(blob.data.content, 'base64').toString('utf-8');

  const parsed: Config = JSON.parse(content);

  return parsed;
}

export async function tryLockConfig(branch: string, octokit: OctokitType): Promise<boolean> {
  const { repo, owner } = github.context.repo;

  const fileResponse = await octokit.rest.repos.getContent({
    owner,
    repo,
    path: CONFIG_FILE,
    ref: branch,
  });

  if (Array.isArray(fileResponse.data) || fileResponse.data.type !== 'file' || !fileResponse.data.content) {
    throw new Error(`Config file "${CONFIG_FILE}" is invalid or not a file`);
  }

  const fileSha = fileResponse.data.sha;
  const content = Buffer.from(fileResponse.data.content, fileResponse.data.encoding as BufferEncoding).toString('utf-8');

  const parsed: Config = JSON.parse(content);

  if (parsed.locked) {
    core.info('🔒 Already locked');
    return false;
  }

  parsed.locked = true;
  const updatedContent = Buffer.from(JSON.stringify(parsed, null, 2)).toString('base64');

  try {
    await octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: CONFIG_FILE,
      branch,
      message: `🔒📝 Lock config`,
      content: updatedContent,
      sha: fileSha,
    });

    core.info(`✅🔒 config locked`);

  } catch (e: any) {
    if (e.status === 409 || e.status === 422) {
      core.info(`❌🔒 couldn't lock config`);
      return false;
    } else {
      throw e;
    }
  }

  return true;
}

export async function setConfig(branch: string, octokit: OctokitType, config: Config) {
  const { repo, owner } = github.context.repo;
  const updatedContent = Buffer.from(JSON.stringify(config, null, 2)).toString('base64');

  const maxTries = 10;
  let triesCount = 0;

  let fileSha: string | undefined;

  while (true) {
    try {
      const response = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: CONFIG_FILE,
        ref: branch,
      });

      if (!Array.isArray(response.data) && response.data.type === 'file') {
        fileSha = response.data.sha;
      }
    } catch (e: any) {
      if (e.status === 404) {
        core.info(`➕🔄📝 Creating config`);
      } else {
        throw e;
      }
    }

    try {
      await octokit.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: CONFIG_FILE,
        branch,
        message: `🔄📝 Update config`,
        content: updatedContent,
        sha: fileSha,
      });

      core.info(`✅${fileSha ? '🔄' : '➕'}📝 Config ${fileSha ? 'updated' : 'created'}`);

      break;

    } catch (e: any) {
      if (e.status === 409 && triesCount++ < maxTries) {
        core.info(`🔄 Sha expired, retrying...`);
        await sleep(1000);
        continue;
      }
      core.info(`❌📝 couldn't update config: ${e.message}`);
      throw e;
    }
  }
}

export async function checkIfConfigExists(branch: string, octokit: OctokitType): Promise<boolean> {
  const { repo, owner } = github.context.repo;

  try {
    const fileResponse = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: CONFIG_FILE,
      ref: branch,
    });
  } catch(err: any) {
    //file or branch doesn't exist
    if (err.status === 404) {
      return false;
    }

    throw err;
  }

  return true;
}