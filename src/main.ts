import * as core from '@actions/core';
import * as github from '@actions/github';
import * as utils from'./utils';

const BRANCH_PREFIX = 'tmp_zero_trust_handshake_branch_';
const MAX_LOCK_TRIES = 5;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type OctokitType = ReturnType<typeof github.getOctokit>;

import crypto from "crypto";
import jwt from "jsonwebtoken";

async function prepareForHandshake(octokit: OctokitType) {
  const max_usage_count = 1; //Number(core.getInput('max_usage_count'));
  const expiration_time = Number(core.getInput('expiration_time'));
  const destination = core.getInput('destination');
  const { repo, owner } = github.context.repo;

  let branch = "";
  let branch_postfix = "";

  if (destination === undefined || destination === null || destination.trim() === '') {
    throw new Error("❌ destination is empty, you have to set destination");
  }

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
      branch_postfix = utils.randomString(10);
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

    const payload: utils.Payload = {
      branch_postfix: branch_postfix,
    };
    
    let token = jwt.sign(payload, privateKey, {
      algorithm: "ES256",
      expiresIn: `${expiration_time}m`
    });

    //to make it possible to pass it through github job outputs
    token = Buffer.from(token).toString("base64");

    const config: utils.Config = {
      public_key: publicKey,
      destination: destination,
      locked: false,
      usage_count: 0,
      max_usage_count: max_usage_count,
      created_at: new Date().toISOString(),
      created_by: github.context.actor,
      run_id: github.context.runId,
      run_url: `https://github.com/${owner}/${repo}/actions/runs/${github.context.runId}`,
      receivers: [],
    };

    await utils.setConfig(branch, octokit, config);

    core.setOutput('token', token);

    core.info(`✅🤝 Prepared for handshake`);
  } catch (err: any) {
    await octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${branch}` });
    throw err;
  }
}

async function checkIfISentHandshake(octokit: OctokitType) {
  const token = core.getInput('token');
  const jwtoken = Buffer.from(token, "base64").toString("utf-8");
  const receiver = core.getInput('receiver');

  let branch = "";
  let branch_postfix = "";

  {
    try {
      const payload = jwt.decode(jwtoken) as utils.Payload;

      branch_postfix = payload.branch_postfix;
      branch = `${BRANCH_PREFIX}${branch_postfix}`;
    } catch (err) {
      core.info("❌🤝 Handshake failed, something wrong with token payload");
      throw err;
    }
  }

  {
    const exist = await utils.checkIfConfigExists(branch, octokit);
    
    if (!exist) {
      core.setOutput('check_status', false);
      core.setFailed("❌🤝 Handshake failed, there is no prepared config");
      return;
    }
  }

  {
    let locked = false;
    
    for (let index = 0; index < MAX_LOCK_TRIES; index++) {
      core.info("🙏 try lock config");

      if (await utils.tryLockConfig(branch, octokit)) {
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
    let config: utils.Config = await utils.getConfig(branch, octokit);

    let check_status: boolean = false;

    if (config.destination !== receiver) {
      core.info("❌ Receiver doesn't correspond to destination");
    } else if (config.usage_count >= config.max_usage_count) {
      core.info("❌ Maximum number of uses reached");
    } else {
      try {
        /* const payload =  */jwt.verify(jwtoken, config.public_key, { algorithms: ["ES256"] });
        
        core.info("✅ Token verified");

        config.usage_count += 1;

        const receiverInfo: utils.ReceiverInfo = {
          receiver_name: receiver,
          timestamp: new Date().toISOString(),
        };

        config.receivers.push(receiverInfo);

        check_status = true;

      } catch (error: any) {
        if (error.name === 'TokenExpiredError') {
          core.error("📛 Token expired");
        } else if (error.name === 'JsonWebTokenError') {
          core.error("📛📝 Token signature error");
        } else if (error.name === 'NotBeforeError') {
          core.error("📛 NotBeforeError: Token is not active yet (nbf)");
        } else {
          core.error(`❌ Token verification failed: ${error.message}`);
          throw error;
        }
      }
    }

    config.locked = false;
    await utils.setConfig(branch, octokit, config);

    core.setOutput('check_status', check_status);

    if (check_status) {
      core.info("✅🤝 Handshake is completed");
    }
    else
    {
      core.setFailed("❌🤝 Handshake failed");
    }
    
  } catch (err: any) {
    try {
      let config = await utils.getConfig(branch, octokit);
      config.locked = false;
      await utils.setConfig(branch, octokit, config);
    } catch (e: any) {
      core.info("❌🔓 couldn't make emergency unlock");
      core.error(e);
    }

    throw err;
  }
}

async function cleanup(octokit: OctokitType) {
  const token = core.getInput('token');
  const jwtoken = Buffer.from(token, "base64").toString("utf-8");
  const { repo, owner } = github.context.repo;

  let branch = "";
  let branch_postfix = "";

  {
    try {
      const payload = jwt.decode(jwtoken) as utils.Payload;

      branch_postfix = payload.branch_postfix;
      branch = `${BRANCH_PREFIX}${branch_postfix}`;
    } catch (err) {
      core.info("❌🤝 something wrong with token payload");
      throw err;
    }
  }

  try {
    const config = await utils.getConfig(branch, octokit);
    core.info(`Receivers were: \n${JSON.stringify(config.receivers, null, 2)}`);
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

async function run() {
  const token = core.getInput('github_token', { required: true });
  const mode = core.getInput('mode') || 'create';

  const octokit = github.getOctokit(token);

  if (mode === 'create') {
    await prepareForHandshake(octokit);
  } else if (mode === 'check') {
    await checkIfISentHandshake(octokit);
  } else if (mode === 'cleanup') {
    await cleanup(octokit);
  } else {
    core.setFailed("❌ Unknown mode");
  }
}

run().catch((err) => core.setFailed(err.stack ? `${err.message}\n${err.stack}` : err.message));