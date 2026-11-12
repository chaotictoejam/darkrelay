#!/usr/bin/env node
/**
 * Runs the CDK CLI in packages/infra with a container engine this machine
 * actually has.
 *
 * `cdk deploy` builds the transcoder image by shelling out to `docker`, and
 * there is no CDK config file for that: the only control is the CDK_DOCKER
 * environment variable. Fedora, RHEL and friends ship Podman and no docker
 * binary, so the default fails for them.
 *
 * An explicit CDK_DOCKER always wins. Otherwise docker is preferred and
 * podman used when there is no docker, which keeps CI and Docker machines on
 * exactly what they had before.
 */
import { spawnSync } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function containerEngine() {
  if (process.env['CDK_DOCKER']) return process.env['CDK_DOCKER'];
  for (const candidate of ['docker', 'podman']) {
    const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore', shell: false });
    if (!probe.error && probe.status === 0) return candidate;
  }
  // Neither is installed. Leave the default so CDK reports it in its own words.
  return 'docker';
}

const engine = containerEngine();
if (engine !== 'docker') console.error(`Using ${engine} to build images (CDK_DOCKER=${engine}).`);

const cdk = spawnSync(
  npm,
  ['exec', '-w', '@darkrelay/infra', '--', 'cdk', ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: { ...process.env, CDK_DOCKER: engine },
  },
);
if (cdk.error) {
  console.error(String(cdk.error));
  process.exit(1);
}
process.exit(cdk.status ?? 1);
