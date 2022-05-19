/* eslint-disable import/no-extraneous-dependencies */
import * as crypto from 'crypto';
import * as AWS from 'aws-sdk';

const sf = new AWS.StepFunctions();
const sm = new AWS.SecretsManager();

// TODO use @octokit/webhooks?

function verifyBody(event: any, secret: any) {
  const sig = Buffer.from(event.headers['x-hub-signature-256'] || '', 'utf8');

  let body = event.body;
  if (event.isBase64Encoded) {
    body = Buffer.from(body, 'base64');
  } else {
    body = Buffer.from(body || '', 'utf8');
  }

  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(body);
  const expectedSig = Buffer.from(`sha256=${hmac.digest('hex')}`, 'utf8');

  console.log('Calculated signature: ', expectedSig.toString());

  if (sig.length !== expectedSig.length || !crypto.timingSafeEqual(sig, expectedSig)) {
    throw new Error(`Signature mismatch. Expected ${expectedSig.toString()} but got ${sig.toString()}`);
  }

  return body;
}

exports.handler = async function (event: any) {
  if (!process.env.WEBHOOK_SECRET_ARN || !process.env.STEP_FUNCTION_ARN) {
    throw new Error('Missing environment variables');
  }

  const secret = await sm.getSecretValue({
    SecretId: process.env.WEBHOOK_SECRET_ARN,
  }).promise();

  if (!secret.SecretString) {
    throw new Error(`No SecretString in ${process.env.WEBHOOK_SECRET_ARN}`);
  }

  const webhookSecret = JSON.parse(secret.SecretString).webhookSecret;

  let body;
  try {
    body = verifyBody(event, webhookSecret);
  } catch (e) {
    console.error(e);
    return {
      statusCode: 403,
      body: 'Bad signature',
    };
  }

  if (event.headers['content-type'] !== 'application/json') {
    console.error(`This webhook only accepts JSON payloads, got ${event.headers['content-type']}`);
    return {
      statusCode: 400,
      body: 'Expecting JSON payload',
    };
  }

  if (event.headers['x-github-event'] === 'ping') {
    return {
      statusCode: 200,
      body: 'Pong',
    };
  }

  // if (event.headers['x-github-event'] !== 'workflow_job' && event.headers['x-github-event'] !== 'workflow_run') {
  //     console.error(`This webhook only accepts workflow_job and workflow_run, got ${event.headers['x-github-event']}`);
  if (event.headers['x-github-event'] !== 'workflow_job') {
    console.error(`This webhook only accepts workflow_job, got ${event.headers['x-github-event']}`);
    return {
      statusCode: 400,
      body: 'Expecting workflow_job',
    };
  }

  const payload = JSON.parse(body);

  if (payload.action !== 'queued') {
    console.log(`Ignoring action "${payload.action}", expecting "queued"`);
    return {
      statusCode: 200,
      body: 'OK. No runner started.',
    };
  }

  // it's easier to deal with maps in step functions
  let labels: any = {};
  payload.workflow_job.labels.forEach((l: string) => labels[l] = true);

  // start execution
  let executionName = `${payload.repository.full_name.replace('/', '-')}-${event.headers['x-github-delivery']}`;
  const execution = await sf.startExecution({
    stateMachineArn: process.env.STEP_FUNCTION_ARN,
    input: JSON.stringify({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      runId: payload.workflow_job.run_id,
      labels: labels,
    }),
    // name is not random so multiple execution of this webhook won't cause multiple builders to start
    name: executionName,
  }).promise();

  console.log(`Started ${execution.executionArn}`);

  return {
    statusCode: 202,
    body: executionName,
  };
};
