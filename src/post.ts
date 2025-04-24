import { config } from 'process';
import * as core from '@actions/core';
import * as github from '@actions/github';
import * as common from'./common';

async function run() {
  const token = core.getInput('github_token', { required: true });
  const mode = core.getInput('mode') || 'create';

  if (mode !== 'create') {
    core.info(`Mode was not 'create' so there is no Post action`);
    return;
  }

  const branch = core.getState('branch');

  if (!branch) {
    core.setFailed(`There was no 'brunch' state transferred from 'main' action step`);
    return;
  }

  const octokit = github.getOctokit(token);
  const { repo, owner } = github.context.repo;

  try {
    const config = await common.getConfig(branch, octokit);
    core.info("Got config");
    core.info(JSON.stringify(config, null, 2));
    core.info(`Receivers are: [${config.receivers.toString()}]`);
  } catch (err: any) {
    core.error("❌ Cant get receivers from config");
    core.error(err);
  }

  core.info(`♻️ Cleaning handshake data...`);
  try {
    await octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${branch}` });
    core.info(`✅♻️🤝 Handshake data cleaned`);
  } catch (err: any) {
    if (err.status === 422) {
      const message = `❌♻️🤝 Handshake data was already cleaned or not found.`;
      core.setFailed(message);
    } else {
      throw err;
    }
  }
}

run().catch((err) => core.setFailed(err.stack ? `${err.message}\n${err.stack}` : err.message));
