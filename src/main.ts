import * as core from '@actions/core';
import * as github from '@actions/github';
import * as common from'./common';

const BRANCH_PREFIX = 'tmp_zero_trust_handshake_branch_';
const MAX_LOCK_TRIES = 5;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type OctokitType = ReturnType<typeof github.getOctokit>;

import crypto from "crypto";
import jwt from "jsonwebtoken";

async function prepareForHandshake(octokit: OctokitType) {
  const max_usage_count = Number(core.getInput('max_usage_count'));
  const expiration_time = Number(core.getInput('expiration_time'));
  const { repo, owner } = github.context.repo;

  let branch = "";
  let branch_postfix = "";

  {
    const { data: repoData } = await octokit.rest.repos.get({
      owner,
      repo,
    });
    
    const defaultBranch = repoData.default_branch;

    const { data: refData } = await octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${defaultBranch}`,
    });
    
    const latestCommitSha = refData.object.sha;

    while(true)
    {
      branch_postfix = common.randomString(10);
      branch = `${BRANCH_PREFIX}${branch_postfix}`;
  
      try {
        await octokit.rest.git.createRef({
          owner,
          repo,
          ref: `refs/heads/${branch}`,
          sha: latestCommitSha,
        });
  
        break;
      } catch (error: any) {
        if (error.status === 422 && error.message.includes('Reference already exists')) {
          continue;
        } else {
          throw error;
        }
      }
    }
  }

  try {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
      namedCurve: "P-256",
      publicKeyEncoding: {
        type: "spki",
        format: "pem"
      },
      privateKeyEncoding: {
        type: "pkcs8",
        format: "pem"
      }
    });

    const payload: common.Payload = {
      branch_postfix: branch_postfix
    };
    
    const token = jwt.sign(payload, privateKey, {
      algorithm: "ES256",
      expiresIn: `${expiration_time}m`
    });

    const config: common.Config = {
      public_key: publicKey,
      locked: false,
      usage_count: 0,
      max_usage_count: max_usage_count,
      created_at: new Date().toISOString(),
      created_by: github.context.actor,
      run_id: github.context.runId,
      run_url: `https://github.com/${owner}/${repo}/actions/runs/${github.context.runId}`,
      receivers: [],
    };

    await common.setConfig(branch, octokit, config);

    core.setOutput('token', token);
    core.saveState('branch', branch);

    core.info(`✅🤝 Prepared for handshake`);
  } catch (err: any) {
    await octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${branch}` });
    throw err;
  }
}

async function checkIfISentHandshake(octokit: OctokitType) {
  const jwtoken = core.getInput('jwt');
  const handshake_receiver = core.getInput('handshake_receiver');
  const { repo, owner } = github.context.repo;

  let branch = "";
  let branch_postfix = "";

  {
    try {
      const payload = jwt.decode(jwtoken) as common.Payload;

      branch_postfix = payload.branch_postfix;
      branch = `${BRANCH_PREFIX}${branch_postfix}`;
    } catch (err) {
      core.info("❌🤝 something wrong with payload");
      throw err;
    }
  }

  {
    let locked = false;
    
    for (let index = 0; index < MAX_LOCK_TRIES; index++) {
      core.info("🙏 try lock config");

      if (await common.tryLockConfig(branch, octokit)) {
        locked = true;
        break;
      }

      if (index < (MAX_LOCK_TRIES - 1)) {
        await sleep(3000);
      }
    }

    if (!locked) {
      throw new Error("❌🔒 couldn't lock config");
    }
  }

  try {
    let config: common.Config = await common.getConfig(branch, octokit);

    let check_status: boolean = false;

    if (config.usage_count < config.max_usage_count) {
      try {
        /* const payload =  */jwt.verify(jwtoken, config.public_key, { algorithms: ["ES256"] });
        
        core.info("✅ Token verified");

        config.usage_count += 1;

        const receiverInfo: common.ReceiverInfo = {
          receiver_name: handshake_receiver,
          timestamp: new Date().toISOString(),
        };

        config.receivers.push(receiverInfo);

        check_status = true;

      } catch (error: any) {
        core.error(`❌ Token verification failed: ${error.message}`);
      
        if (error.name === 'TokenExpiredError') {
          core.error("📛 Token expired");
        } else if (error.name === 'JsonWebTokenError') {
          core.error("📛📝 Token sign error");
        } else if (error.name === 'NotBeforeError') {
          core.error("📛 NotBeforeError: Token is not active yet (nbf)");
        } else {
          throw error;
        }
      }
    }
    else {
      core.info("❌🤝 Maximum number of uses reached");
    }

    config.locked = false;
    await common.setConfig(branch, octokit, config);

    core.setOutput('check_status', check_status);

    if (check_status) {
      core.info("✅🤝 Handshake is completed");
    }
    else
    {
      core.info("❌🤝 Handshake failed");
    }
    
  } catch (err: any) {
    try {
      let config = await common.getConfig(branch, octokit);
      config.locked = false;
      await common.setConfig(branch, octokit, config);
    } catch (e: any) {
      core.info("❌🔓 couldn't make emergency unlock");
      core.error(e);
    }

    throw err;
  }
}

async function run() {
  const token = core.getInput('github_token', { required: true });
  const mode = core.getInput('mode') || 'create';

  const octokit = github.getOctokit(token);

  if (mode === 'create') {
    await prepareForHandshake(octokit);
  } else if (mode === 'check') {
    await checkIfISentHandshake(octokit);
  } else {
    core.setFailed("❌ Unknown mode");
  }
}

run().catch((err) => core.setFailed(err.stack ? `${err.message}\n${err.stack}` : err.message));